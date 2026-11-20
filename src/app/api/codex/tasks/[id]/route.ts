import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireHumanActor, requestActor } from "@/lib/human-auth";
import { recordDestructiveApproval } from "@/lib/approval-control";
import { dependenciesAreDone } from "@/lib/phase2-domain.mjs";
import { isEmergencyStopActive } from "@/lib/agent-dispatch";
import { CODEX_POLICY_STORE_KEY, codexAssignmentAllowed, codexParentAttemptAllowed, codexParentRequestId, normalizeCodexPolicy } from "@/lib/codex-policy.mjs";
import { inferenceCostStatusForEvidence } from "@/lib/inference-cost-status.mjs";
import { codexReadinessMarkerPresent } from "@/lib/codex-readiness-marker.mjs";
import { codexManualOverrideKey, isCodexManualOverride } from "@/lib/codex-manual-override.mjs";
import { codexTaskPolicy } from "../../../../../../hermes-bridge/codex-task-contract.mjs";
import { codexUnavailableRoute } from "../../../../../../hermes-bridge/codex-unavailable-router.mjs";

const CODEX_KINDS = ["codex.audit", "codex.change"];
const READY_STATUSES = ["queued", "approved"];
const CODEX_AGENT = {
  id: "codex",
  name: "Codex",
  emoji: "🛠️",
  role: "VPS Engineering Worker · unprivileged reyam account",
};
const STRUCTURED_KEYS = ["cause", "hypothesis", "remediation", "validation", "limitations", "nextAction"] as const;

function parseStructuredReport(value: unknown) {
  const text = String(value || "");
  const labels = [
    ["cause", "CAUSA_CONFIRMADA"], ["hypothesis", "HIPOTESIS"], ["remediation", "REPARACION_APLICADA"],
    ["validation", "VALIDACION"], ["limitations", "LIMITACIONES"], ["nextAction", "SIGUIENTE_ACCION"],
  ] as const;
  const fields = Object.fromEntries(labels.map(([key, label]) => [key, text.match(new RegExp(`(?:^|\
)\\s*${label}:\\s*(.*)`, "i"))?.[1]?.trim() || ""])) as Record<string, string>;
  const missing = STRUCTURED_KEYS.filter((key) => !fields[key] || /^(pendiente|no registrado|n\/a|na|unknown|desconocido|sin datos|no aplica)$/i.test(fields[key]));
  return { fields, missing };
}

export const dynamic = "force-dynamic";

async function updateCodexState(
  status: string,
  currentTask: string | null,
  action: string,
  completed = false,
  agentId = "codex",
) {
  const agent = CODEX_AGENT;
  const now = new Date();
  const existing = await prisma.agentState.findUnique({ where: { id: agent.id } });
  const keepPaused = existing?.status === "paused";
  const recentActivity = (existing?.recentActivity as Array<{ timestamp: string; action: string }>) || [];
  const activity = agentId === "codex-backup" ? `${action} (provider: Qwen)` : action;
  await prisma.agentState.upsert({
    where: { id: agent.id },
    update: {
      status: keepPaused ? "paused" : status,
      currentTask: keepPaused ? null : currentTask,
      lastActive: now,
      recentActivity: [{ timestamp: now.toISOString(), action: activity }, ...recentActivity.slice(0, 19)],
      ...(completed ? { tasksCompleted: (existing?.tasksCompleted || 0) + 1 } : {}),
    },
    create: {
      ...agent,
      status,
      currentTask,
      lastActive: now,
      tasksCompleted: completed ? 1 : 0,
      totalCost: 0,
      recentActivity: [{ timestamp: now.toISOString(), action: activity }],
    },
  });
}

async function taskFor(id: string) {
  const task = await prisma.agentRequest.findUnique({ where: { id } });
  if (!task || !CODEX_KINDS.includes(task.kind)) return null;
  return task;
}

async function notifyMax(
  task: { id: string; title: string },
  status: "done" | "failed",
  detail: string,
) {
  const succeeded = status === "done";
  const summary = "Codex " + (succeeded ? "completed" : "failed") +
    " “" + task.title + "”: " + detail;
  await prisma.$transaction([
    prisma.agentEvent.create({
      data: {
        kind: "run",
        title: "Codex " + (succeeded ? "completed" : "failed") + ": " + task.title,
        detail: detail.slice(0, 2000),
        agent: "codex",
        level: succeeded ? "up" : "down",
        meta: { requestId: task.id, status },
      },
    }),
    prisma.agentBusMessage.create({
      data: {
        fromAgent: "codex",
        toAgent: "max",
        type: succeeded ? "codex_result" : "codex_failure",
        content: summary.slice(0, 8000),
        metadata: { requestId: task.id, status, title: task.title },
        read: false,
      },
    }),
  ]);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requestActor(req, "internal:codex-worker");
  if (auth.response) return auth.response;
  if (auth.actor !== "internal:codex-worker") return NextResponse.json({ error: "Endpoint reservado al worker Codex" }, { status: 403 });
  const { id } = await params;
  const task = await taskFor(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}

// PATCH { action: claim | complete | fail | confirm_destructive, result? | error? }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requestActor(req, "internal:codex-worker");
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  if (action === "confirm_destructive") {
    if (auth.actor === "internal:codex-worker") return NextResponse.json({ error: "La confirmación destructiva requiere una persona autorizada" }, { status: 403 });
  } else if (auth.actor !== "internal:codex-worker") {
    return NextResponse.json({ error: "La ejecución de Codex requiere el worker autenticado" }, { status: 403 });
  }
  const processor = body.processor === "codex-backup" ? "codex-backup" : "codex";

  if (action === "reject-policy") {
    const task = await taskFor(id);
    if (!task || !READY_STATUSES.includes(task.status)) return NextResponse.json({ error: "task is not eligible for policy rejection" }, { status: 409 });
    const contract = codexTaskPolicy(task);
    const assignmentAllowed = codexAssignmentAllowed(task.prompt, null, task.status, task);
    if (contract.eligible && assignmentAllowed) return NextResponse.json({ error: "valid task cannot be rejected by policy" }, { status: 409 });
    const reason = String(body.reason || contract.reason || "assignment_policy_invalid").slice(0, 120);
    const changed = await prisma.agentRequest.updateMany({
      where: { id, status: { in: READY_STATUSES } },
      data: { status: "failed", error: "Worker safety policy rejected task: " + reason, finishedAt: new Date() },
    });
    if (!changed.count) return NextResponse.json({ error: "task changed before rejection" }, { status: 409 });
    await prisma.agentEvent.create({ data: {
      kind: "approval", title: "Codex rechazó una tarea fuera del contrato read-only",
      detail: "No se inició ningún proceso de modelo. Motivo: " + reason,
      agent: "codex", level: "warn", meta: { requestId: id, decision: "rejected_by_worker_policy", reason },
    } });
    return NextResponse.json({ ok: true, requestId: id, status: "failed", reason });
  }

  if (action === "worker-start") {
    const task = await taskFor(id);
    if (!task || task.status !== "running") return NextResponse.json({ error: "task is not running" }, { status: 409 });
    const workerPid = Number(body.workerPid);
    if (!Number.isSafeInteger(workerPid) || workerPid < 1 || body.workerUnit !== "codex-hermy-vps.service") return NextResponse.json({ error: "invalid worker identity" }, { status: 400 });
    const workerStartedAt = typeof body.workerStartedAt === "string" && Number.isFinite(Date.parse(body.workerStartedAt)) ? new Date(body.workerStartedAt) : new Date();
    const provider = processor === "codex-backup" ? "custom" : "openai-codex";
    const gateway = processor === "codex-backup" ? "tailscale-http" : "codex-hermy-vps.service";
    await prisma.$executeRaw`UPDATE "InferenceAttempt" SET actual_provider=${provider}, gateway=${gateway}, started_at=${workerStartedAt}, route_cost_policy=${processor === "codex-backup" ? "local_no_billing" : "subscription_only_no_payg"} WHERE request_id=${id} AND status='running' AND provider IN ('openai','qwen-local-tailscale')`;
    await prisma.agentEvent.create({ data: {
      kind: "run", title: (processor === "codex-backup" ? "Qwen fallback worker started: " : "Codex worker picked task: ") + task.title,
      agent: "codex", level: "info", meta: { requestId: id, workerPid, workerUnit: "codex-hermy-vps.service", workerStartedAt: workerStartedAt.toISOString(), provider },
    } });
    return NextResponse.json({ ok: true, requestId: id, workerPid, workerUnit: "codex-hermy-vps.service", workerStartedAt: workerStartedAt.toISOString() });
  }

  if (action === "record-structure") {
    const text = (key: string) => typeof body[key] === "string" && String(body[key]).trim() ? String(body[key]).trim().slice(0, 2000) : null;
    const task = await taskFor(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.$executeRaw`UPDATE "IncidentMemory" SET cause=coalesce(${text("cause")},cause), hypothesis=coalesce(${text("hypothesis")},hypothesis), remediation=coalesce(${text("remediation")},remediation), validation=coalesce(${text("validation")},validation), limitations=coalesce(${text("limitations")},limitations), next_action=coalesce(${text("nextAction")},next_action), updated_at=now() WHERE request_id=${id}`;
    return NextResponse.json({ ok: true, requestId: id });
  }

  if (action === "confirm_destructive") {
    const auth = await requireHumanActor();
    if (auth.response) return auth.response;
    const task = await taskFor(id);
    if (!task || task.status !== "awaiting_destructive_confirmation") return NextResponse.json({ error: "task is not awaiting destructive confirmation" }, { status: 409 });
    if (Date.now() - task.createdAt.getTime() > 10 * 60 * 1000) return NextResponse.json({ error: "destructive confirmation expired; create a new task" }, { status: 409 });
    if (String(body.confirmation || "").trim() !== "AUTORIZO " + id) return NextResponse.json({ error: "type exactly AUTORIZO " + id }, { status: 400 });
    const approved = await recordDestructiveApproval(id, auth.actor);
    if (!approved.ok) return NextResponse.json({ error: approved.error }, { status: approved.status });
    const updated = await taskFor(id);
    return NextResponse.json({ task: updated, approvalId: approved.approvalId, approvedBy: auth.actor });
  }

  if (action === "capacity-deferred") {
    const task = await taskFor(id);
    if (!task || ![...READY_STATUSES, "running"].includes(task.status)) return NextResponse.json({ error: "task is not ready for capacity deferral" }, { status: 409 });
    const input = body.report && typeof body.report === "object" ? body.report as Record<string, unknown> : {};
    const capacity = String(input.provider_capacity || "unknown");
    const requestedTaskClass = String(input.task_class || "");
    const permittedTaskClasses = ["analysis_only", "code_generation", "structured_tools", "restricted_execution", "privileged_execution"];
    const taskClass = task.sideEffecting ? "privileged_execution" : permittedTaskClasses.includes(requestedTaskClass) ? requestedTaskClass : task.kind === "codex.audit" ? "analysis_only" : "structured_tools";
    const manualOverrideRow = task.origin === "web"
      ? await prisma.dataStore.findUnique({ where: { key: codexManualOverrideKey(id) } })
      : null;
    const ownerExplicit = task.origin === "web" && isCodexManualOverride(manualOverrideRow?.data, task);
    const routed = codexUnavailableRoute({ taskClass, capacity, workerHealthy: input.worker_healthy === true, requestedBy: ownerExplicit ? "owner" : "agent" });
    let fallbackKind: string | null = null;
    let fallbackAgent: string | null = null;
    if (routed.fallback_executor === "atlas") { fallbackKind = "atlas.research"; fallbackAgent = "atlas"; }
    else if (routed.fallback_executor === "max") { fallbackKind = "max.chief-of-staff"; fallbackAgent = "max"; }
    else if (routed.fallback_executor === "allowlisted_agent_tools" && !task.sideEffecting && task.capability === "read_only") { fallbackKind = "ledger.operations"; fallbackAgent = "ledger"; }
    const shouldCreateFallback = Boolean(fallbackKind && !routed.execution_deferred);
    const routeReport = { ...routed, requested_by: ownerExplicit ? "owner" : "agent", provider_capacity: capacity, capacity_source: String(input.capacity_source || "unknown"), capacity_checked_at: String(input.capacity_checked_at || new Date().toISOString()), requested_executor: "codex", actual_executor: shouldCreateFallback ? fallbackAgent : null, fallback_reason: capacity === "exhausted" ? "openai_quota_exhausted" : String(input.reason || "codex_unavailable"), degraded: shouldCreateFallback, execution_deferred: !shouldCreateFallback };
    const detail = JSON.stringify(routeReport).slice(0, 2000);
    const outcome = await prisma.$transaction(async (tx) => {
      const changed = await tx.agentRequest.updateMany({ where: { id, status: { in: [...READY_STATUSES, "running"] } }, data: { status: "failed", error: detail, result: detail, finishedAt: new Date() } });
      if (!changed.count) return null;
      let fallbackId: string | null = null;
      if (shouldCreateFallback && fallbackKind && fallbackAgent) {
        const child = await tx.agentRequest.create({ data: {
          id: randomUUID(), idempotencyKey: "codex-fallback:" + id, origin: "max", kind: fallbackKind,
          title: ("Codex fallback · " + task.title).slice(0, 200),
          prompt: "[[CODEX_FALLBACK_PARENT_V1:" + id + "]]\nFallback route selected because Codex capacity or worker is unavailable. Do not delegate this request back to Codex.\nRead-only capability only. Do not execute any generated code or perform side effects.\nIf producing code/configuration, return a proposal and validation plan only; it must pass fresh capability, risk, approval, and execution checks before any action. If no safe read-only route is available, return CODEX_DEFERRED_EXECUTION.\n\nOriginal task:\n" + String(task.prompt || task.title).slice(0, 8000),
          status: "queued", sideEffecting: false, action: fallbackKind === "atlas.research" ? "research" : fallbackKind === "ledger.operations" ? "audit" : "coordinate",
          capability: "read_only", dependsOn: [],
        } });
        fallbackId = child.id;
      }
      const finalReport = { ...routeReport, fallback_request_id: fallbackId };
      const finalDetail = JSON.stringify(finalReport).slice(0, 2000);
      await tx.agentRequest.update({ where: { id }, data: { result: finalDetail, error: finalDetail } });
      return { report: finalReport, detail: finalDetail };
    });
    if (!outcome) return NextResponse.json({ error: "task changed before deferral" }, { status: 409 });
    if (capacity === "exhausted" && input.capacity_source === "openai_runtime_response") {
      const providerState = { provider: "openai", surface: "codex", state: "exhausted", source: "openai_runtime_response", reason: String(input.reason || "provider limit response").slice(0, 300), checked_at: new Date().toISOString() };
      await prisma.dataStore.upsert({ where: { key: "codex-provider-capacity" }, update: { data: providerState }, create: { key: "codex-provider-capacity", data: providerState } });
    }
    await prisma.agentEvent.create({ data: { kind: "run", title: outcome.report.status === "NEEDS_OWNER_OVERRIDE" ? "Codex capacity unknown; owner decision required" : "Codex unavailable; capability fallback routed", detail: outcome.detail, agent: "codex", level: "warn", meta: { requestId: id, requestedBy: ownerExplicit ? "owner" : "agent", providerCapacity: capacity, fallbackExecutor: outcome.report.actual_executor, fallbackRequestId: outcome.report.fallback_request_id, executionDeferred: outcome.report.execution_deferred } } });
    const updatedTask = await taskFor(id);
    if (updatedTask && !ownerExplicit) await notifyMax(updatedTask, "failed", outcome.detail);
    return NextResponse.json({ ok: true, requestId: id, status: outcome.report.status, report: outcome.report });
  }

  if (action === "claim") {
    const emergency = await isEmergencyStopActive();
    if (emergency) return NextResponse.json({ error: "Emergency reset active" }, { status: 503 });
    const conflict = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (SELECT pg_advisory_xact_lock(782440)) SELECT TRUE AS locked FROM lock_acquired`;
      const circuitRow = await tx.dataStore.findUnique({ where: { key: "codex-circuit" } });
      const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string } | undefined;
      const activeAgent = circuit?.open ? (circuit.activeAgent || "codex-backup") : "codex";
      if (circuit?.open) return "circuit_open";
      if (processor !== activeAgent) return "wrong_processor";
      const running = await tx.agentRequest.findFirst({ where: { kind: { in: CODEX_KINDS }, status: "running" } });
      if (running) return "already_running";
      const agentState = await tx.agentState.findUnique({ where: { id: "codex" } });
      if (agentState?.status === "paused") return "paused";
      const candidate = await tx.agentRequest.findUnique({ where: { id } });
      if (!candidate) return "not_ready";
      const overrideRow = await tx.dataStore.findUnique({ where: { key: codexManualOverrideKey(id) } });
      const manualOverride = isCodexManualOverride(overrideRow?.data, candidate);
      if (candidate.origin !== "max" && !manualOverride) return "not_ready";
      if (candidate.origin === "web" && !manualOverride) return "not_ready";
      const policyRow = await tx.dataStore.findUnique({ where: { key: CODEX_POLICY_STORE_KEY } });
      const contract = codexTaskPolicy(candidate, candidate.status, manualOverride);
      if (!contract.eligible || (!manualOverride && !codexAssignmentAllowed(candidate.prompt, normalizeCodexPolicy(policyRow?.data), candidate.status, candidate))) return "policy_blocked";
      const parentId = codexParentRequestId(candidate);
      if (candidate.origin === "max" && parentId) {
        const siblings = await tx.agentRequest.findMany({
          where: { origin: "max", kind: { in: CODEX_KINDS }, prompt: { contains: `[[CODEX_PARENT_V1:${parentId}]]` } },
          select: { id: true, origin: true, prompt: true, createdAt: true },
        });
        if (!codexParentAttemptAllowed(candidate, siblings)) return "parent_attempt_used";
      }
      const dependencyIds = Array.isArray(candidate.dependsOn) ? candidate.dependsOn.map(String) : [];
      const dependencyRows = dependencyIds.length ? await tx.agentRequest.findMany({ where: { id: { in: dependencyIds } }, select: { id: true, status: true } }) : [];
      if (!dependenciesAreDone(dependencyIds, new Map(dependencyRows.map((row) => [row.id, row])))) return "blocked_dependencies";
      const claimed = await tx.agentRequest.updateMany({
        where: { id, kind: { in: CODEX_KINDS }, status: { in: READY_STATUSES } },
        data: { status: "running", startedAt: new Date(), error: null },
      });
      return claimed.count ? null : "not_ready";
    });
    if (conflict === "wrong_processor") return NextResponse.json({ error: "Only the active Codex or backup processor may claim tasks" }, { status: 409 });
    if (conflict === "circuit_open") return NextResponse.json({ error: "Codex health circuit is open; the task remains unclaimed" }, { status: 503 });
    if (conflict === "parent_attempt_used") return NextResponse.json({ error: "The automatic Codex attempt for this MAX parent has already been used", code: "CODEX_PARENT_ATTEMPT_USED" }, { status: 409 });
    if (conflict === "already_running") return NextResponse.json({ error: "Another Codex task is already running" }, { status: 409 });
    if (conflict === "paused") return NextResponse.json({ error: `${processor} is paused; task remains queued` }, { status: 409 });
    if (conflict === "blocked_dependencies") return NextResponse.json({ error: "task dependencies are not complete" }, { status: 409 });
    if (conflict === "policy_blocked") return NextResponse.json({ error: "Codex policy requires an eligible important assignment and human approval" }, { status: 409 });
    if (conflict) return NextResponse.json({ error: "task is not ready to claim" }, { status: 409 });
    const task = await taskFor(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    const requestedProvider = processor === "codex-backup" ? "qwen-local-tailscale" : "openai";
    const requestedModel = processor === "codex-backup" ? "qwen3-8b-local" : "codex";
    const gateway = processor === "codex-backup" ? "tailscale-http" : "codex-hermy-vps";
    await prisma.$executeRaw`
      WITH route(provider, model, gateway) AS (VALUES (${requestedProvider}, ${requestedModel}, ${gateway}))
      INSERT INTO "InferenceAttempt" (
        id,request_id,attempt_no,attempt_number,provider,model,requested_provider,requested_model,gateway,
        actual_provider,actual_model,status,cost_status,started_at,created_at
      )
      SELECT ${`codex-${id}-${Date.now()}`}, ${id},
        (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM "InferenceAttempt" WHERE request_id=${id}),
        (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM "InferenceAttempt" WHERE request_id=${id}),
        route.provider, route.model, route.provider, route.model, route.gateway,
        NULL,NULL,'running','unknown',now(),now()
      FROM route
      ON CONFLICT DO NOTHING`;
    await prisma.agentEvent.create({
      data: {
        kind: "run",
        title: (processor === "codex-backup" ? "Qwen backup started: " : "Codex started: ") + task.title,
        agent: "codex",
        level: "info",
        meta: { requestId: task.id },
      },
    });
    await updateCodexState("working", task.title, "Started task", false, processor);
    return NextResponse.json({ task });
  }

  if (action === "failover") {
    if (processor !== "codex") return NextResponse.json({ error: "Only Codex can hand work to the backup" }, { status: 400 });
    const currentTask = await taskFor(id);
    if (!currentTask || currentTask.status !== "running") return NextResponse.json({ error: "task is not running" }, { status: 409 });
    const detail = String(body.error || "Codex became unavailable").trim().slice(0, 2000);
    const now = Date.now();
    const moved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (SELECT pg_advisory_xact_lock(782440)) SELECT TRUE AS locked FROM lock_acquired`;
      const changed = await tx.agentRequest.updateMany({
        where: { id, kind: { in: CODEX_KINDS }, status: "running" },
        data: { status: "queued", startedAt: null, finishedAt: null, error: detail, result: null },
      });
      if (!changed.count) return false;
      await tx.$executeRaw`
        UPDATE "InferenceAttempt"
        SET status = 'failed', reason = ${detail.slice(0, 500)},
            duration_ms = CASE WHEN now() >= COALESCE(started_at, created_at) THEN extract(epoch from (now() - COALESCE(started_at, created_at))) * 1000 ELSE NULL END,
            error_class = 'provider_unavailable', finished_at = now()
        WHERE request_id = ${id} AND status = 'running'
          AND provider = 'openai'
      `;
      const circuitData = { open: true, activeAgent: "codex-backup", reason: detail.slice(0, 500), openedAt: now, failoverAt: now, taskId: id, taskTitle: currentTask.title, };
      await tx.dataStore.upsert({ where: { key: "codex-circuit" }, update: { data: circuitData }, create: { key: "codex-circuit", data: circuitData } });
      return true;
    });
    if (!moved) return NextResponse.json({ error: "task no longer running" }, { status: 409 });
    await updateCodexState("idle", null, "OpenAI Codex unavailable; same Codex agent switched to Qwen", false, "codex");
    await prisma.agentEvent.create({ data: { kind: "run", title: "Codex switched to Qwen backup", detail: detail.slice(0, 2000), agent: "codex", level: "warn", meta: { requestId: id, activeProvider: "qwen" } } });
    return NextResponse.json({ task: await taskFor(id), activeAgent: "codex-backup" });
  }

  if (action === "backup-failed") {
    if (processor !== "codex-backup") return NextResponse.json({ error: "Only the Qwen backup can enter backup hold" }, { status: 400 });
    const currentTask = await taskFor(id);
    if (!currentTask || currentTask.status !== "running") return NextResponse.json({ error: "task is not running" }, { status: 409 });
    const detail = String(body.error || "Qwen backup is unavailable").trim().slice(0, 2000);
    const now = Date.now();
    const failed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (SELECT pg_advisory_xact_lock(782440)) SELECT TRUE AS locked FROM lock_acquired`;
      const changed = await tx.agentRequest.updateMany({
        where: { id, kind: { in: CODEX_KINDS }, status: "running" },
        data: { status: "queued", startedAt: null, finishedAt: null, error: detail, result: null },
      });
      if (!changed.count) return false;
      await tx.$executeRaw`UPDATE "InferenceAttempt" SET status = 'failed', reason = ${detail.slice(0, 500)}, duration_ms = CASE WHEN now() >= COALESCE(started_at, created_at) THEN extract(epoch from (now() - COALESCE(started_at, created_at))) * 1000 ELSE NULL END, error_class = 'provider_unavailable', finished_at = now() WHERE request_id = ${id} AND status = 'running' AND provider IN ('custom','qwen-local-tailscale')`;
      const circuitData = { open: true, activeAgent: "hold", fallbackFailed: true, reason: detail.slice(0, 500), openedAt: now, failoverAt: now, taskId: id, taskTitle: currentTask.title, };
      await tx.dataStore.upsert({ where: { key: "codex-circuit" }, update: { data: circuitData }, create: { key: "codex-circuit", data: circuitData } });
      return true;
    });
    if (!failed) return NextResponse.json({ error: "task no longer running" }, { status: 409 });
    const task = await taskFor(id);
    if (task) await prisma.agentEvent.create({ data: { kind: "run", title: "Qwen backup failed; task held for Codex recovery", detail: detail.slice(0, 2000), agent: "codex", level: "warn", meta: { requestId: id, activeAgent: "hold", status: "queued" } } });
    await updateCodexState("offline", null, "Qwen backup failed; agent held until OpenAI Codex recovers", false, "codex");
    return NextResponse.json({ task, activeAgent: "hold" });
  }

  if (action !== "complete" && action !== "fail") {
    return NextResponse.json({ error: "action must be claim|complete|fail|failover" }, { status: 400 });
  }

  const existing = await taskFor(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status !== "running") {
    return NextResponse.json({ error: "cannot finish a " + existing.status + " task" }, { status: 409 });
  }

  const succeeded = action === "complete";
  const detail = String(succeeded ? body.result || "" : body.error || "").trim();
  if (!detail) return NextResponse.json({ error: succeeded ? "result required" : "error required" }, { status: 400 });
  if (succeeded) {
    const report = parseStructuredReport(detail);
    if (report.missing.length) return NextResponse.json({ error: "structured report required", missing: report.missing }, { status: 422 });
  }

  const errorClass = succeeded ? null : /timeout|timed out|ETIMEDOUT|ECONN|network/i.test(detail)
    ? "network" : /\b(429|quota|rate limit|usage limit|spend control|insufficient_quota)\b/i.test(detail) ? "external_provider_limit" : /\b(401|403)\b/i.test(detail) ? "provider_rejection" : "task_error";
  const terminalStatus = succeeded ? "done" : "failed";
  const actualProvider = processor === "codex-backup" ? "custom" : "openai-codex";
  const actualModel = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 120) : null;
  const workerPid = Number.isSafeInteger(Number(body.workerPid)) && Number(body.workerPid) > 0 ? Number(body.workerPid) : null;
  const markerPresent = succeeded && codexReadinessMarkerPresent(detail);
  const requestedProvider = processor === "codex-backup" ? "qwen-local-tailscale" : "openai";
  const routeCostPolicy = processor === "codex-backup" ? "local_no_billing" : "subscription_only_no_payg";
  const costStatus = inferenceCostStatusForEvidence({ routeCostPolicy });
  const completion = await prisma.$transaction(async (tx) => {
    const updated = await tx.agentRequest.updateMany({
      where: { id, status: "running" },
      data: {
        status: terminalStatus,
        result: succeeded ? detail.slice(0, 8000) : null,
        error: succeeded ? null : detail.slice(0, 2000),
        finishedAt: new Date(),
      },
    });
    if (!updated.count) return { conflict: true as const };
    const task = await tx.agentRequest.findUnique({
      where: { id },
      select: { id: true, title: true, startedAt: true },
    });
    if (!task) return { missing: true as const };
    const workerStartedAt = typeof body.workerStartedAt === "string" && Number.isFinite(Date.parse(body.workerStartedAt))
      ? new Date(body.workerStartedAt)
      : task.startedAt;
    const attemptUpdated = await tx.$executeRaw`
      WITH target AS (
        SELECT id
        FROM "InferenceAttempt"
        WHERE request_id=${id} AND status='running' AND provider=${requestedProvider}
        ORDER BY attempt_no DESC
        LIMIT 1
        FOR UPDATE
      )
      UPDATE "InferenceAttempt" AS attempt
      SET status=${succeeded ? "success" : "failed"},
          reason=${succeeded ? null : detail.slice(0, 500)},
          error_class=${errorClass},
          duration_ms=CASE WHEN now() >= COALESCE(started_at, created_at)
            THEN extract(epoch from (now()-COALESCE(started_at, created_at)))*1000
            ELSE NULL END,
          actual_provider=${actualProvider},
          actual_model=COALESCE(${actualModel},attempt.actual_model),
          underlying_provider=${processor === "codex-backup" ? null : "OpenAI"},
          route_cost_policy=${routeCostPolicy},
          reported_cost=NULL,
          cost_currency=NULL,
          cost_status=${costStatus},
          cost_source=${processor === "codex-backup" ? "local_no_billing" : "subscription_usage_not_reported"},
          free_route=${processor === "codex-backup"},
          finished_at=now()
      FROM target
      WHERE attempt.id=target.id`;
    if (attemptUpdated !== 1) throw new Error("Codex completion requires exactly one running inference attempt");
    await tx.agentEvent.create({ data: {
      kind: "run", title: (processor === "codex-backup" ? "Qwen fallback worker finished: " : "Codex worker finished: ") + task.title,
      agent: "codex", level: succeeded ? "info" : "warn",
      meta: { requestId: id, workerPid, workerUnit: "codex-hermy-vps.service", workerStartedAt: workerStartedAt?.toISOString() || null, workerFinishedAt: new Date().toISOString(), provider: actualProvider, model: actualModel, status: terminalStatus, markerPresent },
    } });
    await tx.$executeRaw`UPDATE "ActionApproval" SET result=${succeeded ? "execution completed; see linked request" : "execution failed; see linked request"} WHERE request_id=${id} AND status='approved'`;
    if (!succeeded && errorClass === "external_provider_limit") {
      const capacity = { provider: "openai", surface: "codex", state: "exhausted", source: "openai_runtime_response", reason: detail.slice(0, 300), checked_at: new Date().toISOString() };
      await tx.dataStore.upsert({ where: { key: "codex-provider-capacity" }, update: { data: capacity }, create: { key: "codex-provider-capacity", data: capacity } });
    }
    if (!succeeded && body.circuitOpen === true) {
      const now = Date.now();
      const reason = detail.slice(0, 500);
      await tx.dataStore.upsert({
        where: { key: "codex-circuit" },
        update: { data: { open: true, reason, openedAt: now, } },
        create: { key: "codex-circuit", data: { open: true, reason, openedAt: now, } },
      });
      await tx.agentState.updateMany({ where: { id: "codex" }, data: { status: "offline", currentTask: null, updatedAt: new Date() } });
    }
    return { task };
  });
  if ("conflict" in completion) return NextResponse.json({ error: "task no longer running" }, { status: 409 });
  if ("missing" in completion) return NextResponse.json({ error: "not found" }, { status: 404 });
  const task = await taskFor(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  await notifyMax(task, succeeded ? "done" : "failed", detail);
  await updateCodexState(
    succeeded ? "idle" : "error",
    null,
    succeeded ? "Completed: " + task.title : "Failed: " + task.title,
    succeeded,
    processor,
  );
  return NextResponse.json({ task });
}
