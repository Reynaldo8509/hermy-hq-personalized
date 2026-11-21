import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requestActor } from "@/lib/human-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requestActor(req);
  if (auth.response) return auth.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const take = Math.min(Math.max(Number(url.searchParams.get("take") || 50), 1), 200);
  const where = status ? { status: { in: status.split(",") } } : {};
  const requests = await prisma.agentRequest.findMany({ where, orderBy: { createdAt: "desc" }, take });
  const pending = await prisma.agentRequest.count({ where: { status: "awaiting_approval" } });
  return NextResponse.json({ requests, pending });
}
