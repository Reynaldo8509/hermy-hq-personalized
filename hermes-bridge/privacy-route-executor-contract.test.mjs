import assert from "node:assert/strict";
import test from "node:test";
import { executePrivacyRoutedRequest } from "./privacy-route-executor.mjs";
import { MIMO26_ROUTE, OPENROUTER_FREE_ROUTE, PRIVACY_CLASSES } from "./privacy-model-router.mjs";

const now = Date.now();
const request = {
  id: "synthetic-executor-contract", kind: "max.deep-analysis", title: "Synthetic public review",
  prompt: "Review a fictional public system", origin: "test", capability: "read_only",
  sideEffecting: false, attachments: [],
};
const breaker = (overrides = {}) => ({ state: "CLOSED", providerFailureCount: 0, cooldownUntil: 0, ...overrides });
function route(value, breakerState = breaker()) {
  return {
    ...value, routeKey: `${value.provider}:${value.model}`, breaker: breakerState,
    health: {
      status: "catalog_verified_free", provider: value.provider, requested_model: value.model,
      modelAvailable: true, freePrice: true, verified_free: true, catalogVerified: true,
      catalogSource: "authenticated_model_catalog", toolCompatibility: "not_required_safe_mode",
      checkedAt: now - 10, validUntil: now + 60_000,
    },
  };
}
function makeContext(primary = route(MIMO26_ROUTE), secondary = route(OPENROUTER_FREE_ROUTE), overrides = {}) {
  return {
    modelRoute: { ...primary, tier: "remote_free_primary" },
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    remoteRoutes: secondary ? [primary, secondary] : [primary],
    readiness: primary.health, breaker: primary.breaker,
    fallbackCount: 0, securityDisabled: false, finalGateBlocked: false, provenanceMismatch: false,
    ...overrides,
  };
}
function dependencies(context, overrides = {}) {
  return {
    context,
    requestHermesArgs: (req, selected, privacyClass) => ({
      provider: selected.provider, model: selected.model, prompt: req.prompt, privacyClass,
    }),
    invokeHermes: async () => "SYNTHETIC_OK",
    setStore: async () => {}, log: () => {}, requiresStrictJson: () => false,
    updateStructuredOutputValidation: async () => {}, runTimeoutMs: 100, specialistTimeoutMs: 100,
    ...overrides,
  };
}
const httpError = (status) => Object.assign(new Error(`synthetic HTTP ${status}`), {
  transportAttempted: true, remoteHttpStatus: status,
});

test("a preclaimed half-open probe is used once without claiming the same lease twice", async () => {
  const primary = route(MIMO26_ROUTE, breaker({ state: "HALF_OPEN", providerFailureCount: 2 }));
  const ctx = makeContext(primary, null, {
    halfOpenProbeRouteKey: primary.routeKey, halfOpenProbeToken: "synthetic-lease",
  });
  let claimCalls = 0;
  const calls = [];
  const outcomes = [];
  const result = await executePrivacyRoutedRequest(request, dependencies(ctx, {
    claimProviderProbe: async () => { claimCalls += 1; return null; },
    recordProviderOutcome: async (outcome) => outcomes.push(outcome),
    invokeHermes: async (args) => { calls.push([args.provider, args.model]); return "RECOVERED"; },
  }));
  assert.equal(result, "RECOVERED");
  assert.deepEqual(calls, [[MIMO26_ROUTE.provider, MIMO26_ROUTE.model]]);
  assert.equal(claimCalls, 0);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].probeToken, "synthetic-lease");
});

test("verified 503 advances the breaker and never sets the privacy security latch", async () => {
  const primary = route(MIMO26_ROUTE, breaker({ providerFailureCount: 1 }));
  const ctx = makeContext(primary, null);
  const writes = [];
  await assert.rejects(executePrivacyRoutedRequest(request, dependencies(ctx, {
    setStore: async (key, value) => writes.push({ key, value }),
    invokeHermes: async () => { throw httpError(503); },
  })), /synthetic HTTP 503/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.state, "OPEN");
  assert.equal(writes[0].value.lastProviderFailureClass, "provider_503");
  assert.equal(ctx.securityDisabled, false);
});

test("pre-transport failures are neither replayed nor counted as provider outages", async () => {
  const ctx = makeContext();
  const writes = [];
  const autoDisables = [];
  const calls = [];
  const error = Object.assign(new Error("synthetic local preparation failure"), { transportAttempted: false });
  await assert.rejects(executePrivacyRoutedRequest(request, dependencies(ctx, {
    setStore: async (...entry) => writes.push(entry),
    autoDisableCanary: async (...entry) => autoDisables.push(entry),
    invokeHermes: async (args) => { calls.push(args.provider); throw error; },
  })), /synthetic local preparation failure/);
  assert.deepEqual(calls, [MIMO26_ROUTE.provider]);
  assert.equal(writes.length, 0);
  assert.equal(autoDisables.length, 0);
  assert.equal(ctx.fallbackCount, 0);
  assert.equal(ctx.securityDisabled, false);
});

test("payment-required responses do not fail over to a second provider", async () => {
  const ctx = makeContext();
  const calls = [];
  await assert.rejects(executePrivacyRoutedRequest(request, dependencies(ctx, {
    invokeHermes: async (args) => {
      calls.push([args.provider, args.model]);
      throw httpError(402);
    },
  })), /synthetic HTTP 402/);
  assert.deepEqual(calls, [[MIMO26_ROUTE.provider, MIMO26_ROUTE.model]]);
  assert.equal(ctx.fallbackCount, 0);
});
