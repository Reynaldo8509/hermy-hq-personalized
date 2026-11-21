import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { decideAgentRequest, editAgentRequest } from "@/lib/approval-control";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await prisma.agentRequest.findUnique({ where: { id } });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  const events = await prisma.agentEvent.findMany({ where: { createdAt: { gte: new Date(Date.now() - 90 * 86400000) } }, orderBy: { createdAt: "desc" }, take: 500 });
  const activity = events.filter((event) => (event.meta as Record<string, unknown> | null)?.requestId === id).slice(0, 30);
  return NextResponse.json({ request, activity });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  if (action === "edit") {
    const title = String(body.title || "").trim().slice(0, 200);
    const prompt = String(body.prompt || "").trim().slice(0, 12000);
    if (!title || !prompt) return NextResponse.json({ error: "Título e instrucciones requeridos" }, { status: 400 });
    const result = await editAgentRequest(id, title, prompt, auth.actor);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  }
  if (action !== "approve" && action !== "reject") return NextResponse.json({ error: "action must be approve|reject|edit" }, { status: 400 });
  const result = await decideAgentRequest(id, action, auth.actor);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
