import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { classifyPrivacy, PRIVACY_CLASSES } from "../../hermes-bridge/privacy-model-router.mjs";

export const ATLAS_CONSENT_TTL_MS = 60_000;
export const ATLAS_CONSENT_PREFIX = "atlas-remote-free:";
export const ATLAS_RFC_URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
export const ATLAS_POLICY_PREFIX = "atlas-remote-free-policy:";
export const ATLAS_POLICY_ACTION = "atlas_remote_free_policy";
export const ATLAS_POLICY_SOURCE = "hermy_hq_server_policy_public_read_only_free";
export const ATLAS_POLICY_TTL_MS = 10 * 60_000;
export const ATLAS_FREE_ROUTE_KEYS = Object.freeze([
  "custom:tokenharbor:deepseek-v4.1-flash:free",
  "openrouter:cohere/north-mini-code:free",
]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}\.[A-Za-z]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_RE = /https:\/\/[^\s<>"']+/giu;

function requestFingerprint(request) {
  const text = String(request?.prompt || "");
  const prompt = text.replace(/^\s*\[\[REMOTE_FREE_ALLOWED\]\]\s*/i, "");
  const normalized = {
    id: String(request?.id || ""), kind: String(request?.kind || ""),
    title: String(request?.title || ""), prompt,
    origin: String(request?.origin || ""), sideEffecting: request?.sideEffecting === true,
    action: String(request?.action || ""), capability: String(request?.capability || ""),
    hasAttachments: Array.isArray(request?.attachments) && request.attachments.length > 0,
    complexity: String(request?.complexity || request?.metadata?.complexity || ""),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function exactRfcUrl(request) {
  const text = `${String(request?.title || "")}\n${String(request?.prompt || "")}`;
  const urls = [...new Set([...text.matchAll(URL_RE)].map((match) => match[0].replace(/[),.;!?\]}]+$/u, "")))];
  if (urls.length !== 1) return false;
  try {
    const url = new URL(urls[0]);
    return url.href === ATLAS_RFC_URL && url.protocol === "https:" && !url.username && !url.password
      && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

export function createAtlasRemoteFreeConsent(request, authenticatedActor, {
  now = Date.now(), grantId = randomUUID(), nonce = randomUUID(),
} = {}) {
  const actor = String(authenticatedActor || "").trim().toLowerCase();
  const issuedAtMs = Number(now);
  if (!request || !ID.test(String(request.id || "")) || request.status !== "queued"
      || request.origin !== "web" || request.kind !== "atlas.research"
      || request.action !== "research" || request.capability !== "read_only"
      || request.sideEffecting !== false || !String(request.title || "").trim()
      || !String(request.prompt || "").trim()
      || String(request.prompt || "").startsWith("[[REMOTE_FREE_ALLOWED]]")
      || (Array.isArray(request.dependsOn) && request.dependsOn.length > 0)
      || (Array.isArray(request.attachments) && request.attachments.length > 0)
      || !exactRfcUrl(request) || !EMAIL.test(actor)
      || !UUID.test(String(grantId)) || !UUID.test(String(nonce))
      || !Number.isSafeInteger(issuedAtMs)) return null;
  return Object.freeze({
    schema: "atlas-remote-free-capability.v1",
    source: "hermy_hq_authenticated_human_remote_free_consent",
    authSource: "nextauth_allowlisted_human",
    actor, actorAuthenticated: true,
    approvalId: ATLAS_CONSENT_PREFIX + String(request.id),
    grantId: String(grantId), nonce: String(nonce), requestId: String(request.id),
    requestFingerprint: requestFingerprint(request),
    agentId: "atlas", operation: "atlas.research", executionMode: "read_only",
    privacyClass: "REMOTE_FREE_ALLOWED", documentUrl: ATLAS_RFC_URL,
    routeKeys: [...ATLAS_FREE_ROUTE_KEYS], qwenAllowed: false, commercialAllowed: false,
    fallbackPolicy: "FREE_ONLY", issuedAtMs, expiresAtMs: issuedAtMs + ATLAS_CONSENT_TTL_MS,
  });
}


const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".onion"];
const SENSITIVE_QUERY_KEYS = /(?:^|[_-])(?:token|key|auth|authorization|password|secret|signature|sig|session)(?:$|[_-])/i;

function explicitPublicHttpsUrl(request) {
  const text = `${String(request?.title || "")}\n${String(request?.prompt || "")}`;
  const urls = [...new Set([...text.matchAll(URL_RE)].map((match) => match[0].replace(/[),.;!?\]}]+$/u, "")))];
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

function authenticatedPolicyActor(auth = {}) {
  const actor = String(auth.actor || "").trim().toLowerCase();
  if (auth.authSource === "nextauth_allowlisted_human" && EMAIL.test(actor)) return actor;
  if (auth.authSource === "hermy_hq_internal_secret" && actor === "max") return actor;
  return null;
}

/** Server-side policy permit for one authenticated public Atlas request. */
export function createAtlasRemoteFreePolicyCapability(request, auth, {
  now = Date.now(), grantId = randomUUID(), nonce = randomUUID(),
} = {}) {
  const actor = authenticatedPolicyActor(auth);
  const issuedAtMs = Number(now);
  const privacy = classifyPrivacy(request || {});
  const documentUrl = explicitPublicHttpsUrl(request);
  const requestText = `${String(request?.title || "")}\n${String(request?.prompt || "")}`;
  if (!request || !actor || !ID.test(String(request.id || "")) || request.status !== "queued"
      || request.origin !== "web" || request.kind !== "atlas.research"
      || request.action !== "research" || request.capability !== "read_only"
      || request.sideEffecting !== false || !String(request.title || "").trim()
      || !String(request.prompt || "").trim() || privacy.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY
      || /\bLOCAL_ONLY\b|\[\[REMOTE_FREE_ALLOWED\]\]/i.test(requestText)
      || (Array.isArray(request.dependsOn) && request.dependsOn.length > 0)
      || (Array.isArray(request.attachments) && request.attachments.length > 0)
      || !documentUrl || !UUID.test(String(grantId)) || !UUID.test(String(nonce))
      || !Number.isSafeInteger(issuedAtMs)) return null;
  return Object.freeze({
    schema: "atlas-remote-free-capability.v1",
    source: ATLAS_POLICY_SOURCE,
    authSource: auth.authSource,
    actor, actorAuthenticated: true,
    approvalId: ATLAS_POLICY_PREFIX + String(request.id),
    grantId: String(grantId), nonce: String(nonce), requestId: String(request.id),
    requestFingerprint: requestFingerprint(request),
    agentId: "atlas", operation: "atlas.research", executionMode: "read_only",
    privacyClass: "REMOTE_FREE_ALLOWED", documentUrl,
    routeKeys: [...ATLAS_FREE_ROUTE_KEYS], qwenAllowed: false, commercialAllowed: false,
    fallbackPolicy: "FREE_ONLY", policyVersion: "atlas-public-read-only-free-v1",
    issuedAtMs, expiresAtMs: issuedAtMs + ATLAS_POLICY_TTL_MS,
  });
}
