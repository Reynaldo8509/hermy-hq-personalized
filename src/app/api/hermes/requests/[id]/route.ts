import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await prisma.agentRequest.findUnique({ where: { id } });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ request });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const action = (b.action || "").toString(); // approve | reject | edit
  const existing = await prisma.agentRequest.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "awaiting_destructive_confirmation" && action !== "reject") return NextResponse.json({ error: "destructive task requires explicit AUTORIZO confirmation through the Codex gate" }, { status: 409 });
  if (!["awaiting_approval", "awaiting_destructive_confirmation", "queued"].includes(existing.status))
    return NextResponse.json({ error: `cannot decide a ${existing.status} request` }, { status: 409 });

  const data: Record<string, unknown> = { decidedAt: new Date() };
  if (action === "approve") data.status = "approved";
  else if (action === "reject") data.status = "rejected";
  else if (action === "edit") { data.status = "approved"; if (b.prompt) data.prompt = b.prompt.toString(); if (b.title) data.title = b.title.toString().slice(0, 200); }
  else return NextResponse.json({ error: "action must be approve|reject|edit" }, { status: 400 });

  const row = await prisma.agentRequest.update({ where: { id }, data });
  if (action === "reject") {
    const agentId = row.kind === "codex.engineering" ? "codex"
      : row.kind === "aegis.security" ? "aegis"
      : null;
    if (agentId) {
      await prisma.agentState.updateMany({
        where: { id: agentId },
        data: { status: "idle", currentTask: null, lastActive: new Date() },
      });
    }
  }
  return NextResponse.json({ request: row });
}
