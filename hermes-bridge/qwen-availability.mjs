export const QWEN_AVAILABILITY = Object.freeze({
  UNKNOWN: "QWEN_UNKNOWN",
  AVAILABLE: "QWEN_AVAILABLE",
  UNAVAILABLE: "QWEN_UNAVAILABLE",
});
export const QWEN_HEALTH_INTERVAL_MS = 15_000;
export const QWEN_HEALTH_TIMEOUT_MS = 2_500;
export const QWEN_FAILURE_THRESHOLD = 2;
export const QWEN_RECOVERY_THRESHOLD = 2;

export function initialQwenAvailability(now = Date.now()) {
  return Object.freeze({
    status: QWEN_AVAILABILITY.UNKNOWN,
    available: false,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    checkedAt: null,
    validUntil: null,
    reason: "awaiting_health_probe",
  });
}

export function normalizeQwenAvailability(state, now = Date.now()) {
  const status = Object.values(QWEN_AVAILABILITY).includes(state?.status)
    ? state.status : QWEN_AVAILABILITY.UNKNOWN;
  const checkedAt = Number.isFinite(Number(state?.checkedAt)) ? Number(state.checkedAt) : null;
  const validUntil = typeof state?.validUntil === "number" && Number.isFinite(state.validUntil) ? state.validUntil : null;
  return Object.freeze({
    status,
    available: status === QWEN_AVAILABILITY.AVAILABLE,
    consecutiveFailures: Math.max(0, Number(state?.consecutiveFailures) || 0),
    consecutiveSuccesses: Math.max(0, Number(state?.consecutiveSuccesses) || 0),
    checkedAt,
    validUntil,
    reason: typeof state?.reason === "string" ? state.reason : null,
  });
}

export function transitionQwenAvailability(state, probeSucceeded, now = Date.now()) {
  const current = normalizeQwenAvailability(state, now);
  const consecutiveFailures = probeSucceeded ? 0 : current.consecutiveFailures + 1;
  const consecutiveSuccesses = probeSucceeded ? current.consecutiveSuccesses + 1 : 0;
  let status = current.status;
  if (probeSucceeded) {
    if (current.status === QWEN_AVAILABILITY.AVAILABLE
        || consecutiveSuccesses >= QWEN_RECOVERY_THRESHOLD) status = QWEN_AVAILABILITY.AVAILABLE;
  } else if (consecutiveFailures >= QWEN_FAILURE_THRESHOLD) {
    status = QWEN_AVAILABILITY.UNAVAILABLE;
  }
  return Object.freeze({
    status,
    available: status === QWEN_AVAILABILITY.AVAILABLE,
    consecutiveFailures,
    consecutiveSuccesses,
    checkedAt: Number(now),
    validUntil: Number(now) + QWEN_HEALTH_INTERVAL_MS * 2,
    reason: probeSucceeded ? (status === QWEN_AVAILABILITY.AVAILABLE ? null : "recovery_hysteresis")
      : (status === QWEN_AVAILABILITY.UNAVAILABLE ? "health_probe_failed" : "failure_hysteresis"),
  });
}

// Request-scoped fault injection for authenticated internal read-only E2E only.
// It never mutates the monitor cache or the process-wide Qwen state.
export function qwenAvailabilityTestOverride(mode, now = Date.now()) {
  if (mode === "qwen_unknown" || mode === "remote_free_qwen_unknown") {
    return Object.freeze({
      state: initialQwenAvailability(now),
      transitionTrace: Object.freeze([QWEN_AVAILABILITY.UNKNOWN]),
    });
  }
  const unavailableFromAvailable = () => {
    let state = Object.freeze({
      status: QWEN_AVAILABILITY.AVAILABLE, available: true,
      consecutiveFailures: 0, consecutiveSuccesses: QWEN_RECOVERY_THRESHOLD,
      checkedAt: Number(now) - 1, validUntil: Number(now) + QWEN_HEALTH_INTERVAL_MS * 2,
      reason: "authorized_test_initial_available",
    });
    const trace = [];
    for (let failure = 1; failure <= QWEN_FAILURE_THRESHOLD; failure += 1) {
      state = transitionQwenAvailability(state, false, Number(now) + failure);
      trace.push(`${state.status};failures=${state.consecutiveFailures}`);
    }
    return { state, trace };
  };
  if (mode === "qwen_unavailable" || mode === "remote_free_qwen_unavailable"
      || mode === "remote_free_failover_qwen_unavailable"
      || mode === "prefer_local_failover_qwen_unavailable"
      || mode === "mimo_e2e_qwen_unavailable") {
    const result = unavailableFromAvailable();
    return Object.freeze({ state: result.state, transitionTrace: Object.freeze(result.trace) });
  }
  if (mode === "qwen_recovery") {
    const failed = unavailableFromAvailable();
    let state = transitionQwenAvailability(failed.state, true, Number(now) + QWEN_FAILURE_THRESHOLD + 1);
    const trace = [`${failed.state.status};successes=0`, `${state.status};successes=${state.consecutiveSuccesses}`];
    if (state.status !== QWEN_AVAILABILITY.UNAVAILABLE) throw new Error("qwen_recovery_hysteresis_invalid");
    state = transitionQwenAvailability(state, true, Number(now) + QWEN_FAILURE_THRESHOLD + 2);
    trace.push(`${state.status};successes=${state.consecutiveSuccesses}`);
    if (state.status !== QWEN_AVAILABILITY.AVAILABLE) throw new Error("qwen_recovery_hysteresis_invalid");
    return Object.freeze({ state, transitionTrace: Object.freeze(trace) });
  }
  return null;
}

export function qwenModelsResponseAvailable(response, model = "qwen3-8b-local") {
  if (!response || response.ok !== true) return false;
  const models = Array.isArray(response.body?.data) ? response.body.data
    : Array.isArray(response.body?.models) ? response.body.models : [];
  return models.some((entry) => entry && String(entry.id || entry.name || "") === model);
}

export function isQwenConnectivityFailure(error) {
  const text = [error?.code, error?.name, error?.message, error?.stderr, error?.stdout]
    .filter(Boolean).join(" ");
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|AbortError|fetch failed/i.test(text);
}
