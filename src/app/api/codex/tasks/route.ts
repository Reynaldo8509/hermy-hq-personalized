import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isEmergencyStopActive } from "@/lib/agent-dispatch";

const CODEX_KINDS = ["codex.audit", "codex.change"];
const TASK_STATUSES = new Set([
  "queued",
  "awaiting_approval",
  "awaiting_destructive_confirmation",
  "approved",
  "running",
  "done",
  "failed",
  "rejected",
]);

export const dynamic = "force-dynamic";

// GET /api/codex/tasks?status=queued,approved&take=1
export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedStatus = url.searchParams.get("status");
  const statuses = requestedStatus && requestedStatus !== "all"
    ? requestedStatus.split(",").filter((status) => TASK_STATUSES.has(status))
    : [];
  const take = Math.min(Math.max(Number(url.searchParams.get("take") || 50), 1), 100);
  const [emergency, circuitRow] = await Promise.all([
    isEmergencyStopActive(),
    prisma.dataStore.findUnique({ where: { key: "codex-circuit" } }),
  ]);
  const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string; nextProbeAt?: number; reason?: string } | undefined;
  const backupReady = circuit?.open && (circuit.activeAgent === "codex-backup" || !circuit.activeAgent);
  const tasks = emergency || (circuit?.open && !backupReady) ? [] : await prisma.agentRequest.findMany({
    where: {
      kind: { in: CODEX_KINDS },
      origin: "max",
      prompt: { contains: "delegación exclusiva de Max" },
      ...(statuses.length ? { status: { in: statuses } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take,
  });
  return NextResponse.json({ tasks, circuit: circuit || { open: false }, emergency, processor: circuit?.open ? "codex-backup" : "codex" });
}

export async function POST() {
  return NextResponse.json(
    { error: "La creación directa está deshabilitada; Max debe justificar y delegar las tareas de Codex" },
    { status: 403 },
  );
}
