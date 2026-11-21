import { MIMO26_ROUTE } from "./privacy-model-router.mjs";

export function consumeMimo503TestInjection(context, { oneShot, provider, model, routeTier } = {}) {
  if (context?.testOverrideMode !== "mimo_503_once"
      || context.modelRoute?.tier !== "mimo26_e2e_once"
      || context.routerPermitStatus !== "CONSUMED"
      || context.remoteAttemptCount !== 1
      || oneShot !== true
      || provider !== MIMO26_ROUTE.provider
      || model !== MIMO26_ROUTE.model
      || routeTier !== "mimo26_e2e_once"
      || context.simulatedProviderFailure === true) return false;
  context.simulatedProviderFailure = true;
  return true;
}

export function consumePrimaryPreTransportTestInjection(context,
  { oneShot, provider, model, routeTier } = {}) {
  const request = context?.request;
  if (!["remote_free_failover_qwen_unavailable", "prefer_local_failover_qwen_unavailable"]
        .includes(context?.testOverrideMode)
      || request?.origin !== "test" || request?.sideEffecting !== false
      || request?.capability !== "read_only"
      || context?.securityDisabled === true || context?.routerPermitStatus !== "CONSUMED"
      || context?.remoteAttemptCount !== 1 || context?.remoteAttemptInFlight !== true
      || oneShot !== true || provider !== MIMO26_ROUTE.provider || model !== MIMO26_ROUTE.model
      || !["mimo26_primary", "remote_free_primary", "mimo26_prefer_local_fallback",
        "remote_free_prefer_local_fallback"].includes(routeTier)
      || context.simulatedPreTransportFailure === true) return false;
  context.simulatedPreTransportFailure = true;
  return true;
}
