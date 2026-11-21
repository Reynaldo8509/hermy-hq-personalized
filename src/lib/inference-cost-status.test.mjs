import assert from "node:assert/strict";
import test from "node:test";
import { inferenceCostStatusForEvidence, isPersistedInferenceCostStatus } from "./inference-cost-status.mjs";
import { LOCAL_FREE_ROUTES, PERSISTED_INFERENCE_COST_STATUSES, REMOTE_FREE_ROUTES } from "./model-affinity.mjs";

test("persisted cost labels match the database constraint", () => {
  assert.deepEqual(PERSISTED_INFERENCE_COST_STATUSES, ["verified_free", "reported_zero", "unknown", "paid"]);
  for (const route of [...Object.values(REMOTE_FREE_ROUTES), ...Object.values(LOCAL_FREE_ROUTES)]) {
    assert.equal(isPersistedInferenceCostStatus(route.costStatus), true);
  }
});

test("only exact, validated free routes inherit verified-free status", () => {
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "verified_free_allowlist", reportedCost: 0 }), "verified_free");
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "verified_free_allowlist" }), "verified_free");
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "local_no_billing" }), "unknown");
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "not_allowlisted_fail_closed", reportedCost: 0 }), "unknown");
});

test("provider-reported cost semantics are preserved without inventing them", () => {
  assert.equal(inferenceCostStatusForEvidence({ providerStatus: "reported_zero", reportedCost: 0 }), "reported_zero");
  assert.equal(inferenceCostStatusForEvidence({ providerStatus: "paid", reportedCost: 0.01 }), "paid");
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "verified_free_allowlist", reportedCost: 0.01 }), "unknown");
  assert.equal(inferenceCostStatusForEvidence({ routeCostPolicy: "not_allowlisted_fail_closed" }), "unknown");
});
