const ALLOWED_ORIGINS = new Set(["web", "max"]);

/** Only bounded, read-only Bridge operations may bypass an unavailable local LLM route. */
export function isAuthorizedDeterministicAgentRead(request = {}) {
  if (!ALLOWED_ORIGINS.has(String(request.origin || ""))
      || request.capability !== "read_only" || request.sideEffecting !== false
      || (Array.isArray(request.attachments) && request.attachments.length > 0)) return false;
  if (request.kind === "aegis.security") return request.action === "audit";
  if (request.kind === "ledger.operations") return request.action === "audit";
  if (request.kind === "milo.email") return request.action === "triage";
  return false;
}
