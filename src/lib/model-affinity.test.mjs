import assert from "node:assert/strict";
import test from "node:test";
import {
  findValidatedFreeRoute, fallbackRoutesForRequest, MODEL_AFFINITY,
  primaryRouteForRequest, REMOTE_FREE_ROUTES, routeCostPolicy,
} from "./model-affinity.mjs";

test("remote free routes require exact provider and model identity", () => {
  const deepseek = REMOTE_FREE_ROUTES.deepseek;
  const cohere = REMOTE_FREE_ROUTES.cohere;
  assert.equal(findValidatedFreeRoute(deepseek.requestedProvider, deepseek.model, deepseek.actualProvider, deepseek.model), deepseek);
  assert.equal(findValidatedFreeRoute(cohere.requestedProvider, cohere.model, cohere.actualProvider, cohere.model), cohere);
  assert.equal(findValidatedFreeRoute(cohere.requestedProvider, "cohere/north-mini-code", cohere.actualProvider, "cohere/north-mini-code"), null);
  assert.equal(routeCostPolicy("groq", "openai/gpt-oss-20b"), "not_allowlisted_fail_closed");
  assert.equal(routeCostPolicy("openrouter-direct", "cohere/north-mini-code"), "not_allowlisted_fail_closed");
});

test("MAX and Atlas use the verified free primary and qualified free fallback", () => {
  for (const kind of ["max.chief-of-staff", "max.deep-analysis", "atlas.research"]) {
    assert.equal(primaryRouteForRequest(kind).id, "tokenharbor-deepseek-free");
    assert.deepEqual(fallbackRoutesForRequest(kind).map((route) => route.id), ["openrouter-cohere-north-mini-free"]);
    assert.equal(MODEL_AFFINITY[kind === "atlas.research" ? "atlas" : "max"].freeOnly, true);
  }
  assert.equal(MODEL_AFFINITY.atlas.requiresAtlasCapability, true);
  assert.equal(MODEL_AFFINITY.max.explicitRemoteConsent, true);
});

test("sensitive/local agents use deterministic operations or their dedicated worker only", () => {
  assert.equal(MODEL_AFFINITY.codex.primary.requestedProvider, "openai-codex-worker");
  assert.deepEqual(MODEL_AFFINITY.codex.fallbacks, []);
  for (const id of ["aegis", "milo", "ledger", "domus"]) {
    assert.equal(MODEL_AFFINITY[id].primary.requestedProvider, "local-deterministic");
    assert.deepEqual(MODEL_AFFINITY[id].fallbacks, []);
    assert.equal(MODEL_AFFINITY[id].freeOnly, true);
  }
  assert.equal(MODEL_AFFINITY.aegis.remoteClass, "synthetic_only");
  assert.equal(MODEL_AFFINITY.milo.emailPrivacy, "LOCAL_ONLY");
  assert.equal(MODEL_AFFINITY.ledger.scheduledProvenanceRequired, true);
  assert.equal(MODEL_AFFINITY.domus.homeAssistantPrivacy, "LOCAL_ONLY");
});
