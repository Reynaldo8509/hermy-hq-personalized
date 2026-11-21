import {
  classifyPrivacy,
  isSupportedRemoteRoute,
  PRIVACY_CLASSES,
} from "./privacy-model-router.mjs";

const AEGIS_REMOTE_TIERS = new Set(["remote_free_primary", "remote_free_failover"]);

/**
 * Aegis may use a remote free model only for an explicitly authorized,
 * synthetic, read-only audit on one of the fixed allowlisted routes.
 */
export function isAuthorizedAegisFreeInference(request, privacyClass, route) {
  if (request?.kind !== "aegis.security"
      || request?.action !== "audit"
      || request?.capability !== "read_only"
      || request?.sideEffecting !== false
      || (Array.isArray(request?.attachments) && request.attachments.length > 0)
      || ["workflow", "error-supervisor"].includes(String(request?.origin || "").toLowerCase())
      || privacyClass !== PRIVACY_CLASSES.REMOTE_FREE_ALLOWED
      || !AEGIS_REMOTE_TIERS.has(route?.tier)
      || !isSupportedRemoteRoute(route?.provider, route?.model)) return false;

  return classifyPrivacy(request, { remoteFreeAllowed: true }).privacyClass
    === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED;
}

export async function dispatchAegisRequest({
  request,
  privacyClass,
  route,
  runLocalReadOnly,
  inferFree,
}) {
  if (typeof runLocalReadOnly !== "function" || typeof inferFree !== "function") {
    throw new TypeError("aegis_dispatch_handlers_required");
  }
  if (isAuthorizedAegisFreeInference(request, privacyClass, route)) {
    return inferFree(request);
  }
  return runLocalReadOnly();
}
