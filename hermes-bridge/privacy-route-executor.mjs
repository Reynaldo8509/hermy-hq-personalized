import {
  canaryAutoDisableReason, classifyProviderFailure, healthCacheAllowsRoute, isCircuitOpen,
  isSupportedRemoteRoute, MAX_REMOTE_ATTEMPTS_PER_REQUEST, nextCircuitState,
  PRIVACY_CLASSES, REMOTE_ROUTE_TIERS, resetCircuitState, validateStrictJson, verifiedHttpStatus,
} from "./privacy-model-router.mjs";

export { REMOTE_ROUTE_TIERS };

export async function executePrivacyRoutedRequest(request, {
  context, invokeHermes, requestHermesArgs, setStore, log,
  autoDisableCanary = async () => {}, requiresStrictJson,
  validateStrictOutput = (_request, text) => validateStrictJson(text),
  buildStrictOutputFallbackPrompt = (_request, prompt) => prompt + "\n\nReturn one complete valid JSON value only. No prose or markdown.",
  updateStructuredOutputValidation, runTimeoutMs, specialistTimeoutMs,
  recordProviderOutcome,
}) {
  if (!context) throw new Error("privacy routing context is unavailable");
  const route = context.modelRoute;
  if (!route || typeof route !== "object") {
    context.attemptRouteTier = "remote_free_unavailable";
    throw new Error(context.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY
      ? "LOCAL_MODEL_UNAVAILABLE" : "REMOTE_FREE_ROUTE_UNAVAILABLE");
  }
  if (route.tier === "local_model_unavailable") {
    context.attemptRouteTier = route.tier;
    throw new Error("LOCAL_MODEL_UNAVAILABLE");
  }
  if (route.tier === "remote_free_unavailable") {
    context.attemptRouteTier = route.tier;
    throw new Error("REMOTE_FREE_ROUTE_UNAVAILABLE");
  }
  if (!REMOTE_ROUTE_TIERS.includes(route.tier)) {
    context.attemptRouteTier = route.tier || "local_preferred";
    throw new Error(context.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY
      ? "LOCAL_MODEL_UNAVAILABLE" : "REMOTE_FREE_CONSENT_REQUIRED");
  }

  if (!isSupportedRemoteRoute(route.provider, route.model)) {
    throw new Error("REMOTE_FREE_ROUTE_NOT_ALLOWLISTED");
  }
  const remoteRequestEligible = context.privacyClass === PRIVACY_CLASSES.REMOTE_FREE_ALLOWED
    && request?.capability === "read_only"
    && request?.sideEffecting === false
    && !(Array.isArray(request?.attachments) && request.attachments.length > 0)
    && !["workflow", "error-supervisor"].includes(String(request?.origin || "").toLowerCase());
  if (!remoteRequestEligible || context.securityDisabled === true
      || context.finalGateBlocked === true || context.provenanceMismatch === true) {
    context.attemptRouteTier = route.tier;
    throw new Error(context.privacyClass === PRIVACY_CLASSES.LOCAL_ONLY
      ? "LOCAL_ONLY_REMOTE_DENIED" : "REMOTE_FREE_CONSENT_REQUIRED");
  }
  const routeKey = (candidate) => candidate.routeKey || `${candidate.provider}:${candidate.model}`;
  const candidates = Array.isArray(context.remoteRoutes) ? context.remoteRoutes : [];
  const selectedKey = routeKey(route);
  const selected = candidates.find((candidate) => routeKey(candidate) === selectedKey) || {
    ...route, health: context.readiness, breaker: context.breaker,
  };
  const ordered = [selected, ...candidates.filter((candidate) => routeKey(candidate) !== selectedKey)]
    .filter((candidate) => isSupportedRemoteRoute(candidate.provider, candidate.model)
      && healthCacheAllowsRoute(candidate.health, candidate, Date.now()))
    .slice(0, MAX_REMOTE_ATTEMPTS_PER_REQUEST);
  let failure = null;
  let remoteText = "";
  const prompt = request.prompt || request.title || "";
  const safeHttpFailover = (error, errorClass, status) => request.sideEffecting === false
    && request.capability === "read_only"
    && ((status === 429 && errorClass === "rate_limited")
      || ((status === 401 || status === 403) && errorClass === "auth_denied")
      || (Number.isInteger(status) && status >= 500 && status <= 599
        && ["provider_5xx", "provider_503", "provider_error"].includes(errorClass))
      || (errorClass === "provider_capacity" && error?.transportAttempted === false
        && error?.providerCapacity === true));

  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    if (!isSupportedRemoteRoute(candidate.provider, candidate.model)
        || !healthCacheAllowsRoute(candidate.health, candidate, Date.now())) continue;
    if (context.securityDisabled === true || context.finalGateBlocked === true || context.provenanceMismatch === true) break;
    const candidateKey = routeKey(candidate);
    const candidateBreaker = candidate.breaker || {};
    let probeToken = candidateKey === context.halfOpenProbeRouteKey
      || (index === 0 && !context.halfOpenProbeRouteKey)
      ? context.halfOpenProbeToken || null : null;
    if (candidateBreaker.state === "HALF_OPEN") {
      // runRequest may already have atomically claimed this route's single-flight
      // lease before selecting the route. Honor that token instead of trying to
      // claim the same HALF_OPEN slot a second time here.
      if (!probeToken) continue;
    } else if (isCircuitOpen(candidateBreaker, Date.now())) {
      if (Number(candidateBreaker.cooldownUntil || 0) > Date.now() || !context.claimProviderProbe) continue;
      const claim = await context.claimProviderProbe(candidate);
      if (!claim) continue;
      probeToken = claim.token;
    }
    const preferLocal = context.privacyClass === PRIVACY_CLASSES.PREFER_LOCAL;
    const attemptRoute = index === 0 ? { ...route, ...candidate, tier: route.tier,
      routeReason: route.routeReason || candidate.routeReason, routeKey: candidateKey }
      : {
        ...candidate,
        tier: preferLocal ? "remote_free_prefer_local_fallback" : "remote_free_failover",
        routeReason: preferLocal ? "prefer_local_qwen_unavailable_remote_failover" : "remote_free_provider_failover",
        routeKey: candidateKey,
      };
    context.currentRemoteRoute = attemptRoute;
    context.attemptRouteTier = attemptRoute.tier;
    context.routeReason = attemptRoute.routeReason;
    context.readiness = candidate.health;
    if (index > 0) {
      context.fallbackCount = (context.fallbackCount || 0) + 1;
      context.fallbackReason = "verified_free_provider_failover";
    }
    try {
      remoteText = (await invokeHermes(requestHermesArgs({ ...request, prompt }, attemptRoute, context.privacyClass), {
        timeout: request.kind === "atlas.research" ? specialistTimeoutMs : runTimeoutMs,
        routeTier: attemptRoute.tier,
      })).trim();
      if (context.finalGateBlocked === true) {
        if (!requiresStrictJson(request)) return remoteText;
        const localValidation = validateStrictOutput(request, remoteText);
        await updateStructuredOutputValidation(localValidation.valid);
        if (localValidation.valid) return remoteText;
        context.fallbackReason = "invalid_structured_output";
        failure = new Error("invalid_structured_output");
        break;
      }
      if (recordProviderOutcome) {
        await recordProviderOutcome({ route: attemptRoute, success: true, probeToken });
      } else {
        await setStore(`model-router-breaker:v1:${candidate.provider}:${candidate.model}`, resetCircuitState());
      }
      if (!requiresStrictJson(request)) return remoteText;
      const validated = validateStrictOutput(request, remoteText);
      await updateStructuredOutputValidation(validated.valid);
      if (validated.valid) return remoteText;
      context.fallbackReason = "invalid_structured_output";
      failure = new Error("invalid_structured_output");
      break;
    } catch (error) {
      failure = error;
      const errorClass = classifyProviderFailure(error);
      const httpStatus = verifiedHttpStatus(error);
      const next = nextCircuitState(candidateBreaker, errorClass);
      if (recordProviderOutcome) {
        try {
          await recordProviderOutcome({ route: attemptRoute, errorClass, httpStatus, probeToken });
        } catch (storeError) {
          failure = new Error("provider_breaker_persistence_failed", { cause: storeError });
          context.fallbackReason = "provider_breaker_persistence_failed";
          break;
        }
      } else if (!["pre_transport_error", "transport_outcome_unknown"].includes(errorClass)) {
        await setStore(`model-router-breaker:v1:${candidate.provider}:${candidate.model}`,
          { ...next, lastVerifiedHttpStatus: httpStatus });
      }
      const reason = canaryAutoDisableReason({ errorClass, consecutiveFailures: next.consecutiveFailures });
      if (reason) {
        await autoDisableCanary(reason, request.id);
        context.securityDisabled = true;
      }
      context.fallbackReason = context.provenanceMismatch ? "provenance_mismatch" : errorClass;
      const failoverAllowed = safeHttpFailover(error, errorClass, httpStatus)
        && context.securityDisabled !== true && context.finalGateBlocked !== true
        && context.provenanceMismatch !== true;
      if (!failoverAllowed) break;
    }
  }
  if (!failure) failure = new Error("REMOTE_FREE_ROUTE_UNAVAILABLE");

  throw failure;
}
