const TASKS = new Set(["analysis_only", "code_generation", "structured_tools", "restricted_execution", "privileged_execution"]);
export function codexUnavailableRoute({ taskClass = "analysis_only", capacity = "unknown", workerHealthy = false, requestedBy = "agent" } = {}) {
  const task = TASKS.has(taskClass) ? taskClass : "analysis_only";
  const ownerNeedsDecision = requestedBy === "owner" && capacity === "unknown" && task !== "privileged_execution";
  const deferred = true;
  const providerLimit = capacity === "exhausted";
  return {
    status: ownerNeedsDecision ? "NEEDS_OWNER_OVERRIDE" : deferred ? "CODEX_DEFERRED_EXECUTION" : providerLimit ? "EXTERNAL_PROVIDER_LIMIT" : "codex_unavailable",
    reason: providerLimit ? "EXTERNAL_PROVIDER_LIMIT" : capacity === "unknown" ? "provider_capacity_unknown" : "worker_unavailable",
    provider_capacity: capacity,
    worker_healthy: workerHealthy,
    fallback_executor: null,
    fallback_model: null,
    fallback_scope: task === "code_generation" ? "proposal_only_no_execution_when_dedicated_worker_available"
      : ownerNeedsDecision ? "owner_decision_required_before_retry" : "dedicated_codex_worker_only",
    degraded: true,
    execution_deferred: deferred,
    required_capability: task,
    reset_at: null,
  };
}
