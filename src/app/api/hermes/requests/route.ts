import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const expiry = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.$executeRaw`UPDATE "ActionApproval" SET status='expired', resolved_at=now() WHERE status='pending' AND created_at < ${expiry}`;
  await prisma.$executeRaw`UPDATE "AgentRequest" SET status='rejected', error='Approval expired', "updatedAt"=now() WHERE id IN (SELECT request_id FROM "ActionApproval" WHERE status='expired') AND status='awaiting_approval'`;
  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // e.g. "awaiting_approval"
  const take = Math.min(Number(url.searchParams.get("take") || 50), 200);
  const where = status ? { status: { in: status.split(",") } } : {};
  const requests = await prisma.agentRequest.findMany({
    where, orderBy: { createdAt: "desc" }, take,
  });
  const pending = await prisma.agentRequest.count({ where: { status: "awaiting_approval" } });
  return NextResponse.json({ requests, pending });
}
