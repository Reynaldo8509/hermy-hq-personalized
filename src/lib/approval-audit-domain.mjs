export function approvalDecisionAudit(decision, actor) {
  if (!["approved", "rejected", "expired"].includes(decision)) {
    throw new TypeError("Unsupported approval decision");
  }
  const resolvedBy = String(actor || "system").slice(0, 120);
  return {
    decision,
    approved_by: decision === "approved" ? resolvedBy : null,
    rejected_by: decision === "rejected" ? resolvedBy : null,
    resolved_by: resolvedBy,
  };
}

export function executionBlocked(status) {
  return status !== "approved";
}
