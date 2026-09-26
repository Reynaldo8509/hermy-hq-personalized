import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { EMERGENCY_GATE_KEY, EMERGENCY_GATE_LOCK } from "@/lib/agent-dispatch";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation", "running"];
const AGENT_KINDS: Record<string, string[]> = {
  max: ["max.chief-of-staff", "max.deep-analysis"],
  codex: ["codex.engineering"],
  atlas: ["atlas.research"],
  aegis: ["aegis.security"],
  pulse: ["pulse.social"],
  ledger: ["ledger.operations"],
  domus: ["domus.home"],
  milo: ["milo.email"],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request) {
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

      const where = emergency
        ? { status: { in: ACTIVE_STATUSES } }
        : { status: { in: ACTIVE_STATUSES }, kind: { in: AGENT_KINDS[agentId] } };
      const changed = await tx.agentRequest.updateMany({
        where,
        data: {
          status: "cancelled",
          error: emergency ? "Cancelled by Hermy HQ emergency reset" : `Cancelled by Hermy HQ stop control for ${agentId}`,
          result: null,
          finishedAt: now,
          updatedAt: now,
        },
      });
      cancelled = changed.count;

      const breaker = await tx.dataStore.findUnique({ where: { key: "codex-circuit" } });
      const circuitOpen = Boolean((breaker?.data as { open?: boolean } | null)?.open);
      const affectedAgents = emergency ? Object.keys(AGENT_KINDS) : [agentId];
      const stateIds = circuitOpen ? affectedAgents.filter((id) => id !== "codex") : affectedAgents;
      await tx.agentState.updateMany({
        where: { id: { in: stateIds } },
        data: { status: "idle", currentTask: null, lastActive: now, updatedAt: now },
      });
      await tx.agentEvent.create({
        data: {
          kind: "run",
          title: emergency ? "Emergency reset: all agent work cancelled" : `${agentId} emergency stop: assigned work cancelled`,
          detail: `${cancelled} active or queued request(s) marked cancelled; workers remain available.`,
          agent: emergency ? "hermes" : agentId,
          level: "warn",
          meta: { operationId, cancelled, emergency },
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
    return NextResponse.json({ ok: true, emergency, agentId: agentId || null, cancelled, terminated, remainingRuntime, workersAvailable: remainingRuntime === 0 });
  } catch (error) {
    console.error("Agent stop control failed:", error);
    return NextResponse.json({ error: "Could not complete agent stop control" }, { status: 500 });
  }
}
