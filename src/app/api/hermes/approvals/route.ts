import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { decideApprovalById } from "@/lib/approval-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const approvals = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT a.*, COALESCE(a.expires_at, a.created_at + interval '24 hours') AS expires_at, r.title, r.kind, r.prompt, r.status AS request_status FROM \"ActionApproval\" a LEFT JOIN \"AgentRequest\" r ON r.id=a.request_id WHERE a.status='pending' AND COALESCE(a.expires_at, a.created_at + interval '24 hours') > now() ORDER BY a.created_at ASC LIMIT 100"
  );
  const history = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT a.id, a.request_id, a.action, a.status, a.requested_by, a.approved_by, a.rejected_by, a.resolved_by, a.decision, a.approval_method, a.reason, a.result, a.incident_id, a.created_at, a.resolved_at, a.expires_at, r.title, r.status AS request_status FROM \"ActionApproval\" a LEFT JOIN \"AgentRequest\" r ON r.id=a.request_id WHERE a.status IN ('approved','rejected','expired','cancelled') ORDER BY a.resolved_at DESC NULLS LAST LIMIT 100"
  );
  return NextResponse.json({ approvals, history });
}

export async function PATCH(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = String(body.id || "").trim();
  const action = String(body.action || "");
  if (!id || !["approve", "reject"].includes(action)) return NextResponse.json({ error: "id y action approve|reject requeridos" }, { status: 400 });
  const result = await decideApprovalById(id, action as "approve" | "reject", auth.actor);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
