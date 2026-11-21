import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { CODEX_POLICY_STORE_KEY, normalizeCodexPolicy } from "@/lib/codex-policy.mjs";
import { getCodexQuotaUsage } from "@/lib/codex-quota";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const row = await prisma.dataStore.upsert({
    where: { key: CODEX_POLICY_STORE_KEY },
    update: {},
    create: { key: CODEX_POLICY_STORE_KEY, data: { minimumPriority: "important", requireApprovalForSideEffects: true, updatedAt: new Date().toISOString() } },
  });
  const [waitingApproval, readyTasks, circuitRow, quota] = await Promise.all([
    prisma.agentRequest.count({ where: { kind: { in: ["codex.audit", "codex.change"] }, origin: "max", status: "awaiting_approval" } }),
    prisma.agentRequest.count({ where: { kind: { in: ["codex.audit", "codex.change"] }, origin: "max", status: { in: ["queued", "approved"] } } }),
    prisma.dataStore.findUnique({ where: { key: "codex-circuit" } }),
    getCodexQuotaUsage(prisma),
  ]);
  return NextResponse.json({
    policy: normalizeCodexPolicy(row?.data),
    updatedAt: (row.data as Record<string, unknown> | null)?.updatedAt || null,
    waitingApproval,
    readyTasks,
    circuit: circuitRow?.data || { open: false },
    quota,
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  if (body.action === "resumeCodex") {
    const currentRow = await prisma.dataStore.findUnique({ where: { key: "codex-circuit" } });
    const current = currentRow?.data as { open?: boolean; reason?: string } | undefined;
    if (!current?.open) return NextResponse.json({ error: "El circuito de Codex ya está cerrado." }, { status: 409 });
    const resumedAt = new Date().toISOString();
    const circuit = {
      open: false,
      activeAgent: "codex",
      reason: null,
      manuallyResumedAt: resumedAt,
      manuallyResumedBy: auth.actor,
      previousReason: current.reason || null,
    };
    await prisma.dataStore.upsert({
      where: { key: "codex-circuit" },
      update: { data: circuit },
      create: { key: "codex-circuit", data: circuit },
    });
    await prisma.agentEvent.create({ data: {
      kind: "status",
      title: "Codex habilitado manualmente",
      detail: "Circuito cerrado por una persona autorizada. No se ejecutó una prueba ni una tarea.",
      agent: "codex",
      level: "info",
      meta: { actor: auth.actor, manuallyResumedAt: resumedAt },
    } });
    return NextResponse.json({ ok: true, circuit });
  }

  const minimumPriority = String(body.minimumPriority || "");
  if (!["important", "critical", "paused"].includes(minimumPriority)) {
    return NextResponse.json({ error: "El nivel mínimo debe ser important, critical o paused" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const policy = normalizeCodexPolicy({ minimumPriority });
  await prisma.dataStore.upsert({
    where: { key: CODEX_POLICY_STORE_KEY },
    update: { data: { ...policy, updatedAt: now, updatedBy: auth.actor } },
    create: { key: CODEX_POLICY_STORE_KEY, data: { ...policy, updatedAt: now, updatedBy: auth.actor } },
  });
  await prisma.agentEvent.create({ data: {
    kind: "status", title: "Política de asignación Codex actualizada",
    detail: "Prioridad mínima: " + minimumPriority + "; aprobación humana obligatoria para cambios; las auditorías solo pasan con contrato read-only. Los conteos de 5 horas y 7 días se conservan solo como telemetría; la admisión consulta capacidad real del proveedor.",
    agent: "codex", level: minimumPriority === "paused" ? "warn" : "info",
    meta: { ...policy, actor: auth.actor },
  } });
  return NextResponse.json({
    policy,
    updatedAt: now,
    waitingApproval: await prisma.agentRequest.count({ where: { kind: { in: ["codex.audit", "codex.change"] }, origin: "max", status: "awaiting_approval" } }),
  });
}
