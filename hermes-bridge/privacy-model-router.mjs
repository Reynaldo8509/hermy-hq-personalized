import { createHash, randomUUID } from "node:crypto";
import { GROQ_FREE_EVIDENCE_SOURCE, HEALTH_PROBE_TYPE, TOKENHARBOR_ALLOWED_ACTUAL_MODELS, healthIsFresh } from "./provider-health.mjs";
import { QWEN_AVAILABILITY } from "./qwen-availability.mjs";

export const PRIVACY_CLASSES = Object.freeze({
  LOCAL_ONLY: "LOCAL_ONLY",
  PREFER_LOCAL: "PREFER_LOCAL",
  REMOTE_FREE_ALLOWED: "REMOTE_FREE_ALLOWED",
});
export const COMPLEXITY_CLASSES = Object.freeze({ SIMPLE: "SIMPLE", INTERMEDIATE: "INTERMEDIATE", COMPLEX: "COMPLEX" });
export const QWEN_ROUTE = Object.freeze({ provider: "qwen-local-tailscale", model: "qwen3-8b-local", reasoning: "low" });
export const TOKENHARBOR_DEEPSEEK_FREE_ROUTE = Object.freeze({ provider: "custom:tokenharbor", model: "deepseek-v4.1-flash:free", reasoning: "low" });
export const OPENROUTER_COHERE_FREE_ROUTE = Object.freeze({ provider: "openrouter", model: "cohere/north-mini-code:free", reasoning: "low" });
// Keep the historical export name for import compatibility; its effective route is now
// the operator-verified Token Harbor DeepSeek Free model.
export const MIMO26_ROUTE = TOKENHARBOR_DEEPSEEK_FREE_ROUTE;
export const OPENCODE_ZEN_FREE_ROUTE = Object.freeze({ provider: "opencode-zen", model: "nemotron-3.5-lightning-free", reasoning: "low" });
export const GROQ_FREE_ROUTE = Object.freeze({ provider: "groq", model: "openai/gpt-oss-120b", reasoning: "low" });
export const OPENROUTER_FREE_ROUTE = OPENROUTER_COHERE_FREE_ROUTE;
export const VERIFIED_FREE_ROUTE_CANDIDATES = Object.freeze([TOKENHARBOR_DEEPSEEK_FREE_ROUTE, OPENROUTER_COHERE_FREE_ROUTE]);
export const ROUTABLE_REMOTE_ROUTE_CANDIDATES = VERIFIED_FREE_ROUTE_CANDIDATES;
export const MAX_REMOTE_ATTEMPTS_PER_REQUEST = ROUTABLE_REMOTE_ROUTE_CANDIDATES.length;
export function isVerifiedFreeRemoteRoute(provider, model) {
  return VERIFIED_FREE_ROUTE_CANDIDATES.some((route) => route.provider === provider && route.model === model);
}
export function isOperationallyEligibleRemoteRoute(provider, model) {
  return ROUTABLE_REMOTE_ROUTE_CANDIDATES.some((route) => route.provider === provider && route.model === model);
}
export function isSupportedRemoteRoute(provider, model) {
  return isOperationallyEligibleRemoteRoute(provider, model);
}

export function remoteRoutesForRequest(kind, routes) {
  const candidates = Array.isArray(routes) ? routes : [];
  if (!["max.chief-of-staff", "max.deep-analysis", "atlas.research", "aegis.security"].includes(String(kind || ""))) return [];
  return candidates.filter((route) => isSupportedRemoteRoute(route?.provider, route?.model));
}
export const REMOTE_ROUTE_TIERS = Object.freeze([
  "mimo26_canary", "mimo26_e2e_once", "mimo26_primary", "mimo26_prefer_local_fallback",
  "remote_free_primary", "remote_free_failover", "remote_free_prefer_local_fallback",
]);
export const ROUTER_STATE_KEY = "privacy-model-router-v2";
export const PROVIDER_BREAKER_STATES = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" });
export const PRIVACY_POLICY_VERSION = "privacy-routing-v1";
export const ROUTER_E2E_PERMIT_SOURCE = "bridge_router_permit_issuer";
export const ROUTER_E2E_PERMIT_TTL_MS = 60_000;
const TRUSTED_APPROVAL_SOURCES = new Set(["bridge_internal_policy", "provider_health_probe", ROUTER_E2E_PERMIT_SOURCE]);

export function isLegacyProviderFailureLatch(routerState = {}) {
  return routerState.remoteRoutingDisabled === true
    && routerState.autoDisableReason === "repeated_provider_failure"
    && routerState.securityDisabled !== true && !routerState.securityDisableReason;
}

export function securityDisableIsActive(routerState = {}) {
  return routerState.securityDisabled === true
    || (routerState.remoteRoutingDisabled === true && !isLegacyProviderFailureLatch(routerState));
}

// One incident-scoped recovery for the confirmed rate-card estimate false positive.
// This is deliberately not a general security-latch reset mechanism.
export const KNOWN_ESTIMATE_FALSE_POSITIVE = Object.freeze({
  recoveryId: "phase222c21-estimate-false-positive-cmv0fbni2008daose57t089nd-v1",
  requestId: "cmv0fbni2008daose57t089nd",
  reason: "verified_free_contradiction",
});

export function planKnownEstimateFalsePositiveRecovery(routerState = {}, remoteRoutes = [], now = Date.now()) {
  const incident = KNOWN_ESTIMATE_FALSE_POSITIVE;
  if (routerState.securityDisabled !== true || routerState.remoteRoutingDisabled !== true
      || routerState.securityDisableReason !== incident.reason
      || routerState.autoDisableReason !== incident.reason
      || routerState.autoDisabledRequestId !== incident.requestId
      || routerState.mimoCanaryEnabled !== false
      || Number(routerState.canaryPercent) !== 0
      || routerState.securityRecovery) return null;

  const primaryRoute = remoteRoutes.find((route) =>
    route?.provider === MIMO26_ROUTE.provider && route?.model === MIMO26_ROUTE.model);
  if (!primaryRoute || primaryRoute.breaker?.state !== PROVIDER_BREAKER_STATES.CLOSED
      || primaryRoute.breaker?.disabled === true
      || Number(primaryRoute.breaker?.cooldownUntil || 0) > Number(now)
      || !healthCacheAllowsRoute(primaryRoute.health, primaryRoute, Number(now))) return null;

  return Object.freeze({
    recoveryId: incident.recoveryId,
    requestId: incident.requestId,
    reason: incident.reason,
    verifiedRoutes: Object.freeze([Object.freeze({
      provider: primaryRoute.provider,
      model: primaryRoute.model,
      checkedAt: Number(primaryRoute.health.checkedAt),
      validUntil: Number(primaryRoute.health.validUntil),
    })]),
  });
}

export function normalizeProviderBreakerState(raw = {}, { legacyProviderDisable = false, now = Date.now() } = {}) {
  const providerFailureCount = Math.max(0, Number(raw.providerFailureCount ?? raw.consecutiveFailures) || 0);
  const cooldownUntil = Number.isSafeInteger(Number(raw.cooldownUntil ?? raw.providerBreakerCooldownUntil))
    ? Math.max(0, Number(raw.cooldownUntil ?? raw.providerBreakerCooldownUntil)) : 0;
  const reason = String(raw.lastProviderFailureClass || raw.reason || "");
  const stateIsExplicit = Object.values(PROVIDER_BREAKER_STATES).includes(raw.state);
  const shouldOpenLegacy = legacyProviderDisable || raw.disabled === true || cooldownUntil > now
    || ["payment_required", "rate_limited", "auth_denied"].includes(reason)
    || (["provider_5xx", "provider_503", "timeout", "network_error"].includes(reason) && providerFailureCount >= 2);
  const httpStatus = Number(raw.lastVerifiedHttpStatus);
  const normalizedState = stateIsExplicit ? raw.state
    : shouldOpenLegacy ? PROVIDER_BREAKER_STATES.OPEN : PROVIDER_BREAKER_STATES.CLOSED;
  return {
    ...raw,
    state: legacyProviderDisable && normalizedState === PROVIDER_BREAKER_STATES.CLOSED
      ? PROVIDER_BREAKER_STATES.OPEN : normalizedState,
    providerFailureCount,
    consecutiveFailures: providerFailureCount,
    openedAt: Number.isSafeInteger(Number(raw.openedAt ?? raw.lastFailureAt))
      ? Math.max(0, Number(raw.openedAt ?? raw.lastFailureAt)) || null : null,
    cooldownUntil,
    lastProviderFailureClass: raw.lastProviderFailureClass || (legacyProviderDisable ? "legacy_unverified" : raw.reason || null),
    lastVerifiedHttpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
  };
}

const REMOTE_MARKER = /^\s*\[\[REMOTE_FREE_ALLOWED\]\]\s*/i;
const LOCAL_KINDS = new Set([
  "domus.home", "milo.email", "ledger.operations", "automation.systemd",
  "memory.write", "memory.restore", "codex.change", "video.youtube.analyze",
]);
const SENSITIVE_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|credential|authorization|cookie)\b\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:email body|full email|correo completo|cuerpo del correo|contenido del correo|mensaje de correo)\b/i,
  /\b(?:private|privado|confidential|confidencial|sensitive|sensible|personal data|dato personal)\b/i,
  /\b(?:banco|bank account|cuenta bancaria|tarjeta de cr[eé]dito|medical|m[eé]dic[oa]|diagn[oó]stico cl[ií]nico|historial m[eé]dico)\b/i,
  /\b(?:home assistant|homeassistant|hassio|entity_id|tailscale|ssh config|infraestructura interna|servidor interno)\b/i,
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/,
];
const PUBLIC_RESEARCH = /\b(?:investigaci[oó]n p[uú]blica|investiga(?:r)? documentaci[oó]n p[uú]blica|public research|public documentation|fuentes oficiales p[uú]blicas)\b/i;
const SYNTHETIC_WORK = /\b(?:sint[eé]tic[oa]|synthetic|benchmark|sin datos reales|no real data)\b/i;
const COMPLEX_HINTS = /\b(?:arquitectura|architecture|plan(?:ificaci[oó]n)? multietapa|multi[- ]step|causa ra[ií]z|root cause|troubleshooting ambiguo|comparaci[oó]n t[eé]cnica|technical comparison|investigaci[oó]n profunda|deep research|varios dominios|multi[- ]domain|revisi[oó]n compleja|complex review|migraci[oó]n|dise[nñ]o de sistema)\b/i;
const INTERMEDIATE_HINTS = /\b(?:debug(?:ging)?|depuraci[oó]n|error|fall[oa]|bug|c[oó]digo|code|script|varios pasos|multiple steps|transform(?:a|aci[oó]n)|integraci[oó]n|configuraci[oó]n|comparar|compare|an[aá]lisis)\b/i;
const SIMPLE_HINTS = /\b(?:status|estado|health|lookup|buscar|extraer|extract|clasificar|classify|resumen breve|short summary|consulta r[aá]pida|quick check)\b/i;

function requestText(request = {}) {
  return `${String(request.title || "")}\n${String(request.prompt || "")}`;
}

function privacyPayloadContent(request = {}, effectivePayload = "", trustedStaticPromptPrefix = null) {
  const payload = String(effectivePayload ?? "");

  // MAX's triage template is another Bridge-owned static instruction. It is
  // trusted only while the request-scoped helper has bound this exact prefix,
  // request identity, kind, and dynamic suffix. User text after the prefix is
  // still classified in full, including any appended prompt injection.
  const trusted = trustedStaticPromptPrefix;
  if (trusted?.requestId === String(request.id || "")
      && trusted?.kind === String(request.kind || "")
      && typeof trusted?.prefix === "string" && trusted.prefix.length > 0
      && typeof trusted?.dynamicPrompt === "string" && trusted.dynamicPrompt.length > 0
      && request.prompt === trusted.prefix + trusted.dynamicPrompt
      && payload.startsWith(trusted.prefix)) {
    return payload.slice(trusted.prefix.length);
  }
  return payload;
}

export function classifyPrivacyPayload(request = {}, effectivePayload = "", trustedMetadata = null,
  trustedStaticPromptPrefix = null) {
  return classifyPrivacy({
    ...request,
    prompt: privacyPayloadContent(request, effectivePayload, trustedStaticPromptPrefix),
  }, trustedMetadata);
}

export function stripRemoteOptInMarker(prompt) {
  return String(prompt || "").replace(REMOTE_MARKER, "");
}

export function privacyRequestFingerprint(request = {}) {
  const normalized = {
    id: String(request.id || ""),
    kind: String(request.kind || ""),
    title: String(request.title || ""),
    prompt: stripRemoteOptInMarker(request.prompt || ""),
    origin: String(request.origin || ""),
    sideEffecting: request.sideEffecting === true,
    action: String(request.action || ""),
    capability: String(request.capability || ""),
    hasAttachments: Array.isArray(request.attachments) && request.attachments.length > 0,
    complexity: String(request.complexity || request.metadata?.complexity || ""),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function canonicalizeEffectivePayload(payload) {
  // Preserve the exact string passed as the one-shot argument; even line-ending changes bind differently.
  return String(payload ?? "");
}

export function effectivePayloadSha256(payload) {
  return createHash("sha256").update(canonicalizeEffectivePayload(payload)).digest("hex");
}

export function createRemoteApprovalRecord({
  request, effectivePayload, provider = MIMO26_ROUTE.provider, model = MIMO26_ROUTE.model,
  now = Date.now(), expiresAt = now + 60_000, nonce = randomUUID(), source = "bridge_internal_policy",
  probeType = null,
} = {}) {
  return {
    approved: true, source, probeType: probeType || null,
    requestId: String(request?.id || ""),
    requestFingerprint: privacyRequestFingerprint(request),
    payloadHash: effectivePayloadSha256(effectivePayload),
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    provider: String(provider), model: String(model), policyVersion: PRIVACY_POLICY_VERSION,
    nonce: String(nonce), issuedAt: Number(now), expiresAt: Number(expiresAt), consumedAt: null,
  };
}

export function createRouterE2EPermit({
  request, effectivePayload, provider = MIMO26_ROUTE.provider,
  requestedModel = MIMO26_ROUTE.model, effectiveModel = MIMO26_ROUTE.model,
  privacyClass, complexityClass, readiness, safeMode, privacyToolFree, toolCount,
  memory, skills, mcp, history, privacyFinalGateAllowed, routeTier, qwenAvailable = null,
  now = Date.now(), ttlMs = ROUTER_E2E_PERMIT_TTL_MS,
  permitId = randomUUID(), nonce = randomUUID(),
} = {}) {
  const kind = String(request?.kind || "");
  const canaryRoute = ["mimo26_canary", "mimo26_e2e_once"].includes(routeTier);
  const remotePrimaryRoute = ["mimo26_primary", "remote_free_primary", "remote_free_failover"].includes(routeTier);
  const preferLocalFallback = ["mimo26_prefer_local_fallback", "remote_free_prefer_local_fallback"].includes(routeTier);
  const classAllowed = privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED;
  const requestSafe = Boolean(request?.id && request?.capability === "read_only"
    && request?.sideEffecting === false
    && !(Array.isArray(request?.attachments) && request.attachments.length)
    && !LOCAL_KINDS.has(kind.toLowerCase())
    && !["workflow", "error-supervisor"].includes(String(request?.origin || "").toLowerCase()));
  const canaryRequestSafe = !canaryRoute || (
    ["max.chief-of-staff", "max.deep-analysis", "atlas.research"].includes(kind)
    && complexityClass === COMPLEXITY_CLASSES.COMPLEX && canaryEligible(request)
  );
  const allowedTier = canaryRoute || remotePrimaryRoute || preferLocalFallback;
  const ttl = Number(ttlMs);
  const catalogReadiness = readiness?.status === "catalog_verified_free"
    && readiness?.catalogVerified === true && readiness?.catalogSource === "authenticated_model_catalog";
  const eligible = Boolean(
    requestSafe && canaryRequestSafe && allowedTier && classAllowed
    && healthCacheAllowsRoute(readiness, { provider, model: requestedModel }, Number(now))
    && catalogReadiness
    && isSupportedRemoteRoute(provider, requestedModel)
    && effectiveModel === requestedModel
    && safeMode === true
    && privacyToolFree === true
    && toolCount === 0
    && memory === false
    && skills === false
    && mcp === false
    && history === "none"
    && privacyFinalGateAllowed === true
    && Number.isSafeInteger(ttl) && ttl >= 30_000 && ttl <= 120_000
    && typeof effectivePayload === "string" && effectivePayload.length > 0
    && (!preferLocalFallback || qwenAvailable === false)
  );
  if (!eligible) return null;
  const issuedAt = Number(now);
  return Object.freeze({
    approved: true,
    source: ROUTER_E2E_PERMIT_SOURCE,
    permitId: String(permitId),
    requestId: String(request.id),
    requestFingerprint: privacyRequestFingerprint(request),
    payloadHash: effectivePayloadSha256(effectivePayload),
    privacyClass,
    provider: String(provider),
    requestedModel: String(requestedModel),
    model: String(requestedModel),
    effectiveModel: String(effectiveModel),
    policyVersion: PRIVACY_POLICY_VERSION,
    routeTier: String(routeTier),
    qwenAvailable: typeof qwenAvailable === "boolean" ? qwenAvailable : null,
    nonce: String(nonce),
    status: "ISSUED",
    issuedAt,
    expiresAt: issuedAt + ttl,
    consumedAt: null,
  });
}

export function isTrustedRemoteApprovalRecord(record, request = {}, now = Date.now(), binding = {}) {
  const payloadMatches = binding.effectivePayload === undefined
    || record?.payloadHash === effectivePayloadSha256(binding.effectivePayload);
  const providerMatches = binding.provider === undefined || record?.provider === binding.provider;
  const modelMatches = binding.model === undefined || record?.model === binding.model;
  const effectiveModelMatches = record?.source !== ROUTER_E2E_PERMIT_SOURCE
    || record?.effectiveModel === (binding.effectiveModel ?? binding.model);
  const sourceMatches = record?.source === "bridge_internal_policy"
    || (record?.source === "provider_health_probe" && record.probeType === HEALTH_PROBE_TYPE
      && request?.metadata?.probeType === HEALTH_PROBE_TYPE)
    || (record?.source === ROUTER_E2E_PERMIT_SOURCE
      && isTrustedRouterE2EPermit(record, request, now, binding));
  const classMatches = record?.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED;
  return Boolean(record && record.approved === true && TRUSTED_APPROVAL_SOURCES.has(record.source) && sourceMatches
    && classMatches
    && record.requestId === String(request.id || "")
    && record.requestFingerprint === privacyRequestFingerprint(request)
    && /^[0-9a-f]{64}$/.test(String(record.payloadHash || "")) && payloadMatches
    && isSupportedRemoteRoute(record.provider, record.model) && providerMatches
    && record.model && modelMatches
    && effectiveModelMatches
    && record.policyVersion === PRIVACY_POLICY_VERSION
    && typeof record.nonce === "string" && record.nonce.length >= 16
    && record.consumedAt == null
    && Number.isFinite(Number(record.expiresAt)) && Number(record.expiresAt) > now);
}

export function isTrustedRouterE2EPermit(permit, request = {}, now = Date.now(), binding = {}) {
  const issuedAt = Number(permit?.issuedAt);
  const expiresAt = Number(permit?.expiresAt);
  const ttl = expiresAt - issuedAt;
  const payloadMatches = binding.effectivePayload === undefined
    || permit?.payloadHash === effectivePayloadSha256(binding.effectivePayload);
  const matches = (field, value) => value === undefined || permit?.[field] === value;
  return Boolean(permit && permit.approved === true && permit.source === ROUTER_E2E_PERMIT_SOURCE
    && permit.requestId === String(request.id || "")
    && permit.requestFingerprint === privacyRequestFingerprint(request)
    && /^[0-9a-f]{64}$/.test(String(permit.payloadHash || "")) && payloadMatches
    && permit.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED
    && isSupportedRemoteRoute(permit.provider, permit.requestedModel)
    && permit.model === permit.requestedModel
    && permit.effectiveModel === permit.requestedModel
    && matches("provider", binding.provider)
    && matches("requestedModel", binding.requestedModel ?? binding.model)
    && matches("effectiveModel", binding.effectiveModel ?? binding.model)
    && permit.policyVersion === PRIVACY_POLICY_VERSION
    && ["mimo26_canary", "mimo26_e2e_once", "mimo26_primary", "remote_free_primary", "remote_free_failover"].includes(permit.routeTier)
    && permit.status === "ISSUED"
    && typeof permit.nonce === "string" && permit.nonce.length >= 16
    && permit.consumedAt == null
    && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt)
    && ttl >= 30_000 && ttl <= 120_000 && expiresAt > now);
}

export function inspectRemotePrivacyArgs(args) {
  if (!Array.isArray(args)) return null;
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--safe-mode") {
      if (values.has(flag)) return null;
      values.set(flag, true);
      continue;
    }
    if (!["--provider", "-m", "--reasoning", "-z"].includes(flag) || values.has(flag)
        || index + 1 >= args.length) return null;
    values.set(flag, String(args[index + 1]));
    index += 1;
  }
  if (values.get("--safe-mode") !== true
      || !isSupportedRemoteRoute(values.get("--provider"), values.get("-m"))
      || values.get("-z") === undefined) return null;
  return Object.freeze({
    provider: values.get("--provider"),
    model: values.get("-m"),
    payload: values.get("-z"),
    safeMode: true,
    privacyToolFree: true,
    toolCount: 0,
    memory: false,
    skills: false,
    mcp: false,
    history: "none",
  });
}

export function validateRouterPermitTransportEnvelope(args, { request, permit, now = Date.now() } = {}) {
  if (!Array.isArray(args)) return false;
  const valueFlags = new Set(["--usage-file", "--provider", "-m", "--model", "--reasoning", "-z", "--oneshot", "--privacy-payload-sha256"]);
  const booleanFlags = new Set(["--safe-mode", "--no-fallback", "--privacy-routing", "--privacy-final-gate", "--privacy-tool-free", "--privacy-remote-approved"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (booleanFlags.has(flag)) {
      if (values.has(flag)) return false;
      values.set(flag, true);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag) || index + 1 >= args.length) return false;
    values.set(flag, String(args[index + 1]));
    index += 1;
  }
  const model = values.get("-m") ?? values.get("--model");
  const payload = values.get("-z") ?? values.get("--oneshot");
  if ((values.has("-m") && values.has("--model")) || (values.has("-z") && values.has("--oneshot"))) return false;
  if (values.get("--safe-mode") !== true || values.get("--no-fallback") !== true
      || values.get("--privacy-routing") !== true || values.get("--privacy-final-gate") !== true
      || values.get("--privacy-tool-free") !== true || values.get("--privacy-remote-approved") !== true
      || !isSupportedRemoteRoute(values.get("--provider"), model)
      || typeof payload !== "string"
      || values.get("--privacy-payload-sha256") !== effectivePayloadSha256(payload)) return false;
  return isTrustedRouterE2EPermit(permit, request, now, {
    effectivePayload: payload, provider: values.get("--provider"),
    model, requestedModel: model, effectiveModel: model,
  });
}

export function classifyPrivacy(request = {}, trustedMetadata = null) {
  const kind = String(request.kind || "").toLowerCase();
  const origin = String(request.origin || "").toLowerCase();
  const text = requestText(request);
  if (LOCAL_KINDS.has(kind) || origin === "workflow" || origin === "error-supervisor") {
    return { privacyClass: PRIVACY_CLASSES.LOCAL_ONLY, reason: "sensitive_agent_or_workflow_rule" };
  }
  if (kind === "aegis.security" && !(trustedMetadata?.remoteFreeAllowed === true && SYNTHETIC_WORK.test(text))) {
    return { privacyClass: PRIVACY_CLASSES.LOCAL_ONLY, reason: "security_context_requires_local" };
  }
  if (request.sideEffecting === true || (Array.isArray(request.attachments) && request.attachments.length > 0)) {
    return { privacyClass: PRIVACY_CLASSES.LOCAL_ONLY, reason: "side_effect_or_attachment" };
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { privacyClass: PRIVACY_CLASSES.LOCAL_ONLY, reason: "sensitive_pattern" };
  }
  if (trustedMetadata?.remoteFreeAllowed === true) {
    return { privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED, reason: "trusted_internal_approval" };
  }
  return { privacyClass: PRIVACY_CLASSES.PREFER_LOCAL,
    reason: String(request.title || "").trim() && String(request.prompt || "").trim()
      ? "no_trusted_remote_approval" : "insufficient_request_metadata" };
}

export function privacyFinalGate(request = {}, effectivePayload = "", approvalRecord = null, now = Date.now(),
  route = MIMO26_ROUTE, trustedStaticPromptPrefix = null) {
  const trusted = isTrustedRemoteApprovalRecord(approvalRecord, request, now, {
    effectivePayload, provider: route?.provider, model: route?.model,
    effectiveModel: route?.effectiveModel ?? route?.model,
  });
  const privacy = classifyPrivacyPayload(request, effectivePayload, {
    remoteFreeAllowed: trusted && approvalRecord?.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
  }, trustedStaticPromptPrefix);
  return { ...privacy, remoteFallbackAllowed: false };
}

export function privacyContextSourceAllowed(privacyClass, source, sourcePrivacy = "private", routeTier = null) {
  if (REMOTE_ROUTE_TIERS.includes(routeTier)) {
    return String(sourcePrivacy).toLowerCase() === "remote-safe";
  }
  if (privacyClass !== PRIVACY_CLASSES.REMOTE_FREE_ALLOWED) return true;
  return String(sourcePrivacy).toLowerCase() === "remote-safe";
}

export function classifyComplexity(request = {}) {
  const declared = String(request.complexity || request.metadata?.complexity || "").toUpperCase();
  if (Object.values(COMPLEXITY_CLASSES).includes(declared)) return declared;
  const text = requestText(request);
  if (COMPLEX_HINTS.test(text)) return COMPLEXITY_CLASSES.COMPLEX;
  if (INTERMEDIATE_HINTS.test(text)) return COMPLEXITY_CLASSES.INTERMEDIATE;
  if (SIMPLE_HINTS.test(text) && text.length < 1200) return COMPLEXITY_CLASSES.SIMPLE;
  if (text.trim().length < 180 && !/[?？].*[?？]/s.test(text)) return COMPLEXITY_CLASSES.SIMPLE;
  return COMPLEXITY_CLASSES.INTERMEDIATE;
}

export function stableCanaryBucket(requestId) {
  if (!requestId) return null;
  const hex = createHash("sha256").update(String(requestId)).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

export function canaryEligible(request = {}) {
  const kind = String(request.kind || "");
  const expectedAction = kind === "atlas.research" ? "research" : "coordinate";
  return (kind === "max.chief-of-staff" || kind === "max.deep-analysis" || kind === "atlas.research")
    && request.sideEffecting === false
    && !["workflow", "error-supervisor"].includes(String(request.origin || "").toLowerCase())
    && !(Array.isArray(request.attachments) && request.attachments.length)
    && (!request.action || request.action === expectedAction);
}

export function healthCacheAllowsCanary(health, now = Date.now()) {
  return Boolean(healthCacheAllowsRoute(health, MIMO26_ROUTE, now));
}

export function healthCacheAllowsRoute(health, route, now = Date.now()) {
  const supported = isOperationallyEligibleRemoteRoute(route?.provider, route?.model);
  const routeIdentity = ROUTABLE_REMOTE_ROUTE_CANDIDATES.some((candidate) =>
    candidate.provider === route?.provider && candidate.model === route?.model);
  return Boolean(healthIsFresh(health, now) && supported && routeIdentity
    && health.provider === route.provider
    && health.requested_model === route.model && health.freePrice === true
    && health.verified_free === true && health.catalogVerified === true);
}

export function normalizeCanaryPercent(value) {
  if (value === null || value === undefined || value === "") return 0;
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.floor(Math.max(0, Math.min(10, percent))) : 0;
}

export function selectRoute({
  request, privacy, complexity, flags, health, breaker, qwenAvailability, now = Date.now(),
  allowHalfOpenProbe = false, allowHalfOpenProbeFor = null, remoteRoutes = null,
}) {
  const unavailableLocal = { ...QWEN_ROUTE, tier: "local_model_unavailable", routeReason: "local_model_not_configured" };
  const remoteSafeRequest = request?.capability === "read_only"
    && request?.sideEffecting === false
    && !(Array.isArray(request?.attachments) && request.attachments.length)
    && !["workflow", "error-supervisor"].includes(String(request?.origin || "").toLowerCase());
  const routes = Array.isArray(remoteRoutes) ? remoteRoutes : [{
    ...TOKENHARBOR_DEEPSEEK_FREE_ROUTE, health, breaker,
    routeKey: `${TOKENHARBOR_DEEPSEEK_FREE_ROUTE.provider}:${TOKENHARBOR_DEEPSEEK_FREE_ROUTE.model}`,
    halfOpenClaimed: allowHalfOpenProbe,
  }];
  const usableRoutes = routes.filter((candidate) => {
    const candidateBreaker = candidate.breaker || {};
    const halfOpenAllowed = candidateBreaker.state === PROVIDER_BREAKER_STATES.HALF_OPEN
      && (candidate.halfOpenClaimed === true || candidate.routeKey === allowHalfOpenProbeFor
        || (!Array.isArray(remoteRoutes) && allowHalfOpenProbe === true));
    return healthCacheAllowsRoute(candidate.health, candidate, now)
      && (halfOpenAllowed || !isCircuitOpen(candidateBreaker, now));
  });
  const remoteReady = remoteSafeRequest && flags?.remoteRoutingDisabled !== true && usableRoutes.length > 0;
  const routeFor = (candidate, tier, routeReason) => ({
    provider: candidate.provider, model: candidate.model, reasoning: candidate.reasoning || "low",
    tier, routeReason, routeKey: candidate.routeKey || `${candidate.provider}:${candidate.model}`,
  });
  if (privacy?.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY) {
    return { ...unavailableLocal, routeReason: "local_only_model_unavailable" };
  }
  if (privacy?.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED) {
    if (remoteReady) {
      if (flags?.e2eCandidate === true) {
        const selected = usableRoutes[0];
        return { ...routeFor(selected, "remote_free_primary", "synthetic_remote_free_validation"), canaryBucket: null };
      }
      const selected = usableRoutes[0];
      return { ...routeFor(selected, selected === routes[0] ? "remote_free_primary" : "remote_free_failover",
        selected === routes[0] ? "remote_free_primary" : "remote_free_pool_failover"), canaryBucket: null };
    }
    return { ...TOKENHARBOR_DEEPSEEK_FREE_ROUTE, tier: "remote_free_unavailable", routeReason: "verified_remote_unavailable" };
  }
  return unavailableLocal;
}

export function classifyProviderFailure(error) {
  if (error && typeof error === "object" && Object.hasOwn(error, "transportAttempted")) {
    if (error.transportAttempted === false) return "pre_transport_error";
    if (error.transportAttempted !== true && !verifiedHttpStatus(error)) return "transport_outcome_unknown";
  }
  const status = verifiedHttpStatus(error);
  if (status === 402) return "payment_required";
  if (status === 429) return "rate_limited";
  if (status === 403 && error?.provider === OPENCODE_ZEN_FREE_ROUTE.provider
      && error?.model === OPENCODE_ZEN_FREE_ROUTE.model
      && error?.safeErrorType === "FreeTierError") return "provider_policy_restricted";
  if (status === 401 && error?.provider === GROQ_FREE_ROUTE.provider
      && error?.model === GROQ_FREE_ROUTE.model) return "auth_failure";
  if (status === 403 && error?.provider === GROQ_FREE_ROUTE.provider
      && error?.model === GROQ_FREE_ROUTE.model) return "auth_or_provider_policy";
  if (status === 401 || status === 403) return "auth_denied";
  if (status === 503) return "provider_503";
  if (status >= 500 && status <= 599) return "provider_5xx";
  // Closed, payload-free diagnostics emitted by the pinned Cohere adapter
  // after HTTP 200. Preserve the reason in the attempt ledger; route-executor
  // failover remains restricted to its explicit HTTP/provider-capacity allowlist.
  if ([
    "openrouter_response_model_mismatch",
    "openrouter_response_provider_mismatch",
    "openrouter_output_truncated",
    "openrouter_finish_reason_rejected",
    "openrouter_content_empty",
    "openrouter_response_invalid",
  ].includes(String(error?.code || ""))) return String(error.code);
  if (error?.transportAttempted === true
      && (["ETIMEDOUT", "ETIMEOUT"].includes(String(error?.code || "").toUpperCase())
        || String(error?.signal || "").toUpperCase() === "SIGTERM")) return "timeout";
  if (error?.transportAttempted === true
      && ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]
        .includes(String(error?.code || "").toUpperCase())) return "network_error";
  return "transport_outcome_unknown";
}

export function verifiedHttpStatus(error) {
  const candidates = [error?.remoteHttpStatus, error?.httpStatus, error?.statusCode,
    error?.response?.statusCode, error?.response?.status];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

export function retryRemoteInference(_errorClass, _attemptNo) {
  // A canary inference is never replayed after an ambiguous provider outcome.
  return false;
}

export function canaryAutoDisableReason({
  privacyFinalGateBlocked = false, permitViolation = false, readinessInvalid = false,
  qwenFallbackFailed = false, provenanceMismatch = false, verifiedFreeContradiction = false, errorClass = null,
  consecutiveFailures = 0,
} = {}) {
  if (permitViolation) return "permit_violation";
  if (privacyFinalGateBlocked) return "privacy_final_gate_blocked";
  if (verifiedFreeContradiction) return "verified_free_contradiction";
  if (provenanceMismatch) return "provenance_mismatch";
  if (errorClass === "payment_required") return "payment_required";
  return null;
}

export function shouldRecordInferenceAttempt({ oneShot, requestId } = {}) {
  return oneShot === true && typeof requestId === "string" && requestId.trim().length > 0;
}

export function normalizeInferenceProvenance({
  usage = {}, effectiveProvider = "unknown", effectiveModel = "unknown",
  requestedProvider = "unknown", requestedModel = "unknown", routing = null, status = "success", errorClass = null,
  transportAttempted = null, httpStatus = null,
} = {}) {
  const nonNegativeInteger = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  const nonNegativeNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const reportedInputTokens = nonNegativeInteger(usage.input_tokens);
  const reportedOutputTokens = nonNegativeInteger(usage.output_tokens);
  const reportedTotalTokens = nonNegativeInteger(usage.total_tokens);
  const reportedReasoningTokens = nonNegativeInteger(usage.reasoning_tokens);
  const reportedCacheReadTokens = nonNegativeInteger(usage.cache_read_tokens);
  const reportedCacheWriteTokens = nonNegativeInteger(usage.cache_write_tokens);
  const primaryUsageReported = [reportedInputTokens, reportedOutputTokens, reportedTotalTokens]
    .some((value) => value !== null && value > 0);
  const totalTokens = reportedTotalTokens !== null && reportedTotalTokens > 0
    ? reportedTotalTokens
    : reportedInputTokens !== null && reportedOutputTokens !== null
      && (reportedInputTokens > 0 || reportedOutputTokens > 0)
      ? reportedInputTokens + reportedOutputTokens : null;
  const auxiliary = usage.auxiliary && typeof usage.auxiliary === "object" && !Array.isArray(usage.auxiliary)
    ? usage.auxiliary : null;
  const auxiliaryTotalTokens = auxiliary ? nonNegativeInteger(auxiliary.total_tokens) : null;
  const totalIncludingAuxiliary = usage.total_including_auxiliary
    && typeof usage.total_including_auxiliary === "object" && !Array.isArray(usage.total_including_auxiliary)
    ? nonNegativeInteger(usage.total_including_auxiliary.total_tokens) : null;
  const anyUsageReported = primaryUsageReported
    || [reportedReasoningTokens, reportedCacheReadTokens, reportedCacheWriteTokens, auxiliaryTotalTokens, totalIncludingAuxiliary]
      .some((value) => value !== null && value > 0);
  const rawHttpStatus = nonNegativeInteger(usage.remote_http_status) ?? nonNegativeInteger(httpStatus);
  const verifiedHttpStatus = rawHttpStatus !== null && rawHttpStatus >= 100 && rawHttpStatus <= 599
    ? rawHttpStatus : null;
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(usage, key);
  const route = routing?.currentRemoteRoute || routing?.modelRoute || {};
  const routeRequestedProvider = String(route.provider || requestedProvider);
  const routeRequestedModel = String(route.model || requestedModel);
  const knownObservedValue = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim();
    return ["default", "unknown"].includes(text.toLowerCase()) ? null : text;
  };
  const isUnobservedPlaceholder = (value) => typeof value === "string"
    && ["default", "unknown"].includes(value.trim().toLowerCase());
  const actualProvider = knownObservedValue(usage.actual_provider)
    || (!isUnobservedPlaceholder(usage.actual_provider)
      ? knownObservedValue(usage.provider) || (!hasOwn("actual_provider") ? knownObservedValue(effectiveProvider) : null)
      : null)
    || (String(usage.actual_provider || "").trim().toLowerCase() === "not_invoked" ? "not_invoked" : "unknown");
  const actualModel = knownObservedValue(usage.actual_model)
    || (!isUnobservedPlaceholder(usage.actual_model)
      ? knownObservedValue(usage.served_model) || knownObservedValue(usage.model) || (!hasOwn("actual_model") ? knownObservedValue(effectiveModel) : null)
      : null)
    || (String(usage.actual_model || "").trim().toLowerCase() === "not_invoked" ? "not_invoked" : "unknown");
  const routeTier = route.tier || routing?.modelRoute?.tier;
  const selectedReadiness = routing?.remoteReadiness?.[`${routeRequestedProvider}:${routeRequestedModel}`]
    || routing?.readiness;
  const tokenHarborActualMatches = actualProvider === "Token Harbor"
    && (actualModel === routeRequestedModel
      || (TOKENHARBOR_ALLOWED_ACTUAL_MODELS.includes(actualModel)
        && selectedReadiness?.provider === TOKENHARBOR_DEEPSEEK_FREE_ROUTE.provider
        && selectedReadiness?.requested_model === TOKENHARBOR_DEEPSEEK_FREE_ROUTE.model
        && selectedReadiness?.verified_free === true
        && selectedReadiness?.catalogVerified === true
        && selectedReadiness?.catalogSource === "authenticated_model_catalog"));
  // Keep requested and actual IDs distinct, and accept only the exact provider/model pair
  // observed for each approved free transport. Token Harbor's one canonical served ID is
  // accepted only when the same request carries fresh authenticated catalog evidence.
  const expectedActual = routeRequestedProvider === TOKENHARBOR_DEEPSEEK_FREE_ROUTE.provider
    ? tokenHarborActualMatches
    : routeRequestedProvider === OPENROUTER_COHERE_FREE_ROUTE.provider
      ? actualProvider === "Cohere" && actualModel === OPENROUTER_COHERE_FREE_ROUTE.model
      : routeRequestedProvider === GROQ_FREE_ROUTE.provider
      ? actualProvider === "Groq" && actualModel === GROQ_FREE_ROUTE.model
      : routeRequestedProvider === OPENCODE_ZEN_FREE_ROUTE.provider
        ? actualProvider === "OpenCode Zen" && actualModel === OPENCODE_ZEN_FREE_ROUTE.model
        : false;
  const freeRouteIdentityMatches = isVerifiedFreeRemoteRoute(routeRequestedProvider, routeRequestedModel)
    && expectedActual && REMOTE_ROUTE_TIERS.includes(routeTier);
  const usageTransportKnown = typeof usage.remote_attempted === "boolean";
  const remoteAttemptedKnown = usageTransportKnown || typeof transportAttempted === "boolean";
  const remoteAttempted = usageTransportKnown ? usage.remote_attempted : transportAttempted === true;
  const remoteAttemptStatus = !remoteAttempted ? (remoteAttemptedKnown ? "not_attempted" : "unknown")
    : (status === "success" && usage.remote_attempt_status === "success" ? "success"
      : (["payment_required", "rate_limited", "auth_denied", "provider_policy_restricted"].includes(errorClass) ? "failed"
        : (["timeout", "provider_5xx", "provider_503"].includes(errorClass) || usage.remote_attempt_status === "uncertain"
          ? "uncertain" : "failed")));
  const routeReason = String(routing?.currentRemoteRoute?.routeReason || routing?.routeReason
    || routing?.modelRoute?.routeReason || routing?.modelRoute?.tier || "unspecified");
  const qwenStatus = routing?.qwenAvailability?.status;
  const qwenAvailable = qwenStatus === "QWEN_AVAILABLE" ? true
    : qwenStatus === "QWEN_UNAVAILABLE" ? false
      : qwenStatus === "QWEN_UNKNOWN" ? null
        : typeof routing?.qwenAvailable === "boolean" ? routing.qwenAvailable : null;
  const remoteAttemptCount = nonNegativeInteger(routing?.remoteAttemptCount) ?? (remoteAttempted ? 1 : 0);
  const verifiedFreeEvidence = freeRouteIdentityMatches
    || (isVerifiedFreeRemoteRoute(routeRequestedProvider, routeRequestedModel)
      && REMOTE_ROUTE_TIERS.includes(routeTier) && selectedReadiness?.verified_free === true);
  const incomingCostStatus = String(usage.cost_status || "unknown").trim().toLowerCase();
  const reportedCost = nonNegativeNumber(usage.actual_cost_usd ?? usage.estimated_cost_usd);
  // Hermes' `estimated_cost_usd` can be priced from the public paid rate card even when the
  // account's verified route is free. Only an actual positive charge (or explicit paid status)
  // contradicts the free-route contract; estimates and absent transport evidence do not.
  const verifiedFreeCostContradiction = verifiedFreeEvidence
    && (incomingCostStatus === "paid"
      || (incomingCostStatus === "actual" && reportedCost !== null && reportedCost > 0));
  const freeRoute = freeRouteIdentityMatches && remoteAttempted && !verifiedFreeCostContradiction;
  const verifiedFree = freeRoute && verifiedFreeEvidence;
  const persistableCostStatus = incomingCostStatus === "paid" ? "paid"
    : incomingCostStatus === "reported_zero" ? "reported_zero"
      : incomingCostStatus === "actual" && reportedCost !== null
        ? (reportedCost > 0 ? "paid" : "reported_zero") : "unknown";
  const qwenState = qwenStatus === "QWEN_AVAILABLE" ? "available"
    : qwenStatus === "QWEN_UNAVAILABLE" ? "unavailable"
      : qwenStatus === "QWEN_UNKNOWN" ? "unknown" : "unknown";
  const persistedReason = "route_reason=" + routeReason
    + ";qwen_state=" + qwenState
    + ";qwen_available=" + (qwenAvailable === null ? "unknown" : String(qwenAvailable))
    + ";verified_free=" + String(verifiedFree)
    + ";verified_free_cost_contradiction=" + String(verifiedFreeCostContradiction)
    + ";remote_attempt_count=" + String(remoteAttemptCount)
    + ";fallback_count=" + String(nonNegativeInteger(routing?.fallbackCount) ?? 0)
    + ";permit_consumed=" + String(routing?.routerPermitStatus === "CONSUMED")
    + (Array.isArray(routing?.qwenTransitionTrace) && routing.qwenTransitionTrace.length
      ? ";qwen_transition=" + routing.qwenTransitionTrace.join(",") : "");
  return Object.freeze({
    requestedProvider: routeRequestedProvider,
    requestedModel: routeRequestedModel,
    actualProvider,
    actualModel,
    remoteAttempted,
    remoteAttemptStatus,
    fallbackCount: nonNegativeInteger(routing?.fallbackCount) ?? 0,
    failoverReason: routing?.fallbackReason || (status === "failed" ? errorClass : null),
    routeReason, qwenAvailable, remoteAttemptCount, verifiedFree, verifiedFreeCostContradiction, persistedReason,
    freeRoute,
    routeCostPolicy: verifiedFree ? "catalog_verified_free" : null,
    promptTokens: primaryUsageReported ? reportedInputTokens : null,
    completionTokens: primaryUsageReported ? reportedOutputTokens : null,
    totalTokens,
    usageSource: anyUsageReported ? "hermes_usage_file" : "unknown",
    httpStatus: verifiedHttpStatus,
    reasoningTokens: anyUsageReported ? reportedReasoningTokens : null,
    cacheReadTokens: anyUsageReported ? reportedCacheReadTokens : null,
    cacheWriteTokens: anyUsageReported ? reportedCacheWriteTokens : null,
    auxiliaryTotalTokens: auxiliary ? auxiliaryTotalTokens : null,
    totalIncludingAuxiliaryTokens: totalIncludingAuxiliary !== null && totalIncludingAuxiliary > 0
      ? totalIncludingAuxiliary : null,
    usageScope: anyUsageReported
      ? (auxiliary ? "hermes_oneshot_main_loop_cache_in_prompt_auxiliary_separate"
        : "hermes_oneshot_main_loop_cache_in_prompt") : null,
    reportedCost: verifiedFree && incomingCostStatus !== "actual" ? 0 : reportedCost,
    costSource: verifiedFree ? (routeRequestedProvider === TOKENHARBOR_DEEPSEEK_FREE_ROUTE.provider
      ? "tokenharbor_authenticated_model_catalog"
      : routeRequestedProvider === OPENROUTER_COHERE_FREE_ROUTE.provider
        ? "openrouter_live_model_catalog" : null)
      : (usage.cost_source ? String(usage.cost_source) : null),
    costStatus: verifiedFreeCostContradiction ? "paid" : verifiedFree ? "verified_free" : persistableCostStatus,
    costCurrency: freeRoute ? "USD" : (usage.cost_currency ? String(usage.cost_currency) : null),
    apiCalls: nonNegativeInteger(usage.api_calls),
    finishReason: usage.finish_reason ? String(usage.finish_reason) : null,
  });
}

export function inferenceProvenanceRuntimeSummary(provenance, routing = {}) {
  if (!provenance || typeof provenance !== "object") return null;
  const qwenStatus = routing?.qwenAvailability?.status;
  const qwenState = qwenStatus === "QWEN_AVAILABLE" ? "available"
    : qwenStatus === "QWEN_UNAVAILABLE" ? "unavailable" : "unknown";
  const attemptNo = Number(routing?.lastAttemptNo);
  return Object.freeze({
    privacy_class: String(routing?.privacyClass || "unknown"),
    route_tier: String(routing?.currentRemoteRoute?.tier || routing?.modelRoute?.tier || "unknown"),
    requested_provider: provenance.requestedProvider,
    requested_model: provenance.requestedModel,
    actual_provider: provenance.actualProvider,
    actual_model: provenance.actualModel,
    qwen_state: qwenState,
    qwen_transition: Array.isArray(routing?.qwenTransitionTrace) && routing.qwenTransitionTrace.length
      ? routing.qwenTransitionTrace.join(" -> ") : null,
    route_reason: provenance.routeReason,
    remote_attempted: provenance.remoteAttempted === true,
    remote_attempt_status: provenance.remoteAttemptStatus,
    remote_attempt_count: provenance.remoteAttemptCount,
    fallback_count: provenance.fallbackCount,
    verified_free: provenance.verifiedFree === true,
    free_route: provenance.freeRoute === true,
    cost_status: provenance.costStatus,
    route_cost_policy: provenance.routeCostPolicy,
    permit_status: routing?.routerPermitStatus === "CONSUMED" ? "CONSUMED" : "NOT_CONSUMED",
    attempt_no: Number.isSafeInteger(attemptNo) && attemptNo > 0 ? attemptNo : null,
  });
}

export function buildInferenceAttemptInsert({
  id, requestId, attemptNo, provenance, status, errorClass, durationMs,
  privacyClass, complexityClass, routeTier, structuredOutputValid, startedAt = null,
}) {
  // The schema represents an unknown transport outcome with NULL; runtime summaries render it as "unknown".
  const persistedRemoteAttemptStatus = ["not_attempted", "success", "uncertain", "failed"].includes(provenance.remoteAttemptStatus)
    ? provenance.remoteAttemptStatus : null;
  const text = [
    'INSERT INTO "InferenceAttempt" (id,request_id,attempt_no,provider,model,requested_provider,requested_model,actual_provider,actual_model,gateway,status,reason,error_class,failover_reason,duration_ms,privacy_class,complexity_class,route_tier,fallback_count,finish_reason,structured_output_valid,prompt_tokens,completion_tokens,total_tokens,reported_cost,cost_source,cost_status,cost_currency,free_route,route_cost_policy,api_calls,remote_attempted,remote_attempt_status,started_at,http_status,usage_source,reasoning_tokens,cache_read_tokens,cache_write_tokens,auxiliary_total_tokens,total_including_auxiliary_tokens,usage_scope,finished_at)',
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'hermy-hq-bridge',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,now()) RETURNING id",
  ].join(" ");
  return {
    text,
    values: [
      id, requestId, attemptNo, provenance.actualProvider, provenance.actualModel,
      provenance.requestedProvider, provenance.requestedModel, provenance.actualProvider, provenance.actualModel,
      status, provenance.persistedReason, errorClass, provenance.failoverReason, durationMs, privacyClass, complexityClass, routeTier,
      provenance.fallbackCount, provenance.finishReason, structuredOutputValid, provenance.promptTokens,
      provenance.completionTokens, provenance.totalTokens, provenance.reportedCost, provenance.costSource,
      provenance.costStatus, provenance.costCurrency, provenance.freeRoute, provenance.routeCostPolicy,
      provenance.apiCalls, provenance.remoteAttempted, persistedRemoteAttemptStatus,
      startedAt, provenance.httpStatus, provenance.usageSource, provenance.reasoningTokens,
      provenance.cacheReadTokens, provenance.cacheWriteTokens, provenance.auxiliaryTotalTokens,
      provenance.totalIncludingAuxiliaryTokens, provenance.usageScope,
    ],
  };
}

export async function persistInferenceAttempt(query, attempt) {
  if (typeof query !== "function") throw new TypeError("inference persistence requires a query adapter");
  const insert = buildInferenceAttemptInsert(attempt);
  const result = await query(insert.text, insert.values);
  return result.rows?.[0]?.id ?? null;
}

export function isCircuitOpen(state, now = Date.now()) {
  return Boolean(state?.state === PROVIDER_BREAKER_STATES.OPEN
    || state?.state === PROVIDER_BREAKER_STATES.HALF_OPEN
    || state?.disabled === true || Number(state?.cooldownUntil || 0) > now);
}

export function resetCircuitState() {
  return {
    state: PROVIDER_BREAKER_STATES.CLOSED, providerFailureCount: 0, consecutiveFailures: 0,
    lastFailureAt: null, openedAt: null, cooldownUntil: 0, disabled: false, reason: null,
    lastProviderFailureClass: null, lastVerifiedHttpStatus: null,
  };
}

export function nextCircuitState(current = {}, errorClass, now = Date.now()) {
  if (["pre_transport_error", "transport_outcome_unknown"].includes(errorClass)) return { ...current };
  const consecutiveFailures = Math.max(0, Number(current.providerFailureCount ?? current.consecutiveFailures) || 0) + 1;
  const cooldownMs = errorClass === "payment_required" ? Number.MAX_SAFE_INTEGER
    : errorClass === "rate_limited" ? 30 * 60 * 1000
    : errorClass === "auth_denied" ? 60 * 60 * 1000
    : ["provider_5xx", "provider_503"].includes(errorClass) && consecutiveFailures >= 2 ? 5 * 60 * 1000
    : ["timeout", "network_error"].includes(errorClass) && consecutiveFailures >= 2 ? 2 * 60 * 1000
    : 0;
  return {
    state: cooldownMs || current.state === PROVIDER_BREAKER_STATES.HALF_OPEN
      ? PROVIDER_BREAKER_STATES.OPEN : PROVIDER_BREAKER_STATES.CLOSED,
    providerFailureCount: consecutiveFailures,
    consecutiveFailures,
    lastFailureAt: now,
    cooldownUntil: cooldownMs ? now + cooldownMs : 0,
    disabled: errorClass === "payment_required",
    reason: errorClass,
    lastProviderFailureClass: errorClass,
    lastVerifiedHttpStatus: null,
  };
}

export function finalGateRoute({ request, effectivePayload, approvalRecord, requestedRoute, now = Date.now(),
  trustedStaticPromptPrefix = null }) {
  const decision = privacyFinalGate(request, effectivePayload, approvalRecord, now, requestedRoute,
    trustedStaticPromptPrefix);
  if (decision.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED || decision.remoteFallbackAllowed === true) {
    return { allowed: true, privacy: decision, route: requestedRoute };
  }
  return { allowed: false, privacy: decision, route: { ...QWEN_ROUTE, tier: "local_final_gate_fallback" } };
}

export function buildCanaryArgs(route, prompt) {
  return ["--safe-mode", "--provider", route.provider, "-m", route.model,
    "--reasoning", route.reasoning || "low", "-z", String(prompt || "")];
}

export function preparePrivacyInvocation(args, { request, approvalRecord = null, now = Date.now(),
  trustedStaticPromptPrefix = null } = {}) {
  const prepared = [...args];
  const promptFlag = prepared.includes("-z") ? "-z" : prepared.includes("--oneshot") ? "--oneshot" : null;
  if (!promptFlag) throw new Error("privacy-routed invocation must be one-shot");
  const promptIndex = prepared.indexOf(promptFlag);
  const effectivePayload = String(prepared[promptIndex + 1] || "");
  let provider = prepared.includes("--provider") ? String(prepared[prepared.indexOf("--provider") + 1] || "") : "";
  let modelFlag = prepared.includes("-m") ? "-m" : prepared.includes("--model") ? "--model" : null;
  let model = modelFlag ? String(prepared[prepared.indexOf(modelFlag) + 1] || "") : "";
  let finalGateBlocked = false;
  let remoteApproved = false;
  let decision = null;
  const qwen = provider === QWEN_ROUTE.provider && model === QWEN_ROUTE.model;
  const remote = isSupportedRemoteRoute(provider, model);

  if (remote) {
    decision = finalGateRoute({
      request, effectivePayload, approvalRecord, requestedRoute: { provider, model }, now,
      trustedStaticPromptPrefix,
    });
    if (!decision.allowed) {
      finalGateBlocked = true;
      for (const flag of ["--provider", "-m", "--model"]) {
        const index = prepared.indexOf(flag);
        if (index >= 0) prepared.splice(index, 2);
      }
      prepared.unshift("--provider", QWEN_ROUTE.provider, "-m", QWEN_ROUTE.model,
        "--reasoning", QWEN_ROUTE.reasoning);
      provider = QWEN_ROUTE.provider;
      model = QWEN_ROUTE.model;
      modelFlag = "-m";
    } else {
      remoteApproved = isTrustedRemoteApprovalRecord(approvalRecord, request, now, {
        effectivePayload, provider, model,
      });
    }
  } else if (!qwen) {
    finalGateBlocked = true;
    decision = { allowed: false, privacy: { privacyClass: PRIVACY_CLASSES.PREFER_LOCAL, reason: "unapproved_provider_route" } };
    for (const flag of ["--provider", "-m", "--model"]) {
      const index = prepared.indexOf(flag);
      if (index >= 0) prepared.splice(index, 2);
    }
    prepared.unshift("--provider", QWEN_ROUTE.provider, "-m", QWEN_ROUTE.model,
      "--reasoning", QWEN_ROUTE.reasoning);
    provider = QWEN_ROUTE.provider;
    model = QWEN_ROUTE.model;
    modelFlag = "-m";
  }

  // Callers cannot smuggle authorization in their original argv. Rebuild these
  // controls solely from the validated in-memory routing decision above.
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    if (["--privacy-routing", "--privacy-tool-free", "--privacy-final-gate", "--privacy-remote-approved"].includes(prepared[index])) {
      prepared.splice(index, 1);
    } else if (prepared[index] === "--privacy-payload-sha256") {
      prepared.splice(index, 2);
    }
  }
  if (!prepared.includes("--no-fallback")) prepared.push("--no-fallback");
  prepared.push("--privacy-routing", "--privacy-final-gate");
  if (prepared.includes("--safe-mode")) prepared.push("--privacy-tool-free");
  if (remoteApproved && !finalGateBlocked) {
    prepared.push("--privacy-remote-approved", "--privacy-payload-sha256",
      createHash("sha256").update(effectivePayload).digest("hex"));
  }
  return {
    args: prepared, finalGateBlocked, remoteApproved, provider, model,
    privacy: decision?.privacy || null,
  };
}

export function validateStrictJson(text) {
  try {
    return { valid: true, value: JSON.parse(String(text)) };
  } catch {
    return { valid: false, value: null };
  }
}

export async function runStrictJsonWithSingleRepair({ invoke, prompt, repairPrompt, onValidation = null }) {
  let text = String(await invoke(String(prompt || "")) ?? "");
  let parsed = validateStrictJson(text);
  await onValidation?.({ valid: parsed.valid, attempt: 1 });
  if (parsed.valid) return { text, valid: true, attempts: 1 };
  text = String(await invoke(String(await repairPrompt(String(prompt || ""), text)) ?? ""));
  parsed = validateStrictJson(text);
  await onValidation?.({ valid: parsed.valid, attempt: 2 });
  return { text, valid: parsed.valid, attempts: 2 };
}
