import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  await prisma.$executeRaw`UPDATE "ActionApproval" SET status='expired', resolved_at=now() WHERE status='pending' AND created_at < ${new Date(Date.now()-24*60*60*1000)}`;
  const approvals = await prisma.$queryRaw`SELECT a.*, r.title, r.kind, r.prompt, r.status AS request_status FROM "ActionApproval" a LEFT JOIN "AgentRequest" r ON r.id=a.request_id WHERE a.status='pending' ORDER BY a.created_at ASC LIMIT 100`;
  return NextResponse.json({ approvals });
}

export async function PATCH(req: Request) {
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  const action = String(b.action || "");
  if (!id || !["approve","reject"].includes(action)) return NextResponse.json({ error: "id and action approve|reject required" }, { status: 400 });
  const status = action === "approve" ? "approved" : "rejected";
  const rows = await prisma.$queryRaw<Array<{request_id:string}>>`SELECT request_id FROM "ActionApproval" WHERE id=${id} AND status='pending' LIMIT 1`;
  if (!rows.length) return NextResponse.json({ error: "approval not pending" }, { status: 409 });
  const requestId = rows[0].request_id;
  await prisma.$executeRaw`UPDATE "ActionApproval" SET status=${status}, approved_by='hermy-hq', resolved_at=now() WHERE id=${id} AND status='pending'`;
  await prisma.agentRequest.update({ where: { id: requestId }, data: { status: status === "approved" ? "approved" : "rejected", decidedAt: new Date() } });
  return NextResponse.json({ id, requestId, status });
}
