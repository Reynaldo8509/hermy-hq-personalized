/**
 * Derive workload status independently from worker health. Health remains available
 * as a separate field so an idle worker can still report offline/error accurately.
 * @param {{ healthStatus?: string | null, currentTask?: string | null, hasRunningRequest?: boolean }} input
 */
export function deriveAgentWorkStatus(input) {
  const healthStatus = String(input.healthStatus || "unknown");
  if (healthStatus === "paused") return "paused";
  if (Boolean(input.currentTask) || input.hasRunningRequest === true) return "working";
  return "idle";
}
