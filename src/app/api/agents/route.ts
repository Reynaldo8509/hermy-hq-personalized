import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Default agent roster
const DEFAULT_AGENTS = [
  {
    id: "max",
    name: "Max",
    emoji: "🧭",
    role: "CEO Corner \u00B7 Chief of Staff",
    status: "online",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  {
    id: "codex",
    name: "Codex",
    emoji: "⚙️",
    role: "Privileged VPS Engineering Worker \u00B7 Autonomous Execution",
    status: "offline",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  {
    id: "atlas",
    name: "Atlas",
    emoji: "🔭",
    role: "Technical Research \u00B7 Evidence & Plans",
    status: "idle",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  {
    id: "aegis",
    name: "Aegis",
    emoji: "🛡️",
    role: "Cybersecurity \u00B7 Authorized Defense",
    status: "idle",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  {
    id: "milo",
    name: "Milo",
    emoji: "📡",
    role: "Gmail Watcher · Important Alerts",
    status: "offline",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  {
    id: "pulse",
    name: "Pulse",
    emoji: "📣",
    role: "Social Media & YouTube Strategy",
    status: "idle",
    tasksCompleted: 0,
    totalCost: 0,
    recentActivity: [],
  },
  { id: "ledger", name: "Ledger", emoji: "🧰", role: "Operations & Continuity · Backups, Git, Health", status: "idle", tasksCompleted: 0, totalCost: 0, recentActivity: [] },
  { id: "domus", name: "Domus", emoji: "🏠", role: "Home Automation · Home Assistant & Alexa", status: "idle", tasksCompleted: 0, totalCost: 0, recentActivity: [] },
];

const RESUME_STATUS: Record<string, string> = {
  max: "online",
  codex: "offline",
  atlas: "idle",
  aegis: "idle",
  milo: "idle",
  pulse: "idle",
  ledger: "idle",
  domus: "idle",
};

const AGENT_ROUTING: Record<string, { provider: string; model: string; selection: string }> = {
  max: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local" },
  codex: { provider: "Codex/OpenAI", model: "Codex (modelo OpenAI configurado)", selection: "Primario: Codex/OpenAI; fallback: Qwen local" },
  atlas: { provider: "custom", model: "custom:tokenharbor:deepseek-v4.1-flash:free", selection: "Token Harbor para análisis profundo; Qwen local para tareas breves" },
  aegis: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local" },
  milo: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local" },
  pulse: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local" },
  ledger: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local" },
  domus: { provider: "custom", model: "qwen3-8b-local", selection: "Qwen local; análisis cloud auxiliar según la ruta" },
};

export async function GET() {
  try {
    const [states, circuitRow] = await Promise.all([
      prisma.agentState.findMany(),
      prisma.dataStore.findUnique({ where: { key: "codex-circuit" } }),
    ]);
    const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string; reason?: string; openedAt?: number; failoverAt?: number; nextProbeAt?: number; taskId?: string; taskTitle?: string; recoveredAt?: number; fallbackFailed?: boolean } | undefined;
    const stateMap: Record<string, any> = {};
    for (const s of states) {
      stateMap[s.id] = s;
    }

    const agents = DEFAULT_AGENTS.map((agent) => {
      const s = stateMap[agent.id] || {};
      const codexHeartbeatExpired = agent.id === "codex" && s.status === "online" &&
        (!s.lastActive || Date.now() - new Date(s.lastActive).getTime() > 45_000);
      return {
        ...agent,
        emoji: s.emoji || agent.emoji,
        status: codexHeartbeatExpired ? "offline" : s.status || agent.status,
        currentTask: s.currentTask || undefined,
        lastActive: s.lastActive || undefined,
        tasksCompleted: s.tasksCompleted || agent.tasksCompleted,
        totalCost: s.totalCost || agent.totalCost,
        recentActivity: s.recentActivity || agent.recentActivity,
        ...(AGENT_ROUTING[agent.id] || {}),
        ...(agent.id === "codex" ? { runtimeProvider: circuit?.open ? (circuit.activeAgent === "codex-backup" ? "Qwen local (fallback)" : "No disponible") : "Codex/OpenAI (primario)", circuit } : {}),
      };
    });

    return NextResponse.json(agents, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    console.error("Agents API error:", error);
    return NextResponse.json(DEFAULT_AGENTS, { status: 200 });
  }
}

// POST to update agent state (called by cron jobs)
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { agentId, action, status, currentTask, source, emoji } = body;

    if (!agentId) {
      return NextResponse.json({ error: "agentId required" }, { status: 400 });
    }

    // Find the default agent info for name/emoji/role
    const defaultAgent = DEFAULT_AGENTS.find((a) => a.id === agentId);
    if (!defaultAgent) {
      return NextResponse.json({ error: "unknown agent" }, { status: 404 });
    }

    // Get existing state or create defaults
    let existing = await prisma.agentState.findUnique({ where: { id: agentId } });

    // A background worker must never wake an agent the user deliberately paused.
    if (source === "worker" && existing?.status === "paused") {
      return NextResponse.json({ ok: true, agent: existing });
    }

    if (action === "pause" || action === "resume") {
      const now = new Date();
      const paused = action === "pause";
      const recentActivity = (existing?.recentActivity as any[]) || [];
      const controlAction = paused
        ? "Paused: new work will remain in the queue"
        : "Resumed: new work may be claimed";
      const updatedState = await prisma.agentState.upsert({
        where: { id: agentId },
        update: {
          status: paused ? "paused" : (RESUME_STATUS[agentId] || "idle"),
          currentTask: paused ? null : existing?.currentTask || null,
          lastActive: now,
          recentActivity: [{ timestamp: now.toISOString(), action: controlAction }, ...recentActivity.slice(0, 19)],
        },
        create: {
          id: defaultAgent.id,
          name: defaultAgent.name,
          emoji: defaultAgent.emoji,
          role: defaultAgent.role,
          status: paused ? "paused" : (RESUME_STATUS[agentId] || "idle"),
          currentTask: null,
          lastActive: now,
          tasksCompleted: 0,
          totalCost: 0,
          recentActivity: [{ timestamp: now.toISOString(), action: controlAction }],
        },
      });
      return NextResponse.json({ ok: true, agent: updatedState });
    }

    if (action === "set_icon") {
      const icon = typeof emoji === "string" ? Array.from(emoji.trim()).slice(0, 8).join("") : "";
      if (!icon) return NextResponse.json({ error: "emoji required" }, { status: 400 });
      const updatedState = await prisma.agentState.upsert({
        where: { id: agentId },
        update: { emoji: icon, lastActive: new Date() },
        create: { ...defaultAgent, emoji: icon, status: defaultAgent.status, currentTask: null, lastActive: new Date(), tasksCompleted: 0, totalCost: 0, recentActivity: [] },
      });
      return NextResponse.json({ ok: true, agent: updatedState });
    }

    const recentActivity = (existing?.recentActivity as any[]) || [];
    const newRecentActivity = action
      ? [
          { timestamp: new Date().toISOString(), action },
          ...recentActivity.slice(0, 19),
        ]
      : recentActivity;

    const updatedState = await prisma.agentState.upsert({
      where: { id: agentId },
      update: {
        ...(status ? { status } : {}),
        ...(currentTask !== undefined ? { currentTask } : {}),
        lastActive: new Date(),
        ...(action
          ? {
              recentActivity: newRecentActivity,
              tasksCompleted: (existing?.tasksCompleted || 0) + 1,
            }
          : {}),
      },
      create: {
        id: agentId,
        name: defaultAgent?.name || agentId,
        emoji: defaultAgent?.emoji,
        role: defaultAgent?.role,
        status: status || "idle",
        currentTask: currentTask || null,
        lastActive: new Date(),
        tasksCompleted: action ? 1 : 0,
        totalCost: 0,
        recentActivity: newRecentActivity,
      },
    });

    return NextResponse.json({ ok: true, agent: updatedState });
  } catch (error) {
    console.error("Agent update error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
