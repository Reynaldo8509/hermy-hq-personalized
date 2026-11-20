import assert from "node:assert/strict";
import test from "node:test";
import {
  initialQwenAvailability, isQwenConnectivityFailure, QWEN_AVAILABILITY,
  QWEN_FAILURE_THRESHOLD, QWEN_HEALTH_INTERVAL_MS, QWEN_HEALTH_TIMEOUT_MS,
  qwenAvailabilityTestOverride, qwenModelsResponseAvailable, transitionQwenAvailability,
} from "./qwen-availability.mjs";
import { COMPLEXITY_CLASSES, PRIVACY_CLASSES, QWEN_ROUTE, selectRoute } from "./privacy-model-router.mjs";

test("Qwen availability stays request-local and needs two consecutive failures to go offline", () => {
  assert.equal(QWEN_FAILURE_THRESHOLD, 2);
  assert.equal(QWEN_HEALTH_INTERVAL_MS, 15_000);
  assert.equal(QWEN_HEALTH_TIMEOUT_MS, 2_500);
  let state = initialQwenAvailability(1_000);
  state = transitionQwenAvailability(state, false, 2_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNKNOWN);
  state = transitionQwenAvailability(state, true, 3_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNKNOWN);
  state = transitionQwenAvailability(state, false, 4_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNKNOWN);
  state = transitionQwenAvailability(state, false, 5_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNAVAILABLE);
  assert.equal(state.available, false);
});

test("two consecutive good probes recover Qwen after a Dell outage", () => {
  let state = transitionQwenAvailability(initialQwenAvailability(), false, 1_000);
  state = transitionQwenAvailability(state, false, 2_000);
  state = transitionQwenAvailability(state, false, 3_000);
  state = transitionQwenAvailability(state, true, 4_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNAVAILABLE);
  state = transitionQwenAvailability(state, true, 5_000);
  assert.equal(state.status, QWEN_AVAILABILITY.AVAILABLE);
  assert.equal(state.available, true);
  assert.equal(state.validUntil > 5_000, true);
  const request = { id: "qwen-recovery", kind: "max.deep-analysis", sideEffecting: false,
    capability: "read_only", attachments: [] };
  const route = selectRoute({ request, privacy: { privacyClass: PRIVACY_CLASSES.LOCAL_ONLY },
    complexity: COMPLEXITY_CLASSES.SIMPLE, flags: { enabled: true }, qwenAvailability: state, now: 5_000 });
  assert.equal(route.tier, "local_model_unavailable",
    "a green synthetic probe cannot re-enable the disabled local Qwen route");
  assert.equal(route.routeReason, "local_only_model_unavailable");
  assert.equal(route.model, QWEN_ROUTE.model);
});

test("an established online state survives an isolated failed probe", () => {
  let state = transitionQwenAvailability(initialQwenAvailability(), true, 1_000);
  state = transitionQwenAvailability(state, true, 2_000);
  assert.equal(state.status, QWEN_AVAILABILITY.AVAILABLE);
  state = transitionQwenAvailability(state, false, 3_000);
  assert.equal(state.status, QWEN_AVAILABILITY.AVAILABLE);
  state = transitionQwenAvailability(state, false, 4_000);
  assert.equal(state.status, QWEN_AVAILABILITY.UNAVAILABLE);
});

test("runtime fault injection starts UNKNOWN, crosses 2-failure hysteresis, and recovers after 2 successes", () => {
  const unknown = qwenAvailabilityTestOverride("remote_free_qwen_unknown", 10_000);
  assert.equal(unknown.state.status, QWEN_AVAILABILITY.UNKNOWN);
  assert.equal(unknown.state.checkedAt, null);
  assert.deepEqual(unknown.transitionTrace, [QWEN_AVAILABILITY.UNKNOWN]);

  const unavailable = qwenAvailabilityTestOverride("remote_free_qwen_unavailable", 20_000);
  assert.deepEqual(unavailable.transitionTrace, [
    "QWEN_AVAILABLE;failures=1", "QWEN_UNAVAILABLE;failures=2",
  ]);
  assert.equal(unavailable.state.status, QWEN_AVAILABILITY.UNAVAILABLE);
  assert.equal(qwenAvailabilityTestOverride("remote_free_failover_qwen_unavailable", 20_000).state.status,
    QWEN_AVAILABILITY.UNAVAILABLE);
  assert.equal(qwenAvailabilityTestOverride("prefer_local_failover_qwen_unavailable", 20_000).state.status,
    QWEN_AVAILABILITY.UNAVAILABLE);

  const recovery = qwenAvailabilityTestOverride("qwen_recovery", 30_000);
  assert.deepEqual(recovery.transitionTrace, [
    "QWEN_UNAVAILABLE;successes=0", "QWEN_UNAVAILABLE;successes=1", "QWEN_AVAILABLE;successes=2",
  ]);
  assert.equal(recovery.state.status, QWEN_AVAILABILITY.AVAILABLE);
  assert.equal(recovery.state.validUntil > 30_000, true);
});

test("Qwen health requires the expected model from a successful OpenAI models response", () => {
  assert.equal(qwenModelsResponseAvailable({ ok: true, body: { data: [{ id: "qwen3-8b-local" }] } }), true);
  assert.equal(qwenModelsResponseAvailable({ ok: true, body: { data: [{ id: "other" }] } }), false);
  assert.equal(qwenModelsResponseAvailable({ ok: false, body: { data: [{ id: "qwen3-8b-local" }] } }), false);
});

test("network failures are distinguishable from model/application failures", () => {
  assert.equal(isQwenConnectivityFailure({ code: "ECONNREFUSED" }), true);
  assert.equal(isQwenConnectivityFailure(new Error("invalid model response")), false);
});
