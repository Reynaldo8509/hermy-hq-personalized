const BLOCKED_KINDS = new Map([
  ["max.owner_notification", "notification_delivery_not_implemented"],
]);

/** Reject side-effect routes until Bridge has a dedicated, bounded handler. */
export function dispatchKindBlockReason(kind) {
  return BLOCKED_KINDS.get(String(kind || "").trim().toLowerCase()) || null;
}
