import test from "node:test";
import assert from "node:assert/strict";
import { executePrivacyRoutedRequest } from "./privacy-route-executor.mjs";
import {
  isSupportedRemoteRoute, MIMO26_ROUTE, OPENROUTER_FREE_ROUTE,
  ROUTABLE_REMOTE_ROUTE_CANDIDATES, MAX_REMOTE_ATTEMPTS_PER_REQUEST, PRIVACY_CLASSES,
} from "./privacy-model-router.mjs";

const now = Date.now();
const request = {
  id: "synthetic-failover-matrix", kind: "max.chief-of-staff", title: "Synthetic routing test",
  prompt: "Plan a fictional public service", origin: "test", capability: "read_only",
  sideEffecting: false, attachments: [],
};
const closeBreaker = () => ({ state: "CLOSED", providerFailureCount: 0, cooldownUntil: 0 });
function candidate(route, overrides = {}) {
  const health = {
    status: "catalog_verified_free", provider: route.provider, requested_model: route.model,
    modelAvailable: true, freePrice: true, verified_free: true,
    catalogVerified: true, catalogSource: "authenticated_model_catalog",
    toolCompatibility: "not_required_safe_mode", checkedAt: now - 100, validUntil: now + 60_000,
  };
  return { ...route, routeKey: `${route.provider}:${route.model}`, health, breaker: closeBreaker(), ...overrides };
}
function context(overrides = {}) {
  const primary = candidate(MIMO26_ROUTE);
  const backup = candidate(OPENROUTER_FREE_ROUTE);
  return {
    modelRoute: { ...MIMO26_ROUTE, tier: "remote_free_primary", routeKey: primary.routeKey },
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    remoteRoutes: [primary, backup], fallbackCount: 0, fallbackReason: null,
    finalGateBlocked: false, securityDisabled: false, provenanceMismatch: false,
    ...overrides,
  };
}
const error = (status) => Object.assign(new Error(`synthetic HTTP ${status}`), {
  transportAttempted: true, remoteHttpStatus: status,
});
function deps(ctx, invokeHermes) {
  return {
    context: ctx, invokeHermes,
    requestHermesArgs: (req, route, privacyClass) => ({ provider: route.provider, model: route.model, prompt: req.prompt, privacyClass }),
    setStore: async () => {}, log: () => {}, requiresStrictJson: () => false,
    updateStructuredOutputValidation: async () => {}, runTimeoutMs: 100, specialistTimeoutMs: 100,
  };
}

test("the only routable routes and maximum attempts are the two explicitly authorized free routes", () => {
  assert.deepEqual(ROUTABLE_REMOTE_ROUTE_CANDIDATES.map(({ provider, model }) => [provider, model]), [
    [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
    [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
  ]);
  assert.equal(MAX_REMOTE_ATTEMPTS_PER_REQUEST, 2);
  for (const blocked of [
    ["groq", "openai/gpt-oss-20b"], ["cerebras", "llama-3.1-8b"],
    ["openrouter-direct", "cohere/north-mini-code:free"], ["openrouter", "openai/gpt-4.1"],
    ["custom:tokenharbor", "mimo-v2.6-flash:free"], ["qwen-local-tailscale", "qwen3-8b-local"],
  ]) assert.equal(isSupportedRemoteRoute(...blocked), false, blocked.join("/"));
});

test("primary 429 or 5xx can make one exact OpenRouter Free failover", async (t) => {
  for (const status of [429, 503]) await t.test(`HTTP ${status}`, async () => {
    const ctx = context();
    const calls = [];
    const result = await executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
      calls.push([args.provider, args.model]);
      if (args.provider === MIMO26_ROUTE.provider) throw error(status);
      return "COHERE_FREE_SYNTHETIC_SUCCESS";
    }));
    assert.equal(result, "COHERE_FREE_SYNTHETIC_SUCCESS");
    assert.deepEqual(calls, [
      [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
      [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
    ]);
    assert.equal(ctx.fallbackCount, 1);
  });
});

test("auth failures can use only the exact authorized free fallback and never a third route", async (t) => {
  for (const status of [401, 403]) await t.test(`HTTP ${status}`, async () => {
    const ctx = context();
    const calls = [];
    await assert.rejects(executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
      calls.push([args.provider, args.model]);
      throw error(status);
    })));
    assert.deepEqual(calls, [
      [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
      [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
    ]);
    assert.equal(ctx.fallbackCount, 1);
  });
});

test("context-size, unknown-transport, and pre-transport failures never trigger fallback", async (t) => {
  const failures = [413].map(error).concat([
    Object.assign(new Error("uncertain transport"), { transportAttempted: null, code: "ECONNRESET" }),
    Object.assign(new Error("before transport"), { transportAttempted: false, code: "EINVAL" }),
  ]);
  for (const failure of failures) await t.test(failure.message, async () => {
    const ctx = context();
    const calls = [];
    await assert.rejects(executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
      calls.push(args.provider);
      throw failure;
    })));
    assert.deepEqual(calls, [MIMO26_ROUTE.provider]);
    assert.equal(ctx.fallbackCount, 0);
  });
});

test("unavailable or stale OpenRouter readiness fails closed after primary capacity error", async () => {
  for (const readiness of [
    { ...candidate(OPENROUTER_FREE_ROUTE).health, validUntil: now },
    { ...candidate(OPENROUTER_FREE_ROUTE).health, catalogVerified: false },
  ]) {
    const backup = candidate(OPENROUTER_FREE_ROUTE, { health: readiness });
    const ctx = context({ remoteRoutes: [candidate(MIMO26_ROUTE), backup] });
    const calls = [];
    await assert.rejects(executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
      calls.push(args.provider);
      throw error(429);
    })));
    assert.deepEqual(calls, [MIMO26_ROUTE.provider]);
  }
});

test("Groq, Cerebras, paid and unqualified aliases in stale state are never attempted", async () => {
  const stale = [
    candidate({ provider: "groq", model: "openai/gpt-oss-20b" }),
    candidate({ provider: "cerebras", model: "llama-3.1-8b" }),
    candidate({ provider: "openrouter", model: OPENROUTER_FREE_ROUTE.model }),
    candidate({ provider: OPENROUTER_FREE_ROUTE.provider, model: "openai/gpt-4.1" }),
  ];
  const ctx = context({ remoteRoutes: [candidate(MIMO26_ROUTE), ...stale, candidate(OPENROUTER_FREE_ROUTE)] });
  const calls = [];
  const result = await executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
    calls.push([args.provider, args.model]);
    if (args.provider === MIMO26_ROUTE.provider) throw error(503);
    return "FREE_ONLY_SUCCESS";
  }));
  assert.equal(result, "FREE_ONLY_SUCCESS");
  assert.deepEqual(calls, [
    [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
    [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
  ]);
});

test("LOCAL_ONLY and requests with effects cannot enter remote provider failover", async (t) => {
  for (const [label, ctx, req] of [
    ["LOCAL_ONLY", context({ privacyClass: PRIVACY_CLASSES.LOCAL_ONLY }), request],
    ["PREFER_LOCAL", context({ privacyClass: PRIVACY_CLASSES.PREFER_LOCAL }), request],
    ["side effect", context(), { ...request, sideEffecting: true }],
    ["attachment", context(), { ...request, attachments: ["synthetic"] }],
    ["workflow", context(), { ...request, origin: "workflow" }],
  ]) await t.test(label, async () => {
    let calls = 0;
    await assert.rejects(executePrivacyRoutedRequest(req, deps(ctx, async () => {
      calls += 1;
      return "must-not-dispatch";
    })));
    assert.equal(calls, 0);
  });
});

test("secondary route selected by the upstream router is not retried as a third hop", async () => {
  const backup = candidate(OPENROUTER_FREE_ROUTE);
  const ctx = context({
    modelRoute: { ...OPENROUTER_FREE_ROUTE, tier: "remote_free_failover", routeKey: backup.routeKey },
    remoteRoutes: [candidate(MIMO26_ROUTE, { breaker: { state: "OPEN", cooldownUntil: now + 10_000 } }), backup],
  });
  const calls = [];
  const result = await executePrivacyRoutedRequest(request, deps(ctx, async (args) => {
    calls.push([args.provider, args.model]);
    return "COHERE_FREE_SUCCESS";
  }));
  assert.equal(result, "COHERE_FREE_SUCCESS");
  assert.deepEqual(calls, [[OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model]]);
});
