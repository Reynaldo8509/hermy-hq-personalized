import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  classifyPrivacy, isVerifiedFreeRemoteRoute, privacyRequestFingerprint,
  PRIVACY_CLASSES, REMOTE_ROUTE_TIERS, ROUTABLE_REMOTE_ROUTE_CANDIDATES, selectRoute,
  healthCacheAllowsRoute,
} from "./privacy-model-router.mjs";

export const ATLAS_REMOTE_FREE_CAPABILITY_SOURCE = "hermy_hq_authenticated_human_remote_free_consent";
export const ATLAS_REMOTE_FREE_CAPABILITY_AUTH_SOURCE = "nextauth_allowlisted_human";
export const ATLAS_REMOTE_FREE_CAPABILITY_TTL_MS = 60_000;
export const ATLAS_REMOTE_FREE_DOCUMENT_URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
export const ATLAS_REMOTE_FREE_APPROVAL_PREFIX = "atlas-remote-free:";
export const ATLAS_REMOTE_FREE_POLICY_PREFIX = "atlas-remote-free-policy:";
export const ATLAS_REMOTE_FREE_POLICY_ACTION = "atlas_remote_free_policy";
export const ATLAS_REMOTE_FREE_POLICY_SOURCE = "hermy_hq_server_policy_public_read_only_free";
export const ATLAS_REMOTE_FREE_POLICY_TTL_MS = 10 * 60_000;
export const ATLAS_REMOTE_FREE_ROUTE_KEYS = Object.freeze(ROUTABLE_REMOTE_ROUTE_CANDIDATES
  .filter((route) => isVerifiedFreeRemoteRoute(route.provider, route.model))
  .map((route) => `${route.provider}:${route.model}`));
const ATLAS_FREE_TIERS = new Set(["mimo26_primary", "remote_free_primary", "remote_free_failover"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}\.[A-Za-z]{2,63}$/;
const URL_RE = /https:\/\/[^\s<>"']+/giu;

export function atlasRemoteFreeApprovalId(requestId) {
  const id = String(requestId || "");
  if (!ID.test(id)) throw new TypeError("atlas_remote_free_request_id_invalid");
  return ATLAS_REMOTE_FREE_APPROVAL_PREFIX + id;
}

function extractRequestUrls(request) {
  const text = `${String(request?.title || "")}\n${String(request?.prompt || "")}`;
  return [...new Set([...text.matchAll(URL_RE)].map((match) => match[0].replace(/[),.;!?\]}]+$/u, "")))];
}

function explicitDocumentUrl(request) {
  const urls = extractRequestUrls(request);
  if (urls.length !== 1) return null;
  let parsed;
  try { parsed = new URL(urls[0]); } catch { return null; }
  if (parsed.href !== ATLAS_REMOTE_FREE_DOCUMENT_URL || parsed.protocol !== "https:"
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  return parsed.href;
}

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".onion"];
const SENSITIVE_QUERY_KEYS = /(?:^|[_-])(?:token|key|auth|authorization|password|secret|signature|sig|session)(?:$|[_-])/i;
function explicitPublicHttpsDocumentUrl(request) {
  const urls = extractRequestUrls(request);
  if (urls.length !== 1) return null;
  try {
    const url = new URL(urls[0]);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
        || !host || host === "localhost" || isIP(host)
        || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
        || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEYS.test(key))) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export function atlasRemoteFreePolicyApprovalId(requestId) {
  const id = String(requestId || "");
  if (!ID.test(id)) throw new TypeError("atlas_remote_free_request_id_invalid");
  return ATLAS_REMOTE_FREE_POLICY_PREFIX + id;
}

export function createAtlasRemoteFreeCapability({
  request, actor, now = Date.now(), ttlMs = ATLAS_REMOTE_FREE_CAPABILITY_TTL_MS,
  grantId = randomUUID(), nonce = randomUUID(),
} = {}) {
  const authenticatedActor = String(actor || "").trim().toLowerCase();
  const issuedAtMs = Number(now);
  const lifetime = Number(ttlMs);
  const documentUrl = explicitDocumentUrl(request);
  const baselinePrivacy = classifyPrivacy(request || {});
  if (!request || !ID.test(String(request.id || ""))
      || request.kind !== "atlas.research" || request.origin !== "web"
      || request.action !== "research" || request.capability !== "read_only"
      || request.status !== "queued" || request.sideEffecting !== false
      || !String(request.title || "").trim() || !String(request.prompt || "").trim()
      || String(request.prompt || "").startsWith("[[REMOTE_FREE_ALLOWED]]")
      || (Array.isArray(request.dependsOn) && request.dependsOn.length > 0)
      || (Array.isArray(request.attachments) && request.attachments.length > 0)
      || baselinePrivacy.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY
      || !documentUrl || !EMAIL.test(authenticatedActor)
      || !UUID.test(String(grantId)) || !UUID.test(String(nonce))
      || !Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(lifetime)
      || lifetime < 1_000 || lifetime > ATLAS_REMOTE_FREE_CAPABILITY_TTL_MS) return null;
  return Object.freeze({
    schema: "atlas-remote-free-capability.v1",
    source: ATLAS_REMOTE_FREE_CAPABILITY_SOURCE,
    authSource: ATLAS_REMOTE_FREE_CAPABILITY_AUTH_SOURCE,
    actor: authenticatedActor,
    actorAuthenticated: true,
    approvalId: atlasRemoteFreeApprovalId(request.id),
    grantId: String(grantId),
    nonce: String(nonce),
    requestId: String(request.id),
    requestFingerprint: privacyRequestFingerprint(request),
    agentId: "atlas",
    operation: "atlas.research",
    executionMode: "read_only",
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    documentUrl,
    routeKeys: [...ATLAS_REMOTE_FREE_ROUTE_KEYS],
    qwenAllowed: false,
    commercialAllowed: false,
    fallbackPolicy: "FREE_ONLY",
    issuedAtMs,
    expiresAtMs: issuedAtMs + lifetime,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function parseSnapshot(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

function timestampMilliseconds(value) {
  // PostgreSQL TIMESTAMP values must arrive as explicit UTC epoch-millisecond aliases.
  // Do not accept Date objects or timestamp text that node-postgres may parse in process TZ.
  if (typeof value !== "number" && typeof value !== "bigint"
      && !(typeof value === "string" && /^-?\d+$/u.test(value))) return Number.NaN;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : Number.NaN;
}

export function validateAtlasRemoteFreeCapability(capability, request, approval, now = Date.now()) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)
      || !request || typeof request !== "object" || Array.isArray(request)
      || !approval || typeof approval !== "object") return false;
  const issuedAtMs = Number(capability.issuedAtMs);
  const expiresAtMs = Number(capability.expiresAtMs);
  const ttl = expiresAtMs - issuedAtMs;
  const nowMs = Number(now);
  const approvalExpiry = timestampMilliseconds(approval.expires_at_utc_ms);
  const approvalCreated = timestampMilliseconds(approval.created_at_utc_ms);
  const approvalResolved = timestampMilliseconds(approval.resolved_at_utc_ms);
  const snapshot = parseSnapshot(approval.parameters_snapshot ?? approval.parametersSnapshot);
  const privacy = classifyPrivacy(request);
  const isHumanConsent = capability.source === ATLAS_REMOTE_FREE_CAPABILITY_SOURCE;
  const isServerPolicy = capability.source === ATLAS_REMOTE_FREE_POLICY_SOURCE;
  if (!isHumanConsent && !isServerPolicy) return false;
  const actor = String(capability.actor || "");
  const authValid = isHumanConsent
    ? capability.authSource === ATLAS_REMOTE_FREE_CAPABILITY_AUTH_SOURCE && EMAIL.test(actor)
      && approval.action === "atlas_remote_free_consent" && approval.status === "approved"
      && approval.requested_by === actor && approval.approved_by === actor
      && Number.isFinite(approvalResolved) && Math.abs(approvalResolved - issuedAtMs) <= 5_000
    : (capability.authSource === "nextauth_allowlisted_human" && EMAIL.test(actor)
        || capability.authSource === "hermy_hq_internal_secret" && actor === "max")
      && approval.action === ATLAS_REMOTE_FREE_POLICY_ACTION && approval.status === "issued"
      && approval.requested_by === actor && approval.approved_by == null
      && approval.decision === "server_policy_issued"
      && approval.resolved_at_utc_ms == null
      && capability.policyVersion === "atlas-public-read-only-free-v1";
  const documentUrl = isHumanConsent ? explicitDocumentUrl(request) : explicitPublicHttpsDocumentUrl(request);
  const expectedApprovalId = isHumanConsent
    ? atlasRemoteFreeApprovalId(request.id) : atlasRemoteFreePolicyApprovalId(request.id);
  const maxTtlMs = isServerPolicy
    ? ATLAS_REMOTE_FREE_POLICY_TTL_MS
    : ATLAS_REMOTE_FREE_CAPABILITY_TTL_MS;
  return capability.schema === "atlas-remote-free-capability.v1"
    && capability.actorAuthenticated === true
    && authValid
    && UUID.test(String(capability.grantId || ""))
    && UUID.test(String(capability.nonce || ""))
    && capability.approvalId === expectedApprovalId
    && capability.requestId === String(request.id || "")
    && capability.requestFingerprint === privacyRequestFingerprint(request)
    && request.kind === "atlas.research" && request.origin === "web"
    && request.action === "research" && request.capability === "read_only"
    && (request.status === "queued" || request.status === "running")
    && request.sideEffecting === false
    && String(request.title || "").trim().length > 0
    && String(request.prompt || "").trim().length > 0
    && !/\bLOCAL_ONLY\b|\[\[REMOTE_FREE_ALLOWED\]\]/i.test(`${request.title}\n${request.prompt}`)
    && !(Array.isArray(request.attachments) && request.attachments.length > 0)
    && !(Array.isArray(request.dependsOn) && request.dependsOn.length > 0)
    && privacy.privacyClass !== PRIVACY_CLASSES.LOCAL_ONLY
    && capability.agentId === "atlas"
    && capability.operation === "atlas.research"
    && capability.executionMode === "read_only"
    && capability.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED
    && capability.documentUrl === documentUrl
    && Array.isArray(capability.routeKeys)
    && JSON.stringify(capability.routeKeys) === JSON.stringify(ATLAS_REMOTE_FREE_ROUTE_KEYS)
    && capability.qwenAllowed === false
    && capability.commercialAllowed === false
    && capability.fallbackPolicy === "FREE_ONLY"
    && Number.isSafeInteger(issuedAtMs) && Number.isSafeInteger(expiresAtMs)
    && Number.isSafeInteger(nowMs) && issuedAtMs <= nowMs
    && ttl > 0 && ttl <= maxTtlMs
    && expiresAtMs > nowMs
    && Number.isFinite(approvalCreated) && Math.abs(approvalCreated - issuedAtMs) <= 5_000
    && Number.isFinite(approvalExpiry) && approvalExpiry > nowMs
    && Math.abs(approvalExpiry - expiresAtMs) <= 1_000
    && JSON.stringify(stableJson(snapshot)) === JSON.stringify(stableJson(capability));
}

export function isAtlasRemoteFreeRouteAllowed(route, capability) {
  if (!route || !capability || !Array.isArray(capability.routeKeys)) return false;
  const key = `${String(route.provider || "")}:${String(route.model || "")}`;
  return ATLAS_FREE_TIERS.has(String(route.tier || ""))
    && REMOTE_ROUTE_TIERS.includes(String(route.tier || ""))
    && capability.routeKeys.includes(key)
    && ATLAS_REMOTE_FREE_ROUTE_KEYS.includes(key)
    && isVerifiedFreeRemoteRoute(route.provider, route.model);
}

export function selectAtlasRemoteFreeRouting({ request, capability, approval, routerState, now = Date.now() } = {}) {
  if (!validateAtlasRemoteFreeCapability(capability, request, approval, now)) {
    throw new Error("atlas_remote_free_capability_invalid");
  }
  if (!routerState || routerState.securityDisabled === true || routerState.remoteRoutingDisabled === true) {
    throw new Error("atlas_remote_free_security_gate_closed");
  }
  const privacy = classifyPrivacy(request, { remoteFreeAllowed: true });
  if (privacy.privacyClass !== PRIVACY_CLASSES.REMOTE_FREE_ALLOWED) {
    throw new Error("atlas_remote_free_privacy_denied");
  }
  const allowedKeys = new Set(capability.routeKeys);
  const remoteRoutes = (Array.isArray(routerState.remoteRoutes) ? routerState.remoteRoutes : [])
    .filter((route) => isVerifiedFreeRemoteRoute(route.provider, route.model)
      && allowedKeys.has(`${route.provider}:${route.model}`)
      && healthCacheAllowsRoute(route.health, route, now));
  const modelRoute = selectRoute({
    request, privacy, complexity: "INTERMEDIATE",
    flags: { enabled: true, mimoCanaryEnabled: false, canaryPercent: 0,
      e2eCandidate: false, remoteRoutingDisabled: false },
    health: routerState.health, breaker: routerState.breaker,
    qwenAvailability: routerState.qwenAvailability, remoteRoutes, now,
  });
  if (!REMOTE_ROUTE_TIERS.includes(modelRoute.tier)
      || !isAtlasRemoteFreeRouteAllowed(modelRoute, capability)) {
    throw new Error("atlas_remote_free_provider_unavailable");
  }
  return { privacy, remoteRoutes, modelRoute };
}
