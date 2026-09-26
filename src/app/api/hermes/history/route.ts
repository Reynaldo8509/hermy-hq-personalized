import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
    SELECT a.id, a.request_id, a.action, a.status, a.requested_by, a.approved_by,
           a.reason, a.created_at, a.resolved_at,
           a.created_at + interval '24 hours' AS expires_at,
           r.title, r.kind, r.status AS request_status, r.result AS request_result,
           r.error AS request_error
    FROM "ActionApproval" a
    LEFT JOIN "AgentRequest" r ON r.id = a.request_id
    ORDER BY COALESCE(a.resolved_at, a.created_at) DESC
    LIMIT ${take}`;
  const incidents = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, fingerprint, incident, evidence, cause, hypothesis, remediation,
           validation, limitations, next_action, provider, model, duration_ms, status, agent, request_id,
           created_at, updated_at, closed_at
    FROM "IncidentMemory"
    ORDER BY updated_at DESC
    LIMIT ${take}`;
  const attempts = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, request_id, attempt_no, provider, model, status, reason,
           duration_ms, created_at, finished_at
    FROM "InferenceAttempt"
    ORDER BY created_at DESC
    LIMIT ${take * 2}`;
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
