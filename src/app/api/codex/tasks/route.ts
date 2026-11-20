import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isEmergencyStopActive } from "@/lib/agent-dispatch";
import { dependenciesAreDone } from "@/lib/phase2-domain.mjs";
import { requestActor } from "@/lib/human-auth";
import { CODEX_POLICY_STORE_KEY, codexAssignmentAllowed, codexParentAttemptAllowed, codexParentRequestId, normalizeCodexPolicy } from "@/lib/codex-policy.mjs";
import { getCodexQuotaUsage } from "@/lib/codex-quota";
import { codexTaskFingerprint } from "@/lib/codex-policy.mjs";
import { codexTaskPolicy } from "../../../../../hermes-bridge/codex-task-contract.mjs";
import { codexManualOverrideKey, isCodexManualOverride } from "@/lib/codex-manual-override.mjs";

const CODEX_KINDS = ["codex.audit", "codex.change"];
const TASK_STATUSES = new Set([
  "queued",
  "awaiting_approval",
  "awaiting_destructive_confirmation",
  "approved",
  "running",
  "done",
  "failed",
  "rejected",
]);

export const dynamic = "force-dynamic";

// GET /api/codex/tasks?status=queued,approved&take=1
export async function GET(req: Request) {
  const auth = await requestActor(req, "internal:codex-worker");
  if (auth.response) return auth.response;
  if (auth.actor !== "internal:codex-worker") return NextResponse.json({ error: "Endpoint reservado al worker Codex" }, { status: 403 });
  const url = new URL(req.url);
  const requestedStatus = url.searchParams.get("status");
  const statuses = requestedStatus && requestedStatus !== "all"
    ? requestedStatus.split(",").filter((status) => TASK_STATUSES.has(status))
    : [];
  const take = Math.min(Math.max(Number(url.searchParams.get("take") || 50), 1), 100);
  const [emergency, circuitRow, policyRow, quota] = await Promise.all([
    isEmergencyStopActive(),
    prisma.dataStore.findUnique({ where: { key: "codex-circuit" } }),
    prisma.dataStore.findUnique({ where: { key: CODEX_POLICY_STORE_KEY } }),
    getCodexQuotaUsage(prisma),
  ]);
  const policy = normalizeCodexPolicy(policyRow?.data);
  const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string; reason?: string } | undefined;
  const candidates = emergency ? [] : await prisma.agentRequest.findMany({
    where: {
      kind: { in: CODEX_KINDS },
      OR: [
        { origin: "max", prompt: { contains: "delegación exclusiva de Max" } },
        { origin: "web", prompt: { contains: "[[CODEX_INTENT_V1:" } },
      ],
      ...(statuses.length ? { status: { in: statuses } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(take * 3, 300),
  });
  const parentIds = [...new Set(candidates.map((task) => codexParentRequestId(task)).filter((id): id is string => Boolean(id)))];
  const parentChildren = parentIds.length ? await prisma.agentRequest.findMany({
    where: { origin: "max", kind: { in: CODEX_KINDS }, OR: parentIds.map((parentId) => ({ prompt: { contains: `[[CODEX_PARENT_V1:${parentId}]]` } })) },
    select: { id: true, origin: true, prompt: true, createdAt: true },
  }) : [];
  const parentChildrenById = new Map<string, typeof parentChildren>();
  for (const child of parentChildren) {
    const parentId = codexParentRequestId(child);
    if (parentId) parentChildrenById.set(parentId, [...(parentChildrenById.get(parentId) || []), child]);
  }
  const overrideKeys = candidates.map((task) => codexManualOverrideKey(task.id));
  const overrideRows = overrideKeys.length ? await prisma.dataStore.findMany({ where: { key: { in: overrideKeys } } }) : [];
  const overrideMap = new Map(overrideRows.map((row) => [row.key, row.data]));
  const dependencyIds = [...new Set(candidates.flatMap((task) => Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []))];
  const dependencyRows = dependencyIds.length ? await prisma.agentRequest.findMany({ where: { id: { in: dependencyIds } }, select: { id: true, status: true } }) : [];
  const dependencyMap = new Map(dependencyRows.map((row) => [row.id, row]));
  const seenFingerprints = new Set<string>();
  const tasks = candidates
    .map((task) => ({ task, manualOverrideAuthorized: isCodexManualOverride(overrideMap.get(codexManualOverrideKey(task.id)), task) }))
    .filter(({ task, manualOverrideAuthorized }) => {
      if (task.origin === "web") return manualOverrideAuthorized && codexTaskPolicy(task, task.status, true).eligible;
      return task.origin === "max" && (!quota.blocked || manualOverrideAuthorized)
        && codexTaskPolicy(task, task.status, manualOverrideAuthorized).eligible
        && (manualOverrideAuthorized || codexAssignmentAllowed(task.prompt, policy, task.status, task));
    })
    .filter(({ task }) => dependenciesAreDone(Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [], dependencyMap))
    .filter(({ task }) => codexParentAttemptAllowed(task, parentChildrenById.get(codexParentRequestId(task) || "") || []))
    .filter(({ task }) => { const fingerprint = codexTaskFingerprint(task); if (seenFingerprints.has(fingerprint)) return false; seenFingerprints.add(fingerprint); return true; })
    .slice(0, take)
    .map(({ task, manualOverrideAuthorized }) => manualOverrideAuthorized ? { ...task, manualOverrideAuthorized: true } : task);
  return NextResponse.json({ tasks, circuit: circuit || { open: false }, emergency, processor: "codex", policy, quota, localTimeQuotaEnabled: false });
}

export async function POST(req: Request) {
  const auth = await requestActor(req, "internal:codex-worker");
  if (auth.response) return auth.response;
  if (auth.actor !== "internal:codex-worker") return NextResponse.json({ error: "Endpoint reservado al worker Codex" }, { status: 403 });
  return NextResponse.json(
    { error: "La creación directa está deshabilitada; Max debe justificar y delegar las tareas de Codex" },
    { status: 403 },
  );
}
