import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { recovered?: boolean; reason?: string; taskId?: string; taskTitle?: string };
  const now = Date.now();
  const existing = await prisma.dataStore.findUnique({ where: { key: "codex-circuit" } });
  const fallbackFailed = Boolean((existing?.data as { fallbackFailed?: boolean } | undefined)?.fallbackFailed);
  const data = body.recovered
    ? { open: false, activeAgent: "codex", recoveredAt: now, failoverAt: null, taskId: body.taskId || null, taskTitle: body.taskTitle || null, reason: null }
    : { open: true, activeAgent: fallbackFailed ? "hold" : "codex-backup", fallbackFailed, reason: String(body.reason || "Codex unavailable").slice(0, 500), openedAt: now, failoverAt: now, taskId: body.taskId || null, taskTitle: body.taskTitle || null, nextProbeAt: now + 30 * 60_000 };
  await prisma.dataStore.upsert({
    where: { key: "codex-circuit" }, update: { data }, create: { key: "codex-circuit", data },
  });
  await prisma.agentState.updateMany({
    where: { id: "codex" },
    data: { status: body.recovered ? "idle" : fallbackFailed ? "offline" : "idle", currentTask: null, updatedAt: new Date() },
  });
  return NextResponse.json({ ok: true, circuit: data });
}
