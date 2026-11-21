import test from "node:test";
import assert from "node:assert/strict";
import { executePrivacyRoutedRequest } from "./privacy-route-executor.mjs";
import {
  OPENROUTER_FREE_ROUTE, MIMO26_ROUTE, PRIVACY_CLASSES, QWEN_ROUTE,
} from "./privacy-model-router.mjs";
import { validateStrictJson } from "./privacy-model-router.mjs";

const now = Date.now();
const request = (overrides = {}) => ({
  id: "synthetic-agent-router", kind: "max.deep-analysis", title: "Fictional public design",
  prompt: "Review a fictional public architecture", origin: "test", capability: "read_only",
  sideEffecting: false, attachments: [], ...overrides,
});
const closeBreaker = () => ({ state: "CLOSED", providerFailureCount: 0, cooldownUntil: 0 });
function candidate(route, overrides = {}) {
  const health = {
    status: "catalog_verified_free", provider: route.provider, requested_model: route.model,
    modelAvailable: true, freePrice: true, verified_free: true,
    catalogVerified: true, catalogSource: "authenticated_model_catalog",
    toolCompatibility: "not_required_safe_mode", checkedAt: now - 100, validUntil: now + 60_000,
  };
  return {
    ...route, routeKey: `${route.provider}:${route.model}`, health, breaker: closeBreaker(), ...overrides,
  };
}
function context(overrides = {}) {
  const primary = candidate(MIMO26_ROUTE);
  const secondary = candidate(OPENROUTER_FREE_ROUTE);
  return {
    modelRoute: { ...MIMO26_ROUTE, tier: "remote_free_primary", routeKey: primary.routeKey },
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    remoteRoutes: [primary, secondary], readiness: primary.health,
    remoteReadiness: { [primary.routeKey]: primary.health, [secondary.routeKey]: secondary.health },
    breaker: primary.breaker, fallbackCount: 0, fallbackReason: null,
    remoteAttemptCount: 0, finalGateBlocked: false, securityDisabled: false,
    provenanceMismatch: false, ...overrides,
  };
}
function deps(ctx, overrides = {}) {
  return {
    context: ctx,
    requestHermesArgs: (req, route, privacyClass) => ({
      provider: route.provider, model: route.model, prompt: req.prompt, privacyClass,
    }),
    invokeHermes: async () => "SYNTHETIC_OK",
    setStore: async () => {}, log: () => {}, requiresStrictJson: () => false,
    validateStrictOutput: (_request, text) => validateStrictJson(text),
    updateStructuredOutputValidation: async () => {}, runTimeoutMs: 100, specialistTimeoutMs: 200,
    ...overrides,
  };
}
const httpError = (status) => Object.assign(new Error(`synthetic HTTP ${status}`), {
  transportAttempted: true, remoteHttpStatus: status,
});

test("approved synthetic request dispatches once to exact Token Harbor DeepSeek route", async () => {
  const ctx = context();
  const calls = [];
  const result = await executePrivacyRoutedRequest(request(), deps(ctx, {
    invokeHermes: async (args, options) => { calls.push({ args, options }); return "SYNTHETIC_OK"; },
  }));
  assert.equal(result, "SYNTHETIC_OK");
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].args.provider, calls[0].args.model], [MIMO26_ROUTE.provider, MIMO26_ROUTE.model]);
  assert.equal(calls[0].args.privacyClass, PRIVACY_CLASSES.REMOTE_FREE_ALLOWED);
  assert.equal(ctx.fallbackCount, 0);
});

test("verified 429 and 5xx can fail over once to exact OpenRouter Cohere Free", async (t) => {
  for (const status of [429, 503]) await t.test(`HTTP ${status}`, async () => {
    const ctx = context();
    const calls = [];
    const outcomes = [];
    const result = await executePrivacyRoutedRequest(request(), deps(ctx, {
      invokeHermes: async (args) => {
        calls.push([args.provider, args.model]);
        if (args.provider === MIMO26_ROUTE.provider) throw httpError(status);
        return "COHERE_SYNTHETIC_OK";
      },
      recordProviderOutcome: async (outcome) => outcomes.push(outcome),
    }));
    assert.equal(result, "COHERE_SYNTHETIC_OK");
    assert.deepEqual(calls, [
      [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
      [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
    ]);
    assert.equal(ctx.fallbackCount, 1);
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].httpStatus, status);
    assert.equal(outcomes[1].success, true);
  });
});

test("401 and 403 fail over only to the exact authorized free route for read-only requests", async (t) => {
  for (const status of [401, 403]) await t.test(`HTTP ${status}`, async () => {
    const ctx = context();
    const calls = [];
    const result = await executePrivacyRoutedRequest(request(), deps(ctx, {
      invokeHermes: async (args) => {
        calls.push([args.provider, args.model]);
        if (args.provider === MIMO26_ROUTE.provider) throw httpError(status);
        return "COHERE_SYNTHETIC_OK";
      },
    }));
    assert.equal(result, "COHERE_SYNTHETIC_OK");
    assert.deepEqual(calls, [
      [MIMO26_ROUTE.provider, MIMO26_ROUTE.model],
      [OPENROUTER_FREE_ROUTE.provider, OPENROUTER_FREE_ROUTE.model],
    ]);
    assert.equal(ctx.fallbackCount, 1);
  });
});

test("413, unknown transport result, and pre-transport errors do not fail over", async (t) => {
  const errors = [413].map(httpError).concat([
    Object.assign(new Error("transport result unknown"), { transportAttempted: null, code: "ECONNRESET" }),
    Object.assign(new Error("pre-transport rejection"), { transportAttempted: false, code: "EINVAL" }),
  ]);
  for (const error of errors) await t.test(error.message, async () => {
    const ctx = context();
    const calls = [];
    await assert.rejects(executePrivacyRoutedRequest(request(), deps(ctx, {
      invokeHermes: async (args) => { calls.push(args.provider); throw error; },
    })));
    assert.deepEqual(calls, [MIMO26_ROUTE.provider]);
    assert.equal(ctx.fallbackCount, 0);
  });
});

test("auth failure does not fail over for effectful or non-read-only requests", async () => {
  for (const overrides of [
    { capability: "write", sideEffecting: false },
    { capability: "read_only", sideEffecting: true },
  ]) {
    const calls = [];
    await assert.rejects(executePrivacyRoutedRequest(request(overrides), deps(context(), {
      invokeHermes: async (args) => {
        calls.push([args.provider, args.model]);
        throw httpError(403);
      },
    })));
    assert.deepEqual(calls, []);
  }
});

test("legacy, paid, Groq, Cerebras, and unqualified route candidates are filtered", async () => {
  const unsupported = [
    candidate({ provider: "groq", model: "openai/gpt-oss-20b" }),
    candidate({ provider: "cerebras", model: "llama-3.1-8b" }),
    candidate({ provider: "openrouter", model: "cohere/north-mini-code" }),
    candidate({ provider: "openrouter-direct", model: "openai/gpt-4.1" }),
    candidate({ provider: "custom:tokenharbor", model: "mimo-v2.6-flash:free" }),
    candidate({ provider: "qwen-local-tailscale", model: "qwen3-8b-local" }),
  ];
  const ctx = context({ remoteRoutes: [candidate(MIMO26_ROUTE), ...unsupported] });
  const calls = [];
  const result = await executePrivacyRoutedRequest(request(), deps(ctx, {
    invokeHermes: async (args) => { calls.push([args.provider, args.model]); return "OK"; },
  }));
  assert.equal(result, "OK");
  assert.deepEqual(calls, [[MIMO26_ROUTE.provider, MIMO26_ROUTE.model]]);
});

test("LOCAL_ONLY, PREFER_LOCAL, side effects, attachments, and workflow origins are denied before transport", async (t) => {
  const denied = [
    ["LOCAL_ONLY", context({ privacyClass: PRIVACY_CLASSES.LOCAL_ONLY }), request()],
    ["PREFER_LOCAL", context({ privacyClass: PRIVACY_CLASSES.PREFER_LOCAL }), request()],
    ["side effect", context(), request({ sideEffecting: true })],
    ["attachment", context(), request({ attachments: ["synthetic-file"] })],
    ["workflow origin", context(), request({ origin: "workflow" })],
  ];
  for (const [name, ctx, req] of denied) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(executePrivacyRoutedRequest(req, deps(ctx, {
      invokeHermes: async () => { calls += 1; return "FORBIDDEN"; },
    })), /LOCAL_ONLY_REMOTE_DENIED|REMOTE_FREE_CONSENT_REQUIRED/);
    assert.equal(calls, 0);
  });
});

test("sticky security, provenance, and final-gate blocks stop before provider dispatch", async (t) => {
  for (const [name, overrides] of [
    ["security", { securityDisabled: true }],
    ["final gate", { finalGateBlocked: true }],
    ["provenance", { provenanceMismatch: true }],
  ]) await t.test(name, async () => {
    const ctx = context(overrides);
    let calls = 0;
    await assert.rejects(executePrivacyRoutedRequest(request(), deps(ctx, {
      invokeHermes: async () => { calls += 1; return "FORBIDDEN"; },
    })), /REMOTE_FREE_ROUTE_UNAVAILABLE|REMOTE_FREE_CONSENT_REQUIRED/);
    assert.equal(calls, 0);
  });
});

test("stale or unverified secondary readiness fails closed after primary failure", async () => {
  const ctx = context();
  ctx.remoteRoutes[1].health.catalogVerified = false;
  const calls = [];
  await assert.rejects(executePrivacyRoutedRequest(request(), deps(ctx, {
    invokeHermes: async (args) => { calls.push(args.provider); throw httpError(503); },
  })), /synthetic HTTP 503/);
  assert.deepEqual(calls, [MIMO26_ROUTE.provider]);
  assert.equal(ctx.fallbackCount, 0);
});

test("strict JSON is validated and malformed output does not trigger a duplicate request", async () => {
  const ctx = context();
  let calls = 0;
  await assert.rejects(executePrivacyRoutedRequest(request({ strictJson: true }), deps(ctx, {
    requiresStrictJson: (req) => req.strictJson === true,
    invokeHermes: async () => { calls += 1; return "not-json"; },
  })), /invalid_structured_output/);
  assert.equal(calls, 1);
});

test("LOCAL_ONLY unavailable route never falls back to Qwen or a remote provider", async () => {
  const ctx = context({
    privacyClass: PRIVACY_CLASSES.LOCAL_ONLY,
    modelRoute: { ...QWEN_ROUTE, tier: "local_model_unavailable" },
  });
  let calls = 0;
  await assert.rejects(executePrivacyRoutedRequest(request(), deps(ctx, {
    invokeHermes: async () => { calls += 1; return "FORBIDDEN"; },
  })), /LOCAL_MODEL_UNAVAILABLE/);
  assert.equal(calls, 0);
});
