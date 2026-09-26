import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type MiloState = {
  initialized?: boolean;
  processedIds?: string[];
  lastCheckedAt?: string;
  lastAlertCount?: number;
};

function internal(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  return Boolean(secret && secret === process.env.INTERNAL_API_SECRET);
}

export async function POST(request: NextRequest) {
  if (!internal(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const previous = await prisma.dataStore.findUnique({ where: { key: "milo-gmail-state" } });
  const old = (previous?.data || {}) as MiloState;
  const processedIds = Array.isArray(body.processedIds)
    ? body.processedIds.filter((entry): entry is string => typeof entry === "string").slice(-500)
    : old.processedIds || [];
  const checkedAt = new Date().toISOString();
  const alertCount = Math.max(0, Number(body.alertCount || 0));
  const workerStatus = typeof body.status === "string" ? body.status : "idle";
  const action = String(body.action || "Gmail reviewed").slice(0, 200);
  const currentTask = typeof body.currentTask === "string" ? body.currentTask.slice(0, 200) : null;
  const now = new Date();
  const existingAgent = await prisma.agentState.findUnique({ where: { id: "milo" } });
  if (existingAgent?.status === "paused") return NextResponse.json({ ok: true, paused: true });
  const recent = (existingAgent?.recentActivity as Array<{ timestamp: string; action: string }>) || [];

  await prisma.$transaction([
    prisma.dataStore.upsert({
      where: { key: "milo-gmail-state" },
      update: { data: { ...old, initialized: body.initialized !== false, processedIds, lastCheckedAt: checkedAt, lastAlertCount: alertCount } },
      create: { key: "milo-gmail-state", data: { initialized: body.initialized !== false, processedIds, lastCheckedAt: checkedAt, lastAlertCount: alertCount } },
    }),
    prisma.agentState.upsert({
      where: { id: "milo" },
      update: {
        status: workerStatus,
        currentTask,
        lastActive: now,
        tasksCompleted: (existingAgent?.tasksCompleted || 0) + Math.max(0, Number(body.processedCount || 0)),
        recentActivity: [{ timestamp: checkedAt, action }, ...recent.slice(0, 19)],
      },
      create: {
        id: "milo", name: "Milo", emoji: "📬", role: "Gmail Watcher · Important Alerts",
        status: workerStatus, currentTask, lastActive: now,
        tasksCompleted: Math.max(0, Number(body.processedCount || 0)), totalCost: 0,
        recentActivity: [{ timestamp: checkedAt, action }],
      },
    }),
    prisma.agentEvent.create({
      data: {
        kind: "run", title: `Milo: ${action}`, agent: "milo",
        level: workerStatus === "error" ? "down" : alertCount ? "warn" : "info",
        meta: { processedCount: Number(body.processedCount || 0), alertCount },
      },
    }),
  ]);
  return NextResponse.json({ ok: true });
}
