import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { agentForKind } from "@/lib/phase2-domain.mjs";
import { classifyInferenceRecord, classifyProviderRoute } from "@/lib/inference-observability.mjs";

export const dynamic = "force-dynamic";

function jsonSafe(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value,
  ]));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const take = Math.min(Math.max(Number(url.searchParams.get("take") || 50), 1), 100);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const status = (url.searchParams.get("status") || "").trim().toLowerCase();
  const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
  const provider = (url.searchParams.get("provider") || "").trim().toLowerCase();
  const approvals = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT a.id, a.request_id, a.action, a.status, a.requested_by, a.approved_by, a.rejected_by, a.resolved_by, a.decision, a.result, a.incident_id,
           a.reason, a.created_at, a.resolved_at,
           COALESCE(a.expires_at, a.created_at + interval '24 hours') AS expires_at,
           r.title, r.kind, r.status AS request_status, r.result AS request_result,
           r.error AS request_error
    FROM "ActionApproval" a
    LEFT JOIN "AgentRequest" r ON r.id = a.request_id
    ORDER BY COALESCE(a.resolved_at, a.created_at) DESC
    LIMIT ${take}`;
  const incidents = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, fingerprint, incident, evidence, cause, hypothesis, remediation,
           validation, limitations, next_action, provider, model, duration_ms, invalid_duration_ms, cause_confirmed, status, agent, request_id,
           created_at, updated_at, closed_at
    FROM "IncidentMemory"
    ORDER BY updated_at DESC
    LIMIT ${take}`;
  const attemptRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT i.id, i.request_id, i.attempt_no, i.attempt_number, i.provider, i.model,
           i.requested_provider, i.requested_model, i.gateway, i.actual_provider, i.actual_model, i.underlying_provider,
           i.status, i.reason, i.error_class, i.failover_reason, i.cost_source, i.route_cost_policy, i.duration_ms, i.started_at,
           i.prompt_tokens, i.uncached_prompt_tokens, i.completion_tokens, i.total_tokens, i.reasoning_tokens,
           i.cache_read_tokens, i.cache_write_tokens, i.api_calls, i.auxiliary_total_tokens,
           i.total_including_auxiliary_tokens, i.usage_scope, i.usage_source, i.http_status, i.reported_cost,
           i.cost_currency, i.cost_status, i.free_route, i.remote_attempted, i.remote_attempt_status, i.created_at, i.finished_at,
           r.kind AS request_kind, r.origin AS request_origin, r.status AS request_status
    FROM "InferenceAttempt" i
    LEFT JOIN "AgentRequest" r ON r.id=i.request_id
    ORDER BY i.created_at DESC
    LIMIT ${take * 2}`;
  const attempts = attemptRows.map((raw) => {
    const row = jsonSafe(raw);
    const kind = typeof row.request_kind === "string" ? row.request_kind : null;
    const origin = typeof row.request_origin === "string" ? row.request_origin : "";
    const agentId = kind ? agentForKind(kind, origin) : "unattributed";
    return {
      ...row,
      agent_id: agentId,
      agent: agentId,
      telemetry_class: classifyInferenceRecord(row),
      route_category: classifyProviderRoute(row),
    };
  });
  const includes = (row: Record<string, unknown>) => {
    const haystack = Object.values(row).filter((value) => typeof value === "string").join(" ").toLowerCase();
    return (!query || haystack.includes(query))
      && (!status || String(row.status || "").toLowerCase() === status)
      && (!agent || String(row.agent || "").toLowerCase() === agent)
      && (!provider || String(row.provider || "").toLowerCase() === provider);
  };
  return NextResponse.json({
    filters: { q: query, status, agent, provider },
    approvals: approvals.map(jsonSafe).filter(includes),
    incidents: incidents.map(jsonSafe).filter(includes),
    attempts: attempts.map(jsonSafe).filter(includes),
  });
}
