import {
  isAtlasRemoteFreeRouteAllowed, validateAtlasRemoteFreeCapability,
} from "./atlas-remote-free-capability.mjs";
import { runAtlasFreeDocumentFallback } from "./atlas-free-web-route.mjs";
import { PRIVACY_CLASSES, REMOTE_ROUTE_TIERS } from "./privacy-model-router.mjs";

export async function executeAtlasRemoteFreeResearch({
  request, capability, approval, routing, now = Date.now(),
  consumeCapability, extractDocument, inferFree, onExtraction = async () => {},
  onDocumentaryValidation = async () => {},
} = {}) {
  if (!validateAtlasRemoteFreeCapability(capability, request, approval, now)) {
    throw new Error("atlas_remote_free_capability_invalid");
  }
  if (routing?.privacyClass !== PRIVACY_CLASSES.REMOTE_FREE_ALLOWED
      || routing?.securityDisabled !== false
      || routing?.remoteAttemptInFlight === true
      || !REMOTE_ROUTE_TIERS.includes(routing?.modelRoute?.tier)
      || !isAtlasRemoteFreeRouteAllowed(routing.modelRoute, capability)
      || typeof consumeCapability !== "function") {
    throw new Error("atlas_remote_free_route_denied");
  }
  const consumed = await consumeCapability(request, capability, approval, now);
  if (consumed !== true) throw new Error("atlas_remote_free_capability_replay_or_expired");
  const response = await runAtlasFreeDocumentFallback({
    request, activeAgentId: "atlas", routing,
    extractDocument, inferFree, onExtraction, onDocumentaryValidation,
  });
  if (typeof response !== "string" || !response.trim()) {
    throw new Error("atlas_remote_free_empty_result");
  }
  return response.trim();
}
