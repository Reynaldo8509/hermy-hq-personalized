import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { agentForKind } from "@/lib/phase2-domain.mjs";
import { normalizeOperationalSnapshot, summarizeRequestCounts } from "@/lib/command-center-domain.mjs";
import { readHomeAssistantStatus } from "@/lib/home-assistant-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const ACTIVE_STATES = ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation", "running"];
const INTERVENTION_STATES = ["awaiting_approval", "awaiting_destructive_confirmation"];

function clip(value: string | null, limit: number) {
  return value ? value.slice(0, limit) : null;
}

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;

  try {
    const now = new Date();
    const [stores, groupedRequests, activeRequests, failedTasks, interventionTasks, approvals, incidents, alertCount, events, homeAssistant] = await Promise.all([
      prisma.dataStore.findMany({
        where: { key: { in: ["hermes-health", "hermyhq-infrastructure-v1"] } },
        select: { key: true, data: true },
      }),
      prisma.agentRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.agentRequest.findMany({
        where: { status: { in: ACTIVE_STATES } }, orderBy: { updatedAt: "desc" }, take: 8,
        select: { id: true, kind: true, origin: true, title: true, status: true, createdAt: true, startedAt: true, updatedAt: true },
      }),
      prisma.agentRequest.count({ where: { status: "failed", updatedAt: { gte: new Date(now.getTime() - 30 * 86400000) } } }),
      prisma.agentRequest.count({ where: { status: { in: INTERVENTION_STATES }, updatedAt: { gte: new Date(now.getTime() - 30 * 86400000) } } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "ActionApproval" WHERE status='pending' AND COALESCE(expires_at, created_at + interval '24 hours') > now()`,
      prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "IncidentMemory" WHERE status='open' AND updated_at >= now() - interval '7 days'`,
      prisma.agentEvent.count({ where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, OR: [{ kind: "alert" }, { level: "down" }] } }),
      prisma.agentEvent.findMany({
        where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, OR: [{ kind: "alert" }, { level: "down" }] },
        orderBy: { createdAt: "desc" }, take: 6,
        select: { id: true, kind: true, title: true, agent: true, level: true, createdAt: true },
      }),
      readHomeAssistantStatus(),
    ]);

    const storeByKey = new Map(stores.map((row) => [row.key, row.data]));
    const operational = normalizeOperationalSnapshot({
      health: storeByKey.get("hermes-health"),
      infrastructure: storeByKey.get("hermyhq-infrastructure-v1"),
      now: now.getTime(),
    });
    const requestsByStatus = summarizeRequestCounts(groupedRequests.map((row) => ({ status: row.status, count: row._count._all })));
    const json = (value: bigint | number) => Number(value);

    return NextResponse.json({
      generatedAt: now.toISOString(),
      operational,
      homeAssistant,
      counts: {
        activeRequests: ACTIVE_STATES.reduce((total, state) => total + (requestsByStatus[state] || 0), 0),
        runningRequests: requestsByStatus.running || 0,
        failedTasks,
        interventionTasks,
        pendingApprovals: json(approvals[0]?.count || 0),
        openIncidents: json(incidents[0]?.count || 0),
        alerts24h: alertCount,
      },
      activeRequests: activeRequests.map((request) => ({
        id: request.id,
        agent: agentForKind(request.kind, request.origin),
        title: clip(request.title, 180),
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        startedAt: request.startedAt?.toISOString() || null,
        updatedAt: request.updatedAt.toISOString(),
      })),
      windows: { failedTasks: "30 days", interventionTasks: "30 days", openIncidents: "7 days", alerts: "24 hours; alert/down events only" },
      recentEvents: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        title: clip(event.title, 180),
        agent: clip(event.agent, 32),
        level: event.level,
        createdAt: event.createdAt.toISOString(),
      })),
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Command Center summary unavailable:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "No se pudo cargar el resumen operativo. Revisa la conexión con Hermy HQ e inténtalo de nuevo." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
