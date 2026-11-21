import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE_MAX = 50;
const COLUMNS = `id, fingerprint, incident, evidence, cause, hypothesis, remediation, validation, limitations, next_action, provider, model, duration_ms, invalid_duration_ms, cause_confirmed, status, agent, request_id, created_at, updated_at, closed_at,
  (SELECT count(*)::int FROM "InferenceAttempt" a WHERE a.request_id = "IncidentMemory".request_id) AS attempt_count,
  CASE WHEN "IncidentMemory".request_id IS NULL THEN NULL ELSE COALESCE((SELECT bool_or(a.attempt_no > 1) FROM "InferenceAttempt" a WHERE a.request_id = "IncidentMemory".request_id), false) END AS has_fallback`;

function encodeCursor(row: Record<string, unknown>) {
  const updatedAt = new Date(String(row.updated_at));
  return Buffer.from(`${updatedAt.toISOString()}\n${String(row.id)}`).toString("base64url");
}

export async function GET(request: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("take") || 20);
  const take = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), PAGE_SIZE_MAX) : 20;
  const token = url.searchParams.get("cursor");
  let cursorAt: string | null = null;
  let cursorId = "";
  if (token) {
    try {
      const decoded = Buffer.from(token, "base64url").toString("utf8");
      const split = decoded.indexOf("\n");
      if (split < 0) throw new Error("invalid cursor");
      cursorAt = decoded.slice(0, split);
      cursorId = decoded.slice(split + 1);
      if (!Number.isFinite(Date.parse(cursorAt)) || !cursorId || cursorId.length > 200) throw new Error("invalid cursor");
    } catch {
      return NextResponse.json({ error: "Cursor de historial inválido" }, { status: 400 });
    }
  }

  const rows = cursorAt
    ? await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT ${COLUMNS} FROM "IncidentMemory" WHERE (updated_at,id) < ($1::timestamp,$2::text) ORDER BY updated_at DESC,id DESC LIMIT $3`,
        cursorAt, cursorId, take + 1,
      )
    : await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT ${COLUMNS} FROM "IncidentMemory" ORDER BY updated_at DESC,id DESC LIMIT $1`, take + 1,
      );
  const hasMore = rows.length > take;
  const records = rows.slice(0, take);
  const safeRecords = records.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value instanceof Date ? value.toISOString() : value,
  ])));
  return NextResponse.json({
    records: safeRecords,
    nextCursor: hasMore && records.length ? encodeCursor(records[records.length - 1]) : null,
    hasMore,
    pageSize: take,
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
