import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  createMcpRestartApproval,
  MCP_RESTART_APPROVAL_ACTION,
  MCP_RESTART_PRINCIPAL,
  MCP_RESTART_UNIT,
  readBoundedJson,
  validateMcpRestartBody,
} from "@/lib/mcp-restart-approval.mjs";
import { authorizeMcpRestartRequest } from "@/lib/mcp-restart-service-auth.mjs";

export const dynamic = "force-dynamic";

function authorization(request: Request) {
  return authorizeMcpRestartRequest(
    request.method,
    request.url,
    request.headers.get("x-mcp-restart-token"),
  );
}

type ExistingRestartApproval = {
  id: string; request_id: string; action: string; status: string; requested_by: string;
  parameters_snapshot: Record<string, unknown>; created_at: Date; expires_at: Date;
};

function prismaRestartStore(tx: Prisma.TransactionClient) {
  return {
    async lock() {
      // Prisma cannot deserialize PostgreSQL's `void` result; project a scalar
      // while retaining the transaction-scoped advisory lock side effect.
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(7302026, 1)) AS lock_guard`;
    },
    async findPending(unit: string) {
      const rows = await tx.$queryRaw<ExistingRestartApproval[]>`
        SELECT id, request_id, action, status, requested_by, parameters_snapshot,
          -- Normalize timestamp-without-time-zone columns before Prisma parses Dates.
          created_at AT TIME ZONE current_setting('TimeZone') AS created_at,
          expires_at AT TIME ZONE current_setting('TimeZone') AS expires_at
        FROM "ActionApproval"
        WHERE id = request_id AND action = ${MCP_RESTART_APPROVAL_ACTION}
          AND requested_by = ${MCP_RESTART_PRINCIPAL} AND status = 'pending'
          AND expires_at > now() AND expires_at <= created_at + interval '30 minutes'
          AND parameters_snapshot->>'contract' = 'mcp_restart_v2'
          AND parameters_snapshot->>'unit' = ${unit}
        ORDER BY created_at DESC LIMIT 1`;
      return rows[0] || null;
    },
    async countRecent(requester: string) {
      const rows = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM "ActionApproval"
        WHERE action = ${MCP_RESTART_APPROVAL_ACTION} AND requested_by = ${requester}
          AND created_at > now() - interval '1 hour'`;
      return Number(rows[0]?.count ?? 0);
    },
    async createApproval(data: { requestId: string; snapshot: Record<string, unknown>; action: string; requester: string }) {
      const { requestId, snapshot, action, requester } = data;
      if (action !== MCP_RESTART_APPROVAL_ACTION || requester !== MCP_RESTART_PRINCIPAL ||
          !/^[a-f0-9]{40}$/.test(requestId) || snapshot.requestId !== requestId ||
          snapshot.unit !== MCP_RESTART_UNIT) throw new Error("approval_action_not_allowed");
      const rows = await tx.$queryRaw<Array<{ expires_at: Date }>>`
        INSERT INTO "ActionApproval"
          (id,request_id,action,status,requested_by,approved_by,rejected_by,resolved_by,decision,
           reason,created_at,resolved_at,expires_at,parameters_snapshot)
        VALUES (${requestId},${requestId},${action},'pending',
          ${requester},NULL,NULL,NULL,NULL,
          'Single-unit MCP restart; independent human approval required',now(),NULL,
          now() + interval '30 minutes',${JSON.stringify(snapshot)}::jsonb)
        RETURNING expires_at AT TIME ZONE current_setting('TimeZone') AS expires_at`;
      if (!rows.length) throw new Error("approval_expiry_not_set");
      return rows[0].expires_at;
    },
    async writeAudit(data: { requestId: string; expiresAt: Date }) {
      await tx.agentEvent.create({
        data: {
          kind: "approval",
          title: "Solicitud MCP de reinicio pendiente de aprobación humana",
          detail: `Unidad: ${MCP_RESTART_UNIT}; solicitud: ${data.requestId}`,
          agent: "mcp-service-control",
          level: "warn",
          meta: { requestId: data.requestId, unit: MCP_RESTART_UNIT, operation: "restart",
            requester: MCP_RESTART_PRINCIPAL, state: "PENDING", expiresAt: data.expiresAt.toISOString() },
        },
      });
    },
  };
}

export async function POST(request: Request) {
  const auth = authorization(request);
  const privateHeaders = { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" };
  if (auth.status !== 200) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: privateHeaders });
  const parsed = await readBoundedJson(request);
  if (parsed.error) {
    const status = parsed.error === "request_body_too_large" ? 413 : 400;
    return NextResponse.json({ error: parsed.error }, { status, headers: privateHeaders });
  }
  if (!validateMcpRestartBody(parsed.value)) {
    return NextResponse.json({ error: "only the approved restart operation and unit are accepted" }, { status: 400, headers: privateHeaders });
  }

  const nonce = randomBytes(32).toString("base64url");
  const requestId = randomBytes(20).toString("hex");
  try {
    const result = await prisma.$transaction((tx) => createMcpRestartApproval({
      store: prismaRestartStore(tx), requestId, nonce,
    }));

    if ("rateLimited" in result && result.rateLimited) {
      return NextResponse.json({ error: "restart_request_rate_limited" }, { status: 429, headers: privateHeaders });
    }
    // The nonce remains in the protected ActionApproval row for safe POST retries.
    // Human-facing approval/status routes redact it; the adapter stores only its hash.
    return NextResponse.json({
      requestId: result.requestId,
      unit: MCP_RESTART_UNIT,
      operation: "restart",
      status: "PENDING",
      expiresAt: result.expiresAt.toISOString(),
      duplicate: result.duplicate,
      nonce: result.nonce,
    }, { status: result.duplicate ? 200 : 201, headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "restart_request_not_created" }, { status: 500, headers: privateHeaders });
  }
}
