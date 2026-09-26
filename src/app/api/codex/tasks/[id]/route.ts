import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isEmergencyStopActive } from "@/lib/agent-dispatch";

const CODEX_KINDS = ["codex.audit", "codex.change"];
const READY_STATUSES = ["queued", "approved"];
const CODEX_AGENT = {
  id: "codex",
  name: "Codex",
  emoji: "🛠️",
  role: "VPS Engineering Worker · unprivileged example-user account",
};
const STRUCTURED_KEYS = ["cause", "hypothesis", "remediation", "validation", "limitations", "nextAction"] as const;

function parseStructuredReport(value: unknown) {
  const text = String(value || "");
  const labels = [
    ["cause", "CAUSA_CONFIRMADA"], ["hypothesis", "HIPOTESIS"], ["remediation", "REPARACION_APLICADA"],
    ["validation", "VALIDACION"], ["limitations", "LIMITACIONES"], ["nextAction", "SIGUIENTE_ACCION"],
  ] as const;
  const fields = Object.fromEntries(labels.map(([key, label]) => [key, text.match(new RegExp(`(?:^|\\n)\\s*${label}:\\s*(.*)`, "i"))?.[1]?.trim() || ""])) as Record<string, string>;
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await taskFor(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}

// PATCH { action: claim | complete | fail | confirm_destructive, result? | error? }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  const processor = body.processor === "codex-backup" ? "codex-backup" : "codex";

  if (action === "record-structure") {
    const text = (key: string) => typeof body[key] === "string" && String(body[key]).trim() ? String(body[key]).trim().slice(0, 2000) : null;
    const task = await taskFor(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.$executeRaw`UPDATE "IncidentMemory" SET cause=coalesce(${text("cause")},cause), hypothesis=coalesce(${text("hypothesis")},hypothesis), remediation=coalesce(${text("remediation")},remediation), validation=coalesce(${text("validation")},validation), limitations=coalesce(${text("limitations")},limitations), next_action=coalesce(${text("nextAction")},next_action), updated_at=now() WHERE request_id=${id}`;
    return NextResponse.json({ ok: true, requestId: id });
  }

  if (action === "confirm_destructive") {
    const task = await taskFor(id);
    if (!task || task.status !== "awaiting_destructive_confirmation") return NextResponse.json({ error: "task is not awaiting destructive confirmation" }, { status: 409 });
    if (Date.now() - task.createdAt.getTime() > 10 * 60 * 1000) return NextResponse.json({ error: "destructive confirmation expired; create a new task" }, { status: 409 });
    if (String(body.confirmation || "").trim() !== `AUTORIZO ${id}`) return NextResponse.json({ error: `type exactly AUTORIZO ${id}` }, { status: 400 });
    const updated = await prisma.agentRequest.update({ where: { id }, data: { status: "approved", decidedAt: new Date() } });
    await prisma.agentEvent.create({ data: { kind: "run", title: "Codex destructive task explicitly authorized: " + updated.title, agent: "codex", level: "warn", meta: { requestId: id, destructive: true } } });
    return NextResponse.json({ task: updated });
  }

  if (action === "claim") {
    const emergency = await isEmergencyStopActive();
    if (emergency) return NextResponse.json({ error: "Emergency reset active" }, { status: 503 });
    const conflict = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (SELECT pg_advisory_xact_lock(782440)) SELECT TRUE AS locked FROM lock_acquired`;
      const circuitRow = await tx.dataStore.findUnique({ where: { key: "codex-circuit" } });
      const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string } | undefined;
      const activeAgent = circuit?.open ? (circuit.activeAgent || "codex-backup") : "codex";
      if (processor !== activeAgent) return "wrong_processor";
      const running = await tx.agentRequest.findFirst({ where: { kind: { in: CODEX_KINDS }, status: "running" } });
      if (running) return "already_running";
      const agentState = await tx.agentState.findUnique({ where: { id: processor } });
      if (agentState?.status === "paused") return "paused";
      const claimed = await tx.agentRequest.updateMany({
        where: { id, kind: { in: CODEX_KINDS }, status: { in: READY_STATUSES } },
        data: { status: "running", startedAt: new Date(), error: null },
      });
      return claimed.count ? null : "not_ready";
    });
    if (conflict === "wrong_processor") return NextResponse.json({ error: "Only the active Codex or backup processor may claim tasks" }, { status: 409 });
    if (conflict === "already_running") return NextResponse.json({ error: "Another Codex task is already running" }, { status: 409 });
    if (conflict === "paused") return NextResponse.json({ error: `${processor} is paused; task remains queued` }, { status: 409 });
    if (conflict) return NextResponse.json({ error: "task is not ready to claim" }, { status: 409 });
    const task = await taskFor(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.$executeRaw`
      INSERT INTO "InferenceAttempt" (id,request_id,attempt_no,provider,model,status,created_at)
      SELECT ${`codex-${id}-${Date.now()}`}, ${id}, COALESCE(MAX(attempt_no), 0) + 1,
        ${processor === "codex-backup" ? "custom" : "openai"},
        ${processor === "codex-backup" ? "qwen3-8b-local" : "codex"}, 'running', now()
      FROM "InferenceAttempt"
      WHERE request_id = ${id}
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
            duration_ms = extract(epoch from (now() - created_at)) * 1000,
            finished_at = now()
        WHERE request_id = ${id} AND status = 'running'
          AND provider = 'openai'
      `;
      const circuitData = { open: true, activeAgent: "codex-backup", reason: detail.slice(0, 500), openedAt: now, failoverAt: now, taskId: id, taskTitle: currentTask.title, nextProbeAt: now + 30 * 60_000 };
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
      await tx.$executeRaw`UPDATE "InferenceAttempt" SET status = 'failed', reason = ${detail.slice(0, 500)}, duration_ms = extract(epoch from (now() - created_at)) * 1000, finished_at = now() WHERE request_id = ${id} AND status = 'running' AND provider = 'custom'`;
      const circuitData = { open: true, activeAgent: "hold", fallbackFailed: true, reason: detail.slice(0, 500), openedAt: now, failoverAt: now, taskId: id, taskTitle: currentTask.title, nextProbeAt: now + 30 * 60_000 };
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

  const terminalStatus = succeeded ? "done" : "failed";
  const updated = await prisma.agentRequest.updateMany({
    where: { id, status: "running" },
    data: {
      status: terminalStatus,
      result: succeeded ? detail.slice(0, 8000) : null,
      error: succeeded ? null : detail.slice(0, 2000),
      finishedAt: new Date(),
    },
  });
  if (!updated.count) return NextResponse.json({ error: "task no longer running" }, { status: 409 });
  const task = await taskFor(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.$executeRaw`UPDATE "InferenceAttempt" SET status=${succeeded ? "success" : "failed"}, reason=${succeeded ? null : detail.slice(0, 500)}, duration_ms=extract(epoch from (now()-created_at))*1000, finished_at=now() WHERE request_id=${id} AND status='running'`;
  if (!succeeded && body.circuitOpen === true) {
    const now = Date.now();
    const reason = detail.slice(0, 500);
    await prisma.dataStore.upsert({
      where: { key: "codex-circuit" },
      update: { data: { open: true, reason, openedAt: now, nextProbeAt: now + 30 * 60_000 } },
      create: { key: "codex-circuit", data: { open: true, reason, openedAt: now, nextProbeAt: now + 30 * 60_000 } },
    });
    await prisma.agentState.updateMany({ where: { id: "codex" }, data: { status: "offline", currentTask: null, updatedAt: new Date() } });
  }
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
