import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function safeEpoch(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeHttpStatus(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

export async function GET() {
  const routerKey = "privacy-model-router-v2";
  const primaryBreakerKey = "model-router-breaker:v1:custom:tokenharbor:mimo-v2.6-flash:free";
  const openCodeZenBreakerKey = "model-router-breaker:v1:opencode-zen:nemotron-3.5-lightning-free";
  const groqBreakerKey = "model-router-breaker:v1:groq:openai/gpt-oss-120b";
  const openRouterBreakerKey = "model-router-breaker:v1:openrouter:nvidia/nemotron-3-ultra-550b-a55b:free";
  const keys = [
    "hermes-health",
    routerKey,
    primaryBreakerKey,
    openCodeZenBreakerKey,
    groqBreakerKey,
    openRouterBreakerKey,
  ];
  const [rows, latestAttempt] = await Promise.all([
    prisma.dataStore.findMany({ where: { key: { in: keys } } }),
    prisma.inferenceAttempt.findFirst({
      orderBy: [{ finished_at: "desc" }, { created_at: "desc" }],
      select: {
        requested_provider: true, requested_model: true, actual_provider: true,
        actual_model: true, reason: true, fallback_count: true, remote_attempted: true,
        remote_attempt_status: true,
      },
    }),
  ]);
  const byKey = new Map(rows.map((row) => [row.key, asRecord(row.data)]));
  const raw = byKey.get("hermes-health") || {};
  const router = byKey.get(routerKey) || {};
  const breaker = byKey.get(primaryBreakerKey) || {};
  const legacyProviderDisable = router.remoteRoutingDisabled === true
    && router.autoDisableReason === "repeated_provider_failure"
    && router.securityDisabled !== true && !router.securityDisableReason;
  const securityDisabled = router.securityDisabled === true
    || (router.remoteRoutingDisabled === true && !legacyProviderDisable);
  const cooldownUntil = safeEpoch(breaker.cooldownUntil ?? breaker.providerBreakerCooldownUntil) || 0;
  const failureCountRaw = Number(breaker.providerFailureCount ?? breaker.consecutiveFailures ?? 0);
  const providerFailureCount = Number.isSafeInteger(failureCountRaw) && failureCountRaw >= 0 ? failureCountRaw : 0;
  const knownStates = new Set(["CLOSED", "OPEN", "HALF_OPEN"]);
  const reason = String(breaker.lastProviderFailureClass || breaker.reason || "");
  const legacyProviderOpen = legacyProviderDisable || breaker.disabled === true || cooldownUntil > Date.now()
    || ["payment_required", "rate_limited", "auth_denied"].includes(reason)
    || (["provider_5xx", "provider_503", "timeout"].includes(reason) && providerFailureCount >= 2);
  const storedBreakerState = String(breaker.state);
  const providerBreakerState = legacyProviderDisable && storedBreakerState === "CLOSED"
    ? "OPEN"
    : knownStates.has(storedBreakerState) ? storedBreakerState : legacyProviderOpen ? "OPEN" : "CLOSED";
  const lastClassAllowlist = new Set([
    "legacy_unverified", "payment_required", "rate_limited", "auth_denied", "provider_503",
    "provider_5xx", "timeout", "transport_outcome_unknown", "pre_transport_error", "provider_error",
    "provider_policy_restricted", "auth_failure", "auth_or_provider_policy", "transport_error",
  ]);
  const candidateClass = legacyProviderDisable ? "legacy_unverified" : reason;
  const health = asRecord(router.health);
  const healthByRoute = asRecord(router.healthByRoute);
  const openCodeZenBreaker = byKey.get(openCodeZenBreakerKey) || {};
  const groqBreaker = byKey.get(groqBreakerKey) || {};
  const openRouterBreaker = byKey.get(openRouterBreakerKey) || {};
  const qwen = asRecord(router.qwenAvailability);
  const readinessStatuses = new Set(["healthy", "unhealthy", "unknown", "probing", "stale",
    "rate_limited", "auth_failure", "auth_or_provider_policy", "provider_error", "pre_transport_error",
    "transport_error", "transport_outcome_unknown", "payment_required"]);
  const qwenStatuses = new Set(["QWEN_AVAILABLE", "QWEN_UNAVAILABLE", "QWEN_UNKNOWN"]);
  const routeDefinitions = [
    {
      id: "custom:tokenharbor/mimo-v2.6-flash:free",
      provider: "custom:tokenharbor", model: "mimo-v2.6-flash:free",
      health: asRecord(healthByRoute["custom:tokenharbor:mimo-v2.6-flash:free"] || health),
      breaker, legacy: legacyProviderDisable, operationallyEligible: true,
    },
    {
      id: "opencode-zen/nemotron-3.5-lightning-free",
      provider: "opencode-zen", model: "nemotron-3.5-lightning-free",
      health: asRecord(healthByRoute["opencode-zen:nemotron-3.5-lightning-free"]),
      breaker: openCodeZenBreaker, legacy: false, operationallyEligible: false,
      classification: "provider_policy_restricted", reason: "third_party_free_tier_forbidden",
      safeErrorType: "FreeTierError",
    },
    {
      id: "groq/openai/gpt-oss-120b",
      provider: "groq", model: "openai/gpt-oss-120b",
      health: asRecord(healthByRoute["groq:openai/gpt-oss-120b"]),
      breaker: groqBreaker, legacy: false, operationallyEligible: true,
    },
    {
      id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      health: asRecord(healthByRoute["openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"]),
      breaker: openRouterBreaker, legacy: false, operationallyEligible: true,
    },
  ];
  const providerBreakers = Object.fromEntries(routeDefinitions.map((route) => {
    const countRaw = Number(route.breaker.providerFailureCount ?? route.breaker.consecutiveFailures ?? 0);
    const count = Number.isSafeInteger(countRaw) && countRaw >= 0 ? countRaw : 0;
    const routeCooldown = safeEpoch(route.breaker.cooldownUntil ?? route.breaker.providerBreakerCooldownUntil) || 0;
    const routeReason = String(route.breaker.lastProviderFailureClass || route.breaker.reason || "");
    const forcedOpen = route.legacy || route.breaker.disabled === true || routeCooldown > Date.now()
      || ["payment_required", "rate_limited", "auth_denied"].includes(routeReason)
      || (["provider_5xx", "provider_503", "timeout", "network_error"].includes(routeReason) && count >= 2);
    const rawState = String(route.breaker.state || "");
    const routeState = route.legacy && rawState === "CLOSED" ? "OPEN"
      : knownStates.has(rawState) ? rawState : forcedOpen ? "OPEN" : "CLOSED";
    const routeClass = route.legacy ? "legacy_unverified" : routeReason;
    const safeErrorType = route.safeErrorType === "FreeTierError" ? "FreeTierError" : null;
    const probeClassification = route.classification === "provider_policy_restricted"
      && safeErrorType === "FreeTierError" && safeHttpStatus(route.health.lastVerifiedHttpStatus) === 403
      ? route.classification : route.health.reason;
    const remoteAttemptStatus = probeClassification === "provider_policy_restricted" ? "failed"
      : ["not_attempted", "success", "failed", "uncertain"].includes(String(route.health.remoteAttemptStatus))
        ? String(route.health.remoteAttemptStatus) : null;
    const routeHealthStatus = readinessStatuses.has(String(route.health.status))
      ? String(route.health.status) : "unknown";
    return [route.id, {
      state: routeState,
      providerFailureCount: count,
      openedAt: safeEpoch(route.breaker.openedAt ?? route.breaker.lastFailureAt),
      cooldownUntil: routeCooldown,
      halfOpenLeaseExpiresAt: routeState === "HALF_OPEN"
        ? safeEpoch(route.breaker.probeLeaseExpiresAt) : null,
      lastTransportClassification: lastClassAllowlist.has(routeClass) ? routeClass : null,
      lastVerifiedHttpStatus: safeHttpStatus(route.breaker.lastVerifiedHttpStatus),
      operationallyEligible: route.operationallyEligible,
      classification: route.classification || null,
      reason: route.reason || null,
      readiness: {
        status: routeHealthStatus,
        checkedAt: safeEpoch(route.health.checkedAt),
        validUntil: safeEpoch(route.health.validUntil),
        verified_free: route.health.verified_free === true,
        transportAttempted: typeof route.health.transportAttempted === "boolean"
          ? route.health.transportAttempted : null,
        remoteAttemptStatus,
        lastProbeClassification: ["pre_transport_error", "transport_outcome_unknown", "payment_required",
          "rate_limited", "auth_denied", "auth_failure", "auth_or_provider_policy", "provider_503",
          "provider_5xx", "provider_error", "transport_error", "timeout", "network_error",
          "credential_unavailable", "provider_policy_restricted"].includes(String(probeClassification))
          ? String(probeClassification) : null,
        safeErrorType,
        lastVerifiedHttpStatus: safeHttpStatus(route.health.lastVerifiedHttpStatus),
        actualProvider: ["Token Harbor", "Groq", "OpenRouter", "OpenCode Zen"].includes(String(route.health.actual_provider))
          ? String(route.health.actual_provider) : null,
        freeEvidenceSource: route.health.freeEvidenceSource === "authenticated_catalog+official_pricing_docs"
          || route.health.freeEvidenceSource === "authenticated_catalog"
          || route.health.freeEvidenceSource === "operator_verified_console_free_plan_2026-10-06+authenticated_catalog+official_free_plan_limits"
          ? route.health.freeEvidenceSource : null,
        accountTier: route.provider === "groq" && route.health.accountTier === "FREE" ? "FREE" : null,
        actualModel: [route.model, "mimo-v2.6-flash"].includes(String(route.health.actual_model))
          ? String(route.health.actual_model) : null,
        requestedModel: route.model,
      },
    }];
  }));
  const safeRouteReason = (value: unknown): string | null => {
    const match = String(value || "").match(/(?:^|;)route_reason=([^;]{1,80})/);
    const allowed = new Set([
      "remote_free_primary", "remote_free_pool_failover", "verified_remote_unavailable",
      "remote_free_provider_failover", "prefer_local_qwen_unavailable_remote_fallback",
      "prefer_local_qwen_unavailable_remote_failover",
      "privacy_local_only", "local_only_qwen_unavailable",
    ]);
    return match && allowed.has(match[1]) ? match[1] : null;
  };
  const recentRouteReason = safeRouteReason(latestAttempt?.reason);
  const recentRequestedProvider = ["custom:tokenharbor", "opencode-zen", "groq", "openrouter", "qwen-local-tailscale", "not_invoked"]
    .includes(String(latestAttempt?.requested_provider)) ? latestAttempt?.requested_provider : null;
  const recentRequestedModel = ["mimo-v2.6-flash:free", "nemotron-3.5-lightning-free",
    "openai/gpt-oss-120b", "nvidia/nemotron-3-ultra-550b-a55b:free", "qwen3-8b-local", "not_invoked"]
    .includes(String(latestAttempt?.requested_model)) ? latestAttempt?.requested_model : null;
  const recentActualProvider = ["Token Harbor", "Groq", "OpenCode Zen", "OpenRouter", "Qwen local", "not_invoked"]
    .includes(String(latestAttempt?.actual_provider)) ? latestAttempt?.actual_provider : null;
  const recentActualModel = ["mimo-v2.6-flash:free", "mimo-v2.6-flash", "nemotron-3.5-lightning-free",
    "openai/gpt-oss-120b", "nvidia/nemotron-3-ultra-550b-a55b:free", "qwen3-8b-local", "not_invoked"]
    .includes(String(latestAttempt?.actual_model)) ? latestAttempt?.actual_model : null;
  const anyRemoteReady = routeDefinitions.some((route) => route.operationallyEligible === true
    && route.health.status === "healthy" && route.health.verified_free === true
    && ["CLOSED", "HALF_OPEN"].includes(providerBreakers[route.id].state));
  const verifiedFreeRoutes = routeDefinitions.filter((route) => route.health.verified_free === true);
  const routableRoutes = routeDefinitions.filter((route) => route.operationallyEligible === true);
  const verifiedFreeProviderCount = new Set(verifiedFreeRoutes.map((route) => route.provider)).size;
  const routableRemoteProviderCount = new Set(routableRoutes.map((route) => route.provider)).size;
  return NextResponse.json({
    online: raw.online === true,
    gateway: typeof raw.gateway === "string" ? raw.gateway : "unknown",
    lastSeen: typeof raw.lastSeen === "string" ? raw.lastSeen : null,
    remoteRoutingState: securityDisabled ? "SECURITY_DISABLED" : anyRemoteReady ? "READY" : "OPEN",
    securityDisabled,
    providerBreakerState,
    providerFailureCount,
    providerBreakerOpenedAt: safeEpoch(breaker.openedAt ?? breaker.lastFailureAt),
    providerBreakerCooldownUntil: cooldownUntil,
    lastProviderFailureClass: lastClassAllowlist.has(candidateClass) ? candidateClass : null,
    lastVerifiedHttpStatus: safeHttpStatus(breaker.lastVerifiedHttpStatus),
    providerBreakers,
    verifiedFreeRemotePool: verifiedFreeRoutes.map((route) => route.id),
    verifiedFreeProviderCount,
    routableRemoteProviderCount,
    routableRemoteModelCount: routableRoutes.length,
    routableRemotePool: routableRoutes.map((route) => route.id),
    requestedProvider: recentRequestedProvider,
    requestedModel: recentRequestedModel,
    actualProvider: recentActualProvider,
    actualModel: recentActualModel,
    routeReason: recentRouteReason,
    fallbackCount: Number.isSafeInteger(Number(latestAttempt?.fallback_count))
      ? Math.max(0, Number(latestAttempt?.fallback_count)) : 0,
    remoteAttemptStatus: ["success", "failed", "uncertain", "not_attempted", "unknown"]
      .includes(String(latestAttempt?.remote_attempt_status)) ? latestAttempt?.remote_attempt_status : "unknown",
    readiness: {
      status: readinessStatuses.has(String(health.status)) ? String(health.status) : "unknown",
      checkedAt: safeEpoch(health.checkedAt),
      validUntil: safeEpoch(health.validUntil),
      verified_free: health.verified_free === true,
    },
    qwenAvailability: {
      status: qwenStatuses.has(String(qwen.status)) ? String(qwen.status) : "QWEN_UNKNOWN",
      available: typeof qwen.available === "boolean" ? qwen.available : null,
      checkedAt: safeEpoch(qwen.checkedAt),
      validUntil: safeEpoch(qwen.validUntil),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
