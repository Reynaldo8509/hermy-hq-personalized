import test from "node:test";
import assert from "node:assert/strict";
import { claimHalfOpenProbe, CLAIM_HALF_OPEN_PROBE_SQL, initialProviderBreakerFailureState } from "./provider-breaker-store.mjs";

test("half-open slot claim is one conditional atomic database update", async () => {
  const calls = [];
  const claim = await claimHalfOpenProbe(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ data: { state: "HALF_OPEN" } }] };
  }, { key: "breaker:test", now: 10_000, leaseMs: 500, token: "probe-token" });

  assert.equal(claim.token, "probe-token");
  assert.deepEqual(claim.data, { state: "HALF_OPEN" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, CLAIM_HALF_OPEN_PROBE_SQL);
  assert.deepEqual(calls[0].values, ["breaker:test", "probe-token", 10_500, 10_000]);
  assert.match(CLAIM_HALF_OPEN_PROBE_SQL, /data->>'state'='OPEN'/);
  assert.match(CLAIM_HALF_OPEN_PROBE_SQL, /data->>'state'='HALF_OPEN'/);
  assert.match(CLAIM_HALF_OPEN_PROBE_SQL, /cooldownUntil/);
  assert.match(CLAIM_HALF_OPEN_PROBE_SQL, /probeLeaseExpiresAt/);
});

test("half-open claim fails closed when no row wins the compare-and-set", async () => {
  const claim = await claimHalfOpenProbe(async () => ({ rows: [] }), {
    key: "breaker:test", now: 10_000, leaseMs: 500, token: "probe-token",
  });
  assert.equal(claim, null);
});

test("expired half-open lease can be reclaimed after a bridge restart", async () => {
  let queryText = "";
  const claim = await claimHalfOpenProbe(async (sql) => {
    queryText = sql;
    return { rows: [{ data: { state: "HALF_OPEN", probeLeaseToken: "new-probe" } }] };
  }, { key: "breaker:test", now: 20_000, leaseMs: 500, token: "new-probe" });

  assert.equal(claim.token, "new-probe");
  assert.ok(queryText.includes("data->>'probeLeaseExpiresAt')::bigint,0)<=$4::bigint"));
});

test("first confirmed rate limit initializes a new provider breaker as OPEN", () => {
  const state = initialProviderBreakerFailureState({ errorClass: "rate_limited", httpStatus: 429, now: 50_000 });
  assert.deepEqual({
    state: state.state, providerFailureCount: state.providerFailureCount,
    consecutiveFailures: state.consecutiveFailures, openedAt: state.openedAt,
    cooldownUntil: state.cooldownUntil, disabled: state.disabled,
    lastProviderFailureClass: state.lastProviderFailureClass,
    lastVerifiedHttpStatus: state.lastVerifiedHttpStatus,
    probeLeaseToken: state.probeLeaseToken, probeLeaseExpiresAt: state.probeLeaseExpiresAt,
  }, {
    state: "OPEN", providerFailureCount: 1, consecutiveFailures: 1, openedAt: 50_000,
    cooldownUntil: 1_850_000, disabled: false, lastProviderFailureClass: "rate_limited",
    lastVerifiedHttpStatus: 429, probeLeaseToken: null, probeLeaseExpiresAt: 0,
  });
});

test("first verified 5xx increments the new provider breaker but respects its threshold", () => {
  const state = initialProviderBreakerFailureState({ errorClass: "provider_5xx", httpStatus: 503, now: 80_000 });
  assert.equal(state.state, "CLOSED");
  assert.equal(state.providerFailureCount, 1);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.lastVerifiedHttpStatus, 503);
});
