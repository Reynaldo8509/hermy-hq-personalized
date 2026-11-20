import test from "node:test";
import assert from "node:assert/strict";
import { classifyInferenceRecord, classifyProviderRoute, sumKnownUsage } from "./inference-observability.mjs";

test("historical default/default rows remain visible but are not counted as proven inferences", () => {
  assert.equal(classifyInferenceRecord({ provider: "default", model: "default", status: "success" }), "legacy_unclassified");
});

test("uninvoked route records are distinct from model inference", () => {
  assert.equal(classifyInferenceRecord({ provider: "qwen-local-tailscale", model: "qwen3-8b-local",
    actual_provider: "not_invoked", actual_model: "not_invoked" }), "route_not_invoked");
});

test("an observed inference with unknown provider remains an inference and keeps token evidence", () => {
  assert.equal(classifyInferenceRecord({ provider: "unknown", model: "unknown", actual_provider: "unknown",
    actual_model: "unknown", total_tokens: 958 }), "model_inference");
  assert.equal(sumKnownUsage([{ total_tokens: 958 }, { total_tokens: null }], "total_tokens"), 958);
  assert.equal(sumKnownUsage([{ total_tokens: null }], "total_tokens"), null);
});


test("provider route category requires explicit evidence for FREE or commercial labels", () => {
  assert.equal(classifyProviderRoute({ provider: "qwen-local-tailscale", model: "qwen3-8b-local",
    remote_attempted: false, route_tier: "local_only" }), "local");
  assert.equal(classifyProviderRoute({ provider: "Token Harbor", model: "mimo-v2.6-flash",
    free_route: true, route_cost_policy: "catalog_verified_free" }), "verified_free");
  assert.equal(classifyProviderRoute({ provider: "Example", model: "model", cost_status: "paid" }), "commercial_verified");
  assert.equal(classifyProviderRoute({ provider: "provider-free", model: "model" }), "remote_cost_unverified");
});
