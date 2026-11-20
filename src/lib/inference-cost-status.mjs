export const PERSISTED_INFERENCE_COST_STATUSES = Object.freeze([
  "verified_free",
  "reported_zero",
  "unknown",
  "paid",
]);

const PERSISTED_STATUS_SET = new Set(PERSISTED_INFERENCE_COST_STATUSES);

export function inferenceCostStatusForEvidence({
  routeCostPolicy = "not_allowlisted_fail_closed",
  providerStatus = null,
  reportedCost = null,
} = {}) {
  const amount = reportedCost === null || reportedCost === undefined || reportedCost === ""
    ? null
    : Number(reportedCost);
  if (providerStatus === "paid") return "paid";
  if (providerStatus === "reported_zero" && amount === 0) return "reported_zero";
  if (
    routeCostPolicy === "verified_free_allowlist"
    && (amount === null || (Number.isFinite(amount) && amount === 0))
  ) return "verified_free";
  return "unknown";
}

export function isPersistedInferenceCostStatus(value) {
  return PERSISTED_STATUS_SET.has(value);
}
