const PERMISSION_ERROR = /permission denied|not authorized|access denied|failed to connect to bus/i;

export function parseSystemdUnitState(output) {
  const value = String(output || "").trim();
  if (PERMISSION_ERROR.test(value)) return "permission_denied";
  const [loadState, activeState] = value.split(/\s+/);
  if (!loadState || loadState === "not-found" || !activeState) return "unknown";
  if (loadState !== "loaded") return "unknown";
  if (["active", "inactive", "failed"].includes(activeState)) return activeState;
  return "unknown";
}

export function isActionableSystemdFailure(state) {
  return state === "inactive" || state === "failed";
}
