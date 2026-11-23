import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { agentForKind, dependenciesAreDone, groupIncidentRows } from "@/lib/phase2-domain.mjs";
import { requireHumanActor } from "@/lib/human-auth";
import { humanFacingMcpApproval } from "@/lib/mcp-restart-approval.mjs";

export const dynamic = "force-dynamic";

function jsonSafe(value: any): any {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  try {
    const [incidentRows, incidentStatsRows, requests, approvals, alerts, failureRows] = await Promise.all([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, fingerprint, incident, evidence, cause, hypothesis, remediation, validation, limitations, next_action, provider, model, duration_ms, invalid_duration_ms, cause_confirmed, status, agent, request_id, created_at, updated_at, closed_at FROM "IncidentMemory" WHERE status NOT IN ('resolved','closed') AND updated_at >= now() - interval '7 days' ORDER BY updated_at DESC LIMIT 100`
      ),
      prisma.$queryRawUnsafe<Array<{ open24h: bigint; blocked7d: bigint; staleUnresolved: bigint }>>(
        `SELECT COUNT(*) FILTER (WHERE status='open' AND updated_at >= now() - interval '24 hours')::bigint AS "open24h", COUNT(*) FILTER (WHERE status='blocked' AND updated_at >= now() - interval '7 days')::bigint AS "blocked7d", COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed') AND updated_at < now() - interval '7 days')::bigint AS "staleUnresolved" FROM "IncidentMemory"`
      ),
      prisma.agentRequest.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }, orderBy: { updatedAt: "desc" }, take: 150 }),
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT a.id, a.request_id, a.action, a.status, a.requested_by, a.approved_by, a.rejected_by, a.resolved_by, a.decision, a.reason, a.result, a.incident_id, a.created_at, a.resolved_at, COALESCE(a.expires_at, a.created_at + interval '24 hours') AS expires_at, a.parameters_snapshot, r.title, r.kind, r.prompt, r.status AS request_status FROM "ActionApproval" a LEFT JOIN "AgentRequest" r ON r.id=a.request_id WHERE a.status='pending' AND COALESCE(a.expires_at, a.created_at + interval '24 hours') > now() ORDER BY a.created_at ASC LIMIT 100`
      ),
      prisma.agentEvent.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600000) }, OR: [{ kind: "alert" }, { level: "down" }] },
        orderBy: { createdAt: "desc" }, take: 100,
      }),
      prisma.$queryRawUnsafe<Array<{ status: string; classification: string; total: bigint }>>(
        "SELECT status, CASE WHEN error ILIKE '%SIGTERM%' OR error ILIKE '%Cancelled by operator%' THEN 'cancelled-or-shutdown' WHEN error ILIKE '%format%' OR error ILIKE '%contract%' OR error ILIKE '%JSON%' THEN 'output-format-or-contract' WHEN error ILIKE '%session storage could not be written%' THEN 'session-storage' WHEN error ILIKE '%request is not defined%' THEN 'runtime-code-error' WHEN error ~* '401|unauthorized|invalid.{0,20}key' THEN 'authentication' WHEN error ~* '429|rate.?limit|quota' THEN 'quota-or-rate-limit' WHEN error ~* 'timeout|timed out|ETIMEDOUT' THEN 'timeout' WHEN error ~* 'ECONN|network|fetch failed|DNS|ENOTFOUND' THEN 'network' ELSE 'needs-review' END AS classification, count(*)::bigint AS total FROM \"AgentRequest\" WHERE status IN ('failed','rejected') GROUP BY status, classification ORDER BY status, classification",
      ),
    ]);

    const safeApprovals = approvals.map(humanFacingMcpApproval);
    const safeRows = incidentRows.map(jsonSafe);
    const incidents = groupIncidentRows(safeRows);
    const dependencyIds = [...new Set(requests.flatMap((row) => Array.isArray(row.dependsOn) ? row.dependsOn.map(String) : []))];
    const dependencyRows = dependencyIds.length ? await prisma.agentRequest.findMany({
      where: { id: { in: dependencyIds } }, select: { id: true, title: true, status: true, result: true, error: true },
    }) : [];
    const dependencyMap = new Map(dependencyRows.map((row) => [row.id, row]));
    const tasks = requests.map((row) => {
      const dependencies = Array.isArray(row.dependsOn) ? row.dependsOn.map((id) => dependencyMap.get(String(id)) || { id: String(id), status: "missing" }) : [];
      const ids = dependencies.map((item) => String(item.id));
      const blockedByDependencies = ids.length > 0 && !dependenciesAreDone(ids, dependencyMap);
      const durationMs = row.startedAt ? Math.max(0, (row.finishedAt || new Date()).getTime() - row.startedAt.getTime()) : null;
      return {
        ...row, agentId: agentForKind(row.kind, row.origin), dependencies,
        blockedByDependencies, durationMs,
        needsIntervention: ["awaiting_approval", "awaiting_destructive_confirmation", "failed"].includes(row.status) || blockedByDependencies,
      };
    });
    const activeTasks = tasks.filter((task) => ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation", "running"].includes(task.status));
    const repairResults = tasks.filter((task) => ["done", "failed"].includes(task.status)).slice(0, 30);
    const failureSummary = {
      totalFailed: failureRows.filter((row) => row.status === "failed").reduce((sum, row) => sum + Number(row.total), 0),
      totalRejected: failureRows.filter((row) => row.status === "rejected").reduce((sum, row) => sum + Number(row.total), 0),
      classes: failureRows.map((row) => ({ status: row.status, classification: row.classification, total: Number(row.total) })),
    };

    return NextResponse.json({
      syncedAt: new Date().toISOString(),
      counts: {
        incidents: incidents.length,
        incidentsOpen24h: Number(incidentStatsRows[0]?.open24h || 0),
        blockedIncidents7d: Number(incidentStatsRows[0]?.blocked7d || 0),
        staleUnresolvedIncidents: Number(incidentStatsRows[0]?.staleUnresolved || 0),
        duplicateIncidentRows: safeRows.length - incidents.length,
        interventionTasks: tasks.filter((task) => task.needsIntervention).length,
        approvals: approvals.length,
        inactiveWorkers: null,
        alerts24h: alerts.length,
        repairResults: repairResults.length,
      },
      windows: { incidents: "7 days; unresolved only", tasks: "30 days", alerts: "24 hours; alert/down events only" },
      incidents: jsonSafe(incidents),
      tasks: jsonSafe(tasks),
      activeTasks: jsonSafe(activeTasks),
      approvals: jsonSafe(safeApprovals),
      alerts: jsonSafe(alerts),
      repairResults: jsonSafe(repairResults),
      failureSummary,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("Action Center API error:", error);
    return NextResponse.json({ error: "No se pudo cargar el centro operativo" }, { status: 502 });
  }
}
