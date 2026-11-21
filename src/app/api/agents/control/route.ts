import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { EMERGENCY_GATE_KEY, EMERGENCY_GATE_LOCK } from "@/lib/agent-dispatch";
import { requireHumanActor } from "@/lib/human-auth";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation", "running"];
const AGENT_KINDS: Record<string, string[]> = {
  max: ["max.chief-of-staff", "max.deep-analysis"],
  codex: ["codex.audit", "codex.change", "codex.engineering"],
  atlas: ["atlas.research"],
  aegis: ["aegis.security"],
  pulse: ["pulse.social", "video.youtube.analyze"],
  ledger: ["ledger.operations"],
  domus: ["domus.home"],
  milo: ["milo.email"],
};

const AGENT_STATE_DEFAULTS: Record<string, { name: string; emoji: string; role: string }> = {
  max: { name: "Max", emoji: "🧭", role: "CEO Corner · Chief of Staff" },
  codex: { name: "Codex", emoji: "⚙️", role: "Privileged VPS Engineering Worker · Autonomous Execution" },
  atlas: { name: "Atlas", emoji: "🔭", role: "Technical Research · Evidence & Plans" },
  aegis: { name: "Aegis", emoji: "🛡️", role: "Cybersecurity · Authorized Defense" },
  milo: { name: "Milo", emoji: "📡", role: "Gmail Watcher · Important Alerts" },
  pulse: { name: "Pulse", emoji: "📣", role: "Social Media & YouTube Strategy" },
  ledger: { name: "Ledger", emoji: "🧰", role: "Operations & Continuity · Backups, Git, Health" },
  domus: { name: "Domus", emoji: "🏠", role: "Home Automation · Home Assistant & Alexa" },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as { action?: string; agentId?: string };
  const emergency = body.action === "emergency_reset";
  const agentId = body.action === "stop_agent" ? String(body.agentId || "") : "";
  if (!emergency && (!agentId || !AGENT_KINDS[agentId])) {
    return NextResponse.json({ error: "action must be stop_agent with a known agentId, or emergency_reset" }, { status: 400 });
  }

  const operationId = crypto.randomUUID();
  let cancelled = 0;
  let terminated = 0;
  let remainingRuntime = 0;
  const pausedAgents: string[] = [];
  const controlApprovalId = crypto.randomUUID();
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(${EMERGENCY_GATE_LOCK})
      ) SELECT TRUE AS locked FROM lock_acquired`;
      await tx.dataStore.upsert({
        where: { key: EMERGENCY_GATE_KEY },
        update: { data: { active: true, operationId, expiresAt: Date.now() + 30_000 } },
        create: { key: EMERGENCY_GATE_KEY, data: { active: true, operationId, expiresAt: Date.now() + 30_000 } },
      });
      const controlAction = emergency ? "emergency_reset" : "stop_agent";
      const parameters = JSON.stringify({ operationId, action: controlAction, agentId: emergency ? null : agentId, affectedStatuses: ACTIVE_STATUSES });
      await tx.$executeRawUnsafe(
        "INSERT INTO \"ActionApproval\" (id, request_id, action, status, requested_by, approved_by, decision, resolved_by, result, reason, created_at, resolved_at, expires_at, parameters_snapshot) VALUES ($1,$2,$3,'approved',$4,$4,'approved',$4,'control action completed','Confirmación humana registrada para el control de agentes',now(),now(),now() + interval '10 minutes',$5::jsonb)",
        controlApprovalId, "control:" + operationId, controlAction, auth.actor, parameters,
      );

      const where = emergency
        ? { status: { in: ACTIVE_STATUSES } }
        : { status: { in: ACTIVE_STATUSES }, kind: { in: AGENT_KINDS[agentId] } };
      const cancelError = emergency ? `Cancelled by Hermy HQ emergency reset (${operationId})` : `Cancelled by Hermy HQ stop control for ${agentId} (${operationId})`;
      const changed = await tx.agentRequest.updateMany({
        where,
        data: {
          status: "cancelled",
          error: cancelError,
          result: null,
          finishedAt: now,
          updatedAt: now,
        },
      });
      cancelled = changed.count;
      await tx.$executeRawUnsafe(
        'UPDATE "ActionApproval" SET status=\'rejected\', decision=\'rejected\', approved_by=NULL, rejected_by=$1, resolved_by=$1, result=\'cancelled; action not executed\', reason=$2, resolved_at=now() WHERE status IN (\'pending\',\'rejected\') AND request_id IN (SELECT id FROM "AgentRequest" WHERE status=\'cancelled\' AND error=$3)',
        auth.actor,
        emergency ? "Solicitud cancelada por parada de emergencia." : `Solicitud cancelada por parada de ${agentId}.`,
        cancelError,
      );

      const affectedAgents = emergency ? Object.keys(AGENT_KINDS) : [agentId];
      for (const id of affectedAgents) {
        const defaults = AGENT_STATE_DEFAULTS[id];
        if (!defaults) continue;
        const existingState = await tx.agentState.findUnique({ where: { id }, select: { status: true } });
        const status = existingState?.status === "paused" ? "paused" : "idle";
        if (status === "paused") pausedAgents.push(id);
        await tx.agentState.upsert({
          where: { id },
          update: { status, currentTask: null, lastActive: now, updatedAt: now },
          create: {
            id, ...defaults, status, currentTask: null, lastActive: now,
            tasksCompleted: 0, totalCost: 0,
            recentActivity: [{ timestamp: now.toISOString(), action: "Stopped and cleared by Hermy HQ" }],
          },
        });
      }
      await tx.agentEvent.create({
        data: {
          kind: "run",
          title: emergency ? "Emergency reset: all agent work cancelled" : `${agentId} emergency stop: assigned work cancelled`,
          detail: `${cancelled} active or queued request(s) marked cancelled; agents return to idle and available unless already paused.`,
          agent: emergency ? "hermes" : agentId,
          level: "warn",
          meta: { operationId, cancelled, emergency, approvalId: controlApprovalId, actor: auth.actor },
        },
      });
    });

    // Terminate the exact process groups registered by the bridge for this agent.
    const runtimeRows = await prisma.dataStore.findMany({ where: { key: { startsWith: "runtime-child:" } } });
    const runtime = runtimeRows
      .map((row) => ({ row, data: row.data as { agentId?: string; pid?: number; active?: boolean } }))
      .filter(({ data }) => data.active && (emergency || data.agentId === agentId) && Number.isInteger(data.pid));
    for (const { data } of runtime) {
      const pid = Number(data.pid);
      try { process.kill(-pid, "SIGTERM"); terminated += 1; } catch {}
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await sleep(2500);
    for (const { data } of runtime) {
      const pid = Number(data.pid);
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    // Wait until both OS processes and the bridge registry are clear.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(1000);
      const afterRuntime = await prisma.dataStore.findMany({ where: { key: { startsWith: "runtime-child:" } } });
      for (const row of afterRuntime) {
        const data = row.data as { agentId?: string; pid?: number; active?: boolean };
        if (!data.active || (!emergency && data.agentId !== agentId) || !Number.isInteger(data.pid)) continue;
        try { process.kill(Number(data.pid), 0); } catch { await prisma.dataStore.delete({ where: { key: row.key } }).catch(() => {}); }
      }
      const remaining = (await prisma.dataStore.findMany({ where: { key: { startsWith: "runtime-child:" } } })).filter((row) => {
        const data = row.data as { agentId?: string; active?: boolean };
        return data.active && (emergency || data.agentId === agentId);
      });
      if (!remaining.length) break;
    }
    const afterRuntime = await prisma.dataStore.findMany({ where: { key: { startsWith: "runtime-child:" } } });
    remainingRuntime = afterRuntime.filter((row) => {
      const data = row.data as { agentId?: string; active?: boolean };
      return data.active && (emergency || data.agentId === agentId);
    }).length;

    // Give workers' cancellation watchers time to finish before reopening intake.
    await sleep(500);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(${EMERGENCY_GATE_LOCK})
      ) SELECT TRUE AS locked FROM lock_acquired`;
      const gate = await tx.dataStore.findUnique({ where: { key: EMERGENCY_GATE_KEY } });
      const current = gate?.data as { operationId?: string } | undefined;
      if (current?.operationId === operationId) {
        await tx.dataStore.update({
          where: { key: EMERGENCY_GATE_KEY },
          data: { data: { active: false, operationId, expiresAt: 0 } },
        });
      }
    });
    return NextResponse.json({ ok: true, emergency, agentId: agentId || null, cancelled, terminated, remainingRuntime, workersAvailable: remainingRuntime === 0 && pausedAgents.length === 0, pausedAgents, approvalId: controlApprovalId, approvedBy: auth.actor });
  } catch (error) {
    console.error("Agent stop control failed:", error);
    return NextResponse.json({ error: "Could not complete agent stop control" }, { status: 500 });
  }
}
