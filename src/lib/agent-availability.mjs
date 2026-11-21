export const CODEX_HEARTBEAT_TTL_MS = 45_000;
export const CODEX_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;

const ROUTABLE_AVAILABILITY_STATES = new Set(["available", "shared-runtime", "degraded"]);

export function isRoutableAvailabilityState(state) {
  return ROUTABLE_AVAILABILITY_STATES.has(String(state || ""));
}

export function effectiveLogicalAgentStatus(agentId, reportedStatus, sharedRuntimeHeartbeatFresh, hasRunningRequest) {
  if (agentId === "max" && reportedStatus === "error" && sharedRuntimeHeartbeatFresh === true && hasRunningRequest !== true) return "idle";
  return String(reportedStatus || "unknown");
}

function ageMs(timestamp, now) {
  if (!timestamp) return null;
  const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const age = now - parsed;
  return age < 0 ? null : age;
}

/**
 * @param {{
 *   agentId: string,
 *   reportedStatus?: string | null,
 *   lastActive?: string | Date | null,
 *   lastSuccessfulTaskAt?: string | Date | null,
 *   now?: number,
 *   circuit?: { open?: boolean; activeAgent?: string } | null,
 *   emergencyStopActive?: boolean,
 *   codexWorkerServiceHealthy?: boolean,
 *   providerCapacity?: "available"|"low"|"exhausted"|"unknown",
 *   sharedRuntimeHeartbeatFresh?: boolean,
 *   sharedRuntimeHeartbeatAgeMs?: number | null,
 *   routeConfigured?: boolean
 * }} input
 */
export function deriveAgentAvailability(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const reportedStatus = String(input.reportedStatus || "unknown");
  const heartbeatAgeMs = ageMs(input.lastActive instanceof Date ? input.lastActive.toISOString() : input.lastActive, now);
  const successAgeMs = ageMs(input.lastSuccessfulTaskAt instanceof Date ? input.lastSuccessfulTaskAt.toISOString() : input.lastSuccessfulTaskAt, now);
  const codexHeartbeatFresh = input.agentId === "codex" && heartbeatAgeMs !== null && heartbeatAgeMs <= CODEX_HEARTBEAT_TTL_MS;
  const codexExecutionVerified = input.agentId === "codex" && successAgeMs !== null && successAgeMs <= CODEX_SUCCESS_TTL_MS;
  const providerCapacity = ["available", "low", "exhausted", "unknown"].includes(input.providerCapacity) ? input.providerCapacity : "unknown";

  if (reportedStatus === "paused") {
    return {
      status: "paused",
      reportedStatus,
      availability: { state: "paused", label: "Pausado administrativamente", reason: "La pausa prevalece sobre el estado del proceso." },
      processState: input.agentId === "codex" && codexHeartbeatFresh ? "running" : "unknown",
      dependencyState: "not-verified",
      executionCapability: "blocked",
      heartbeatAgeMs,
      ...(input.agentId === "codex" ? { routeAvailable: false, runtimeStatus: "unavailable", recentExecutionVerified: codexExecutionVerified, providerCapacity } : {}),
    };
  }

  if (input.agentId !== "codex") {
    if (input.sharedRuntimeHeartbeatFresh === true && input.routeConfigured === true) {
      return {
        status: ["error", "offline"].includes(reportedStatus) ? reportedStatus : "idle",
        reportedStatus,
        availability: {
          state: "shared-runtime",
          label: "Ruta disponible por Hermes compartido",
          reason: "Heartbeat reciente del gateway y ruta configurada; este agente es una persona lógica, no un proceso independiente.",
        },
        processState: "shared-runtime",
        dependencyState: "gateway-heartbeat-fresh",
        executionCapability: "routable-via-shared-runtime",
        heartbeatAgeMs,
        sharedRuntimeHeartbeatAgeMs: input.sharedRuntimeHeartbeatAgeMs ?? null,
      };
    }
    const freshWork = reportedStatus === "working" && heartbeatAgeMs !== null && heartbeatAgeMs <= CODEX_HEARTBEAT_TTL_MS;
    const status = !input.lastActive && reportedStatus !== "error" ? "unknown"
      : heartbeatAgeMs === null && !["error", "offline"].includes(reportedStatus) ? "unknown"
      : heartbeatAgeMs !== null && heartbeatAgeMs > CODEX_HEARTBEAT_TTL_MS && !["error", "offline"].includes(reportedStatus) ? "unknown"
      : reportedStatus;
    return {
      status: freshWork ? "working" : status,
      reportedStatus,
      availability: {
        state: freshWork ? "executing-unverified" : "unknown",
        label: freshWork ? "Ejecución registrada; proceso no monitorizado" : "Disponibilidad no comprobada",
        reason: "Este agente no tiene heartbeat de proceso independiente.",
      },
      processState: "not-monitored",
      dependencyState: "not-probed",
      executionCapability: freshWork ? "unverified" : "unknown",
      heartbeatAgeMs,
    };
  }

  if (input.codexWorkerServiceHealthy !== true) {
    return {
      status: "offline",
      reportedStatus,
      availability: { state: "unavailable", label: "Servicio Codex no disponible", reason: "codex-hermy-vps.service no está active/running." },
      processState: "unavailable",
      dependencyState: "unverified",
      executionCapability: "unavailable",
      heartbeatAgeMs,
      routeAvailable: false,
      runtimeStatus: "unavailable",
      recentExecutionVerified: codexExecutionVerified,
      providerCapacity,
    };
  }

  if (!codexHeartbeatFresh) {
    return {
      status: "offline",
      reportedStatus,
      availability: { state: "unavailable", label: "Worker sin heartbeat vigente", reason: "No hay heartbeat Codex dentro de 45 segundos." },
      processState: "stale",
      dependencyState: "unverified",
      executionCapability: "unverified",
      heartbeatAgeMs,
      routeAvailable: false,
      runtimeStatus: "unavailable",
      recentExecutionVerified: codexExecutionVerified,
      providerCapacity,
    };
  }

  if (input.emergencyStopActive) {
    return {
      status: reportedStatus,
      reportedStatus,
      availability: { state: "blocked", label: "Bloqueado por parada de emergencia", reason: "La parada administrativa impide aceptar tareas." },
      processState: "running",
      dependencyState: "reachable",
      executionCapability: "blocked",
      heartbeatAgeMs,
      routeAvailable: false,
      runtimeStatus: "unavailable",
      recentExecutionVerified: codexExecutionVerified,
      providerCapacity,
    };
  }

  if (input.circuit && input.circuit.open) {
    return {
      status: reportedStatus,
      reportedStatus,
      availability: { state: "unavailable", label: "Worker bloqueado por el circuito", reason: String(input.circuit.activeAgent || "sin agente activo") },
      processState: "running",
      dependencyState: "reachable",
      executionCapability: "blocked",
      heartbeatAgeMs,
      routeAvailable: false,
      runtimeStatus: "unavailable",
      recentExecutionVerified: codexExecutionVerified,
      providerCapacity,
    };
  }

  return {
    status: reportedStatus,
    reportedStatus,
    availability: {
      state: "available",
      label: codexExecutionVerified ? "Worker disponible; ejecución reciente verificada" : "Worker disponible; ejecución reciente no verificada",
      reason: "Servicio active/running, heartbeat vigente y circuito cerrado; la evidencia de ejecución es independiente.",
    },
    processState: "running",
    dependencyState: "reachable",
    executionCapability: codexExecutionVerified ? "verified" : "unverified",
    heartbeatAgeMs,
    routeAvailable: true,
    runtimeStatus: ["working", "running"].includes(reportedStatus) ? "running" : "idle",
    recentExecutionVerified: codexExecutionVerified,
    providerCapacity,
  };
}
