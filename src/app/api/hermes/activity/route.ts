import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const take = Math.min(Number(new URL(req.url).searchParams.get("take") || 40), 100);
  const events = await prisma.agentEvent.findMany({ orderBy: { createdAt: "desc" }, take });
  // Run events carry their originating request id. Prefer the canonical full
  // result/error from AgentRequest so older events are no longer displayed as
  // misleading 400-character previews.
  const requestIds = events
    .filter((event) => event.kind === "run" && event.meta && typeof event.meta === "object" && "requestId" in event.meta)
    .map((event) => String((event.meta as Record<string, unknown>).requestId));
  const requests = requestIds.length
    ? await prisma.agentRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, result: true, error: true } })
    : [];
  const byId = new Map(requests.map((request) => [request.id, request]));
  const enriched = events.map((event) => {
    const requestId = event.meta && typeof event.meta === "object" && "requestId" in event.meta
      ? String((event.meta as Record<string, unknown>).requestId) : "";
    const request = byId.get(requestId);
    return request ? { ...event, detail: request.result || request.error || event.detail } : event;
  });
  return NextResponse.json({ events: enriched });
}
