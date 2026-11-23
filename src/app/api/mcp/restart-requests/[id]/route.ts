import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  MCP_RESTART_APPROVAL_ACTION,
  MCP_RESTART_PRINCIPAL,
  MCP_RESTART_UNIT,
  publicMcpRestartStatus,
} from "@/lib/mcp-restart-approval.mjs";
import { authorizeMcpRestartRequest } from "@/lib/mcp-restart-service-auth.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authorizeMcpRestartRequest(
    request.method,
    request.url,
    request.headers.get("x-mcp-restart-token"),
  );
  const privateHeaders = { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" };
  if (auth.status !== 200) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: privateHeaders });
  }

  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
  }

  const rows = await prisma.$queryRaw<Array<{
    id: string; request_id: string; action: string; status: string; requested_by: string;
    approved_by: string | null; created_at: Date | null; expires_at: Date | null;
    parameters_snapshot: Record<string, unknown>;
  }>>`
    SELECT id, request_id, action, status, requested_by, approved_by,
      created_at AT TIME ZONE current_setting('TimeZone') AS created_at,
      expires_at AT TIME ZONE current_setting('TimeZone') AS expires_at,
      parameters_snapshot
    FROM "ActionApproval"
    WHERE id = ${id} AND request_id = ${id} AND action = ${MCP_RESTART_APPROVAL_ACTION}
      AND requested_by = ${MCP_RESTART_PRINCIPAL}
      AND parameters_snapshot->>'contract' = 'mcp_restart_v2'
      AND parameters_snapshot->>'unit' = ${MCP_RESTART_UNIT}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
  const status = publicMcpRestartStatus(row, new Date());
  if (!status) return NextResponse.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
  return NextResponse.json(status, { headers: privateHeaders });
}
