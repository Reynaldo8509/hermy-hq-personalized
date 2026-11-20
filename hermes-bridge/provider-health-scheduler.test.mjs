import test from "node:test";
import assert from "node:assert/strict";
import { createProviderHealthInFlight, providerHealthRoutePatch } from "./provider-health-scheduler.mjs";

test("a stuck provider health probe does not block a different provider route", () => {
  const inFlight = createProviderHealthInFlight();
  assert.equal(inFlight.begin("custom:tokenharbor:mimo-v2.6-flash:free"), true);
  assert.equal(inFlight.begin("custom:tokenharbor:mimo-v2.6-flash:free"), false);
  assert.equal(inFlight.begin("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"), true);
  assert.equal(inFlight.has("custom:tokenharbor:mimo-v2.6-flash:free"), true);
  assert.equal(inFlight.has("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"), true);
  assert.equal(inFlight.end("custom:tokenharbor:mimo-v2.6-flash:free"), true);
  assert.equal(inFlight.begin("custom:tokenharbor:mimo-v2.6-flash:free"), true);
  assert.equal(inFlight.has("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"), true);
});

test("provider health updates preserve sibling readiness and mirror only the primary route", () => {
  const mimo = { status: "healthy", verified_free: true };
  const openrouter = { status: "unknown", verified_free: true };
  const first = providerHealthRoutePatch({}, "custom:tokenharbor:mimo-v2.6-flash:free", mimo,
    "custom:tokenharbor:mimo-v2.6-flash:free");
  const second = providerHealthRoutePatch(first, "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free", openrouter,
    "custom:tokenharbor:mimo-v2.6-flash:free");
  assert.deepEqual(second.healthByRoute, {
    "custom:tokenharbor:mimo-v2.6-flash:free": mimo,
    "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free": openrouter,
  });
  assert.equal(second.health, undefined);
  const primaryUpdate = providerHealthRoutePatch(second, "custom:tokenharbor:mimo-v2.6-flash:free",
    { status: "probing" }, "custom:tokenharbor:mimo-v2.6-flash:free");
  assert.equal(primaryUpdate.health.status, "probing");
  assert.equal(primaryUpdate.healthByRoute["openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"], openrouter);
});
