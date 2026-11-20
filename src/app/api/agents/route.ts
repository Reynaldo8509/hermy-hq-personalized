import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { deriveAgentAvailability, effectiveLogicalAgentStatus, isRoutableAvailabilityState } from "@/lib/agent-availability.mjs";
import { deriveAgentWorkStatus } from "@/lib/agent-work-status.mjs";
import { agentForKind } from "@/lib/phase2-domain.mjs";
import { requestActor } from "@/lib/human-auth";
import { buildAgentRegistryView, buildLogicalAgentRuntimeContract } from "@/lib/agent-registry.mjs";
import { codexReadinessTaskVerified } from "@/lib/codex-readiness-marker.mjs";
import { MODEL_AFFINITY } from "@/lib/model-affinity.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const run = promisify(execFile);
const CODEX_PROVIDER_CAPACITY_DISPLAY_TTL_MS = 60_000;
type CodexProviderCapacity = "unknown" | "available" | "low" | "exhausted";
type AgentHealthResult = ReturnType<typeof deriveAgentAvailability> & {
  routeAvailable?: boolean;
  runtimeStatus?: string;
  recentExecutionVerified?: boolean;
  providerCapacity?: CodexProviderCapacity;
};

function isCodexProviderCapacity(value: unknown): value is CodexProviderCapacity {
  return value === "unknown" || value === "available" || value === "low" || value === "exhausted";
}

async function readCodexWorkerServiceHealthy() {
  try {
    const result = await run("systemctl", ["show", "--property=ActiveState,SubState", "--value", "codex-hermy-vps.service"], { timeout: 3000 });
    const [activeState, subState] = result.stdout.trim().split(/\s+/);
    return activeState === "active" && subState === "running";
  } catch {
    return false;
  }
}

function currentCodexProviderCapacity(value: unknown, now = Date.now()): CodexProviderCapacity {
  if (!value || typeof value !== "object") return "unknown";
  const snapshot = value as { state?: unknown; checked_at?: unknown };
  const checkedAt = typeof snapshot.checked_at === "string" ? Date.parse(snapshot.checked_at) : Number.NaN;
  if (!Number.isFinite(checkedAt) || now < checkedAt || now - checkedAt > CODEX_PROVIDER_CAPACITY_DISPLAY_TTL_MS) return "unknown";
  return isCodexProviderCapacity(snapshot.state) ? snapshot.state : "unknown";
}

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

async function readSharedRuntimeHeartbeat() {
  const heartbeatPath = process.env.HERMYHQ_GATEWAY_HEARTBEAT_PATH;
  if (!heartbeatPath) return { fresh: false, ageMs: null as number | null, lastSeenAt: null as string | null };
  try {
    const metadata = await stat(heartbeatPath);
    const ageMs = Date.now() - metadata.mtimeMs;
    return {
      fresh: ageMs >= 0 && ageMs <= 90_000,
      ageMs: Math.max(0, Math.round(ageMs)),
      lastSeenAt: new Date(metadata.mtimeMs).toISOString(),
    };
  } catch {
    return { fresh: false, ageMs: null as number | null, lastSeenAt: null as string | null };
  }
}

async function findLastVerifiedCodexTask() {
  const candidates = await prisma.agentRequest.findMany({
    where: { kind: "codex.audit", origin: "max", status: "done", sideEffecting: false, action: "audit", capability: "read_only" },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, kind: true, origin: true, status: true, sideEffecting: true, action: true, capability: true, result: true, updatedAt: true },
  });
  if (!candidates.length) return null;
  const attempts = await prisma.inferenceAttempt.findMany({
    where: { request_id: { in: candidates.map((task) => task.id) }, status: "success", provider: "openai", model: "codex" },
    select: { request_id: true, status: true, provider: true, model: true },
  });
  const byRequest = new Map(attempts.map((attempt) => [attempt.request_id, attempt]));
  return candidates.find((task) => codexReadinessTaskVerified(task, byRequest.get(task.id))) || null;
}

const routeLabel = (route: { requestedProvider?: string; provider?: string; model: string }) => `${route.requestedProvider || route.provider || "unknown"}/${route.model}`;
const AGENT_ROUTING: Record<string, { provider: string; model: string; selection: string }> = Object.fromEntries(
  DEFAULT_AGENTS.map(({ id }) => {
    const policy = MODEL_AFFINITY[id as keyof typeof MODEL_AFFINITY];
    const primary = policy.primary;
    const fallbacks = policy.fallbacks.map(routeLabel).join(" → ") || "none; fail closed";
    return [id, {
      provider: primary.requestedProvider || primary.provider || "unknown",
      model: primary.model,
      selection: `Primario: ${routeLabel(primary)}; fallback: ${fallbacks}; capacidades: ${policy.requiredCapabilities.join(", ")}; ${policy.freeOnly ? "solo rutas remotas free validadas" : "worker dedicado y fallback de inferencia free"}`,
    }];
  }),
);

export async function GET(request: Request) {
  const auth = await requestActor(request);
  if (auth.response) return auth.response;
  if (auth.actor === "hermes") {
    const [states, lastMaxExecution, runningMaxRequest, sharedRuntimeHeartbeat] = await Promise.all([
      prisma.agentState.findMany({
        select: { id: true, status: true, lastActive: true, currentTask: true },
      }),
      prisma.agentRequest.findFirst({
        where: {
          kind: { startsWith: "max." },
          origin: { not: "codex" },
          status: { in: ["done", "failed", "cancelled"] },
          startedAt: { not: null },
        },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true, finishedAt: true, updatedAt: true },
      }),
      prisma.agentRequest.findFirst({
        where: { kind: { startsWith: "max." }, origin: { not: "codex" }, status: "running" },
        select: { id: true },
      }),
      readSharedRuntimeHeartbeat(),
    ]);
    const maxState = states.find((state) => state.id === "max");
    const maxRuntimeContract = buildLogicalAgentRuntimeContract({
      recordedStatus: maxState?.status,
      currentTask: maxState?.currentTask,
      hasRunningRequest: Boolean(runningMaxRequest),
      sharedRuntimeHeartbeatFresh: sharedRuntimeHeartbeat.fresh,
      routeConfigured: Boolean(AGENT_ROUTING.max),
      runtimeHeartbeatAt: sharedRuntimeHeartbeat.lastSeenAt,
      lastSeen: maxState?.lastActive,
      lastExecution: lastMaxExecution,
    });
    const agents = buildAgentRegistryView(DEFAULT_AGENTS, states).map((agent) => (
      agent.id === "max" ? { ...agent, ...maxRuntimeContract } : agent
    ));
    return NextResponse.json(agents, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  }
  try {
    const [states, circuitRow, emergencyRow, lastSuccessfulCodexTask, recentRequests, sharedRuntimeHeartbeat, codexWorkerServiceHealthy, providerCapacityRow, lastMaxExecution, runningMaxRequest] = await Promise.all([
      prisma.agentState.findMany(),
      prisma.dataStore.findUnique({ where: { key: "codex-circuit" } }),
      prisma.dataStore.findUnique({ where: { key: "agent-emergency-gate" } }),
      findLastVerifiedCodexTask(),
      prisma.agentRequest.findMany({
        orderBy: { updatedAt: "desc" },
        take: 400,
        select: { id: true, origin: true, kind: true, title: true, status: true, result: true, error: true, prompt: true, sideEffecting: true, createdAt: true, updatedAt: true, startedAt: true, finishedAt: true, dependsOn: true },
      }),
      readSharedRuntimeHeartbeat(),
      readCodexWorkerServiceHealthy(),
      prisma.dataStore.findUnique({ where: { key: "codex-provider-capacity" } }),
      prisma.agentRequest.findFirst({
        where: {
          kind: { startsWith: "max." },
          origin: { not: "codex" },
          status: { in: ["done", "failed", "cancelled"] },
          startedAt: { not: null },
        },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true, finishedAt: true, updatedAt: true },
      }),
      prisma.agentRequest.findFirst({
        where: { kind: { startsWith: "max." }, origin: { not: "codex" }, status: "running" },
        select: { id: true },
      }),
    ]);
    const circuit = circuitRow?.data as { open?: boolean; activeAgent?: string; reason?: string; openedAt?: number; failoverAt?: number; nextProbeAt?: number; taskId?: string; taskTitle?: string; recoveredAt?: number; fallbackFailed?: boolean } | undefined;
    const emergency = emergencyRow?.data as { active?: boolean; expiresAt?: number } | undefined;
    const emergencyStopActive = emergency?.active === true && Number(emergency.expiresAt || 0) > Date.now();
    const lastSuccessfulTaskAt = lastSuccessfulCodexTask?.updatedAt?.toISOString() || null;
    const codexProviderCapacity = currentCodexProviderCapacity(providerCapacityRow?.data);
    const registryById = new Map(buildAgentRegistryView(DEFAULT_AGENTS, states).map((entry) => [entry.id, entry]));
    const stateMap: Record<string, any> = {};
    for (const s of states) stateMap[s.id] = s;

    const agents = DEFAULT_AGENTS.map((agent) => {
      const s = stateMap[agent.id] || {};
      const reportedStatus = s.status || "unknown";
      const maxHasRunningRequest = agent.id === "max" && Boolean(runningMaxRequest);
      const effectiveReportedStatus = effectiveLogicalAgentStatus(
        agent.id, reportedStatus, sharedRuntimeHeartbeat.fresh, maxHasRunningRequest,
      );
      const health: AgentHealthResult = deriveAgentAvailability({
        agentId: agent.id,
        reportedStatus: effectiveReportedStatus,
        lastActive: s.lastActive ? new Date(s.lastActive).toISOString() : null,
        lastSuccessfulTaskAt: agent.id === "codex" ? lastSuccessfulTaskAt : null,
        circuit,
        emergencyStopActive,
        codexWorkerServiceHealthy: agent.id === "codex" ? codexWorkerServiceHealthy : undefined,
        providerCapacity: agent.id === "codex" ? codexProviderCapacity : undefined,
        sharedRuntimeHeartbeatFresh: sharedRuntimeHeartbeat.fresh,
        sharedRuntimeHeartbeatAgeMs: sharedRuntimeHeartbeat.ageMs,
        routeConfigured: Boolean(AGENT_ROUTING[agent.id]),
        now: Date.now(),
      });
      const agentRequests = recentRequests.filter((request) => agentForKind(request.kind, request.origin) === agent.id);
      const summarizedRequests = agentRequests.map((request) => ({
        ...request,
        durationMs: request.startedAt ? Math.max(0, (request.finishedAt || new Date()).getTime() - request.startedAt.getTime()) : null,
        dependencies: Array.isArray(request.dependsOn) ? request.dependsOn : [],
      }));
      const lastDone = summarizedRequests.find((request) => request.status === "done" && request.result);
      const lastFailed = summarizedRequests.find((request) => request.status === "failed" && request.error);
      const activeRequests = summarizedRequests.filter((request) => ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation", "running"].includes(request.status));
      const workStatus = deriveAgentWorkStatus({
        healthStatus: health.status,
        currentTask: s.currentTask,
        hasRunningRequest: activeRequests.some((request) => request.status === "running"),
      });
      const delegations = summarizedRequests.filter((request) => request.origin === "max" && agent.id !== "max");
      const hasRunningRequest = agent.id === "max" ? Boolean(runningMaxRequest) : activeRequests.some((request) => request.status === "running");
      const maxRuntimeContract = agent.id === "max" ? buildLogicalAgentRuntimeContract({
        recordedStatus: reportedStatus,
        currentTask: s.currentTask,
        hasRunningRequest,
        sharedRuntimeHeartbeatFresh: sharedRuntimeHeartbeat.fresh,
        routeConfigured: Boolean(AGENT_ROUTING.max),
        runtimeHeartbeatAt: sharedRuntimeHeartbeat.lastSeenAt,
        lastSeen: s.lastActive,
        lastExecution: lastMaxExecution,
      }) : {};
      const registry = registryById.get(agent.id);
      const routeAvailable = agent.id === "codex" ? health.routeAvailable === true : isRoutableAvailabilityState(health.availability.state);
      const runtimeStatus = agent.id === "codex" ? routeAvailable ? (hasRunningRequest ? "running" : health.runtimeStatus) : "unavailable"
        : hasRunningRequest ? "running" : routeAvailable ? "idle" : "unavailable";
      return {
        ...agent,
        registered: registry?.registered === true,
        runtime_kind: registry?.runtime_kind || "unclassified",
        worker_unit: registry?.worker_unit || null,
        last_seen: registry?.last_seen || null,
        route_available: routeAvailable,
        runtime_status: runtimeStatus,
        recent_execution_verified: agent.id === "codex" ? health.recentExecutionVerified === true : null,
        provider_capacity: agent.id === "codex" ? health.providerCapacity : null,
        emoji: s.emoji || agent.emoji,
        status: workStatus,
        reportedStatus: health.reportedStatus,
        recordedStatus: reportedStatus,
        availability: health.availability,
        processState: health.processState,
        dependencyState: health.dependencyState,
        executionCapability: health.executionCapability,
        heartbeatAgeMs: health.heartbeatAgeMs,
        lastSuccessfulTaskAt: agent.id === "codex" ? lastSuccessfulTaskAt : null,
        currentTask: s.currentTask || undefined,
        lastActive: s.lastActive || undefined,
        activeTasks: activeRequests,
        history: summarizedRequests.slice(0, 30),
        lastResult: lastDone?.result || null,
        lastError: lastFailed?.error || null,
        delegations,
        executionDurationMs: summarizedRequests.find((request) => request.durationMs !== null)?.durationMs ?? null,
        tasksCompleted: s.tasksCompleted ?? agent.tasksCompleted,
        totalCost: s.totalCost ?? agent.totalCost,
        recentActivity: s.recentActivity || agent.recentActivity,
        ...(AGENT_ROUTING[agent.id] || {}),
        ...(agent.id === "codex" ? {
          runtimeProvider: circuit?.open ? (circuit.activeAgent === "codex-backup" ? "Qwen local (fallback)" : "No disponible") : "Codex/OpenAI (primario)",
          circuit,
        } : {}),
        ...maxRuntimeContract,
      };
    });

    return NextResponse.json(agents, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    console.error("Agents API error:", error);
    const registryById = new Map(buildAgentRegistryView(DEFAULT_AGENTS, []).map((entry) => [entry.id, entry]));
    const unavailable = DEFAULT_AGENTS.map((agent) => ({
      ...agent,
      registered: true,
      runtime_kind: registryById.get(agent.id)?.runtime_kind || "unclassified",
      worker_unit: registryById.get(agent.id)?.worker_unit || null,
      last_seen: null,
      route_available: false,
      runtime_status: "unavailable",
      recent_execution_verified: agent.id === "codex" ? false : null,
      provider_capacity: agent.id === "codex" ? "unknown" : null,
      status: "unknown",
      reportedStatus: "unknown",
      availability: { state: "unknown", label: "Estado sin verificar", reason: "No se pudo leer PostgreSQL." },
      processState: "unknown",
      dependencyState: "unknown",
      executionCapability: "unknown",
      activeTasks: [],
      history: [],
      lastResult: null,
      lastError: null,
      delegations: [],
      executionDurationMs: null,
    }));
    return NextResponse.json(unavailable, {
      status: 503,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  }
}

// POST to update agent state (called by cron jobs)
export async function POST(request: Request) {
  const auth = await requestActor(request, "internal:codex-worker");
  if (auth.response) return auth.response;
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

    const isInternalWorker = auth.actor === "internal:codex-worker";
    if (source === "worker" && !isInternalWorker) return NextResponse.json({ error: "El estado worker requiere autenticación de servicio" }, { status: 403 });
    if (isInternalWorker && (source !== "worker" || agentId !== "codex")) return NextResponse.json({ error: "El consumidor de servicio solo puede registrar el heartbeat de Codex" }, { status: 403 });
    if (["pause", "resume", "set_icon"].includes(String(action || "")) && isInternalWorker) {
      return NextResponse.json({ error: "El control de agentes requiere una sesión humana" }, { status: 403 });
    }

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
