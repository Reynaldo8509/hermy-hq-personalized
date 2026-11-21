import { MODEL_AFFINITY } from "./model-affinity.mjs";

const AGENT_RUNTIME = Object.freeze({
  max: { kind: "logical_orchestrator", workerUnit: null },
  codex: { kind: "dedicated_worker", workerUnit: "codex-hermy-vps.service" },
  atlas: { kind: "shared_hermes_runtime", workerUnit: null },
  aegis: { kind: "shared_hermes_runtime", workerUnit: null },
  milo: { kind: "scheduled_worker", workerUnit: "milo-mail.timer" },
  pulse: { kind: "shared_hermes_runtime", workerUnit: null },
  ledger: { kind: "shared_hermes_runtime", workerUnit: null },
  domus: { kind: "shared_hermes_runtime", workerUnit: null },
});

const routeLabel = (route) => `${route.requestedProvider || route.provider}/${route.model}`;

function isoTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

/**
 * Build the MAX work, runtime, route, and execution fields independently.
 * route_available means the shared Hermes gateway heartbeat is fresh and the
 * centrally configured provider/model route exists; provider health is not
 * directly probed by this endpoint.
 * @param {{
 *   recordedStatus?: string | null,
 *   currentTask?: string | null,
 *   hasRunningRequest?: boolean,
 *   sharedRuntimeHeartbeatFresh?: boolean,
 *   routeConfigured?: boolean,
 *   runtimeHeartbeatAt?: Date | string | null,
 *   lastSeen?: Date | string | null,
 *   lastExecution?: { id?: string; status?: string; startedAt?: Date | string | null; finishedAt?: Date | string | null; updatedAt?: Date | string | null } | null
 * }} input
 */
export function buildLogicalAgentRuntimeContract(input) {
  const recordedStatus = String(input.recordedStatus || "unknown");
  const paused = recordedStatus === "paused";
  const routeAvailable = !paused
    && input.sharedRuntimeHeartbeatFresh === true
    && input.routeConfigured === true;
  const hasRunningRequest = input.hasRunningRequest === true;
  const doingWork = hasRunningRequest || Boolean(input.currentTask);
  const executionAt = input.lastExecution
    ? isoTimestamp(input.lastExecution.finishedAt)
      || isoTimestamp(input.lastExecution.startedAt)
      || isoTimestamp(input.lastExecution.updatedAt)
    : null;

  return {
    status: paused ? "paused" : doingWork ? "working" : "idle",
    recorded_status: recordedStatus,
    route_available: routeAvailable,
    runtime_status: routeAvailable ? (hasRunningRequest ? "running" : "idle") : "unavailable",
    last_execution_id: typeof input.lastExecution?.id === "string" ? input.lastExecution.id : null,
    last_execution_status: typeof input.lastExecution?.status === "string" ? input.lastExecution.status : "none",
    last_execution_at: executionAt,
    last_seen: isoTimestamp(input.lastSeen),
    last_seen_source: "AgentState.lastActive",
    runtime_heartbeat_at: isoTimestamp(input.runtimeHeartbeatAt),
    runtime_heartbeat_source: "gateway_heartbeat_file_mtime",
    provider_route_configured: input.routeConfigured === true,
    provider_route_health: "unknown",
  };
}

/**
 * @param {Array<{ id: string; name: string; role: string }>} roster
 * @param {Array<{ id: string; status?: string; lastActive?: Date | string | null }>} states
 */
export function buildAgentRegistryView(roster, states) {
  const stateById = new Map((Array.isArray(states) ? states : []).map((state) => [state.id, state]));
  return roster.map(({ id, name, role }) => {
    const state = stateById.get(id);
    const runtime = AGENT_RUNTIME[id] || { kind: "unclassified", workerUnit: null };
    const policy = MODEL_AFFINITY[id] || MODEL_AFFINITY.hermes_normal;
    const primary = policy.primary;
    const fallbacks = policy.fallbacks.map(routeLabel);
    const lastActive = state?.lastActive instanceof Date ? state.lastActive.toISOString() : typeof state?.lastActive === "string" ? state.lastActive : null;
    return {
      id,
      name,
      role,
      registered: true,
      registry_source: "logical_agent_roster",
      runtime_kind: runtime.kind,
      worker_unit: runtime.workerUnit,
      worker: runtime.workerUnit,
      provider_policy: primary.requestedProvider || primary.provider,
      model_policy: primary.model,
      fallback_policy: fallbacks.join(" → ") || "none; fail closed",
      required_capabilities: [...policy.requiredCapabilities],
      local_optional: policy.localOptional,
      free_only: policy.freeOnly,
      policy_validation: policy.freeOnly ? "central allowlisted route policy; actual route proven per inference attempt"
        : "dedicated Codex worker only; no substitute model fallback",
      can_delegate: id === "max",
      approval_policy: "human approval required for sensitive side effects",
      status: typeof state?.status === "string" ? state.status : "unknown",
      lastActive,
      last_seen: lastActive,
    };
  });
}
