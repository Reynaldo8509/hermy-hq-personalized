import assert from "node:assert/strict";
import test from "node:test";
import { MIMO26_ROUTE } from "./privacy-model-router.mjs";
import { consumeMimo503TestInjection, consumePrimaryPreTransportTestInjection } from "./router-fault-injection.mjs";

const invocation = {
  oneShot: true,
  provider: MIMO26_ROUTE.provider,
  model: MIMO26_ROUTE.model,
  routeTier: "mimo26_e2e_once",
};

function eligibleContext() {
  return {
    testOverrideMode: "mimo_503_once",
    modelRoute: { tier: "mimo26_e2e_once" },
    routerPermitStatus: "CONSUMED",
    remoteAttemptCount: 1,
  };
}

test("simulated MiMo 503 is consumed once after a single-use permit and before transport", () => {
  const context = eligibleContext();
  assert.equal(consumeMimo503TestInjection(context, invocation), true);
  assert.equal(context.simulatedProviderFailure, true);
  assert.equal(consumeMimo503TestInjection(context, invocation), false);
});

test("simulated MiMo 503 cannot run before the permit, on local routes, or outside E2E", () => {
  for (const context of [
    { ...eligibleContext(), testOverrideMode: null },
    { ...eligibleContext(), routerPermitStatus: "ISSUED" },
    { ...eligibleContext(), remoteAttemptCount: 0 },
    { ...eligibleContext(), modelRoute: { tier: "mimo26_canary" } },
  ]) assert.equal(consumeMimo503TestInjection(context, invocation), false);
  assert.equal(consumeMimo503TestInjection(eligibleContext(), { ...invocation, provider: "qwen-local-tailscale" }), false);
  assert.equal(consumeMimo503TestInjection(eligibleContext(), { ...invocation, oneShot: false }), false);
});

test("primary pre-transport failover injection requires test origin, a consumed permit, and Qwen-safe routing", () => {
  const context = {
    testOverrideMode: "remote_free_failover_qwen_unavailable",
    request: { origin: "test", sideEffecting: false, capability: "read_only" },
    securityDisabled: false, routerPermitStatus: "CONSUMED", remoteAttemptCount: 1,
    remoteAttemptInFlight: true,
  };
  const primary = { ...invocation, routeTier: "remote_free_primary" };
  assert.equal(consumePrimaryPreTransportTestInjection(context, primary), true);
  assert.equal(context.simulatedPreTransportFailure, true);
  assert.equal(consumePrimaryPreTransportTestInjection(context, primary), false);
  for (const changed of [
    { request: { ...context.request, origin: "web" } },
    { request: { ...context.request, sideEffecting: true } },
    { securityDisabled: true }, { routerPermitStatus: "ISSUED" },
    { remoteAttemptCount: 0 }, { remoteAttemptInFlight: false },
  ]) {
    assert.equal(consumePrimaryPreTransportTestInjection({ ...context, ...changed }, primary), false);
  }
  assert.equal(consumePrimaryPreTransportTestInjection(context, { ...primary, provider: "openrouter" }), false);
  const preferLocal = { ...context, testOverrideMode: "prefer_local_failover_qwen_unavailable",
    simulatedPreTransportFailure: false };
  assert.equal(consumePrimaryPreTransportTestInjection(preferLocal,
    { ...primary, routeTier: "mimo26_prefer_local_fallback" }), true);
});
