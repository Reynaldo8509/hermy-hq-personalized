import assert from "node:assert/strict";
import test from "node:test";
import { createCodexCapacityReader, normalizeCodexCapacity } from "./codex-provider-capacity.mjs";

test("normalizes available provider capacity without inventing missing values", () => {
  const value = normalizeCodexCapacity({ rateLimits: { primary: { usedPercent: 9, resetsAt: "2026-10-02T00:00:00Z" }, secondary: { usedPercent: 72 }, rateLimitReachedType: null, spendControlReached: false } }, "2026-10-01T00:00:00Z");
  assert.equal(value.state, "available");
  assert.equal(value.remaining_percent, 91);
  assert.equal(value.weekly_used_percent, 72);
  assert.equal(value.reset_at, "2026-10-02T00:00:00Z");
  assert.equal(normalizeCodexCapacity({}).state, "unknown");
});

test("explicit provider limits exhaust capacity; RPC failures become unknown and are cached", async () => {
  assert.equal(normalizeCodexCapacity({ rateLimitReachedType: "primary", spendControlReached: false }).state, "exhausted");
  let calls = 0, now = 0;
  const reader = createCodexCapacityReader({ read: async () => { calls++; throw new Error("offline"); }, now: () => now, ttlMs: 60000 });
  assert.equal((await reader()).state, "unknown");
  assert.equal((await reader()).state, "unknown");
  assert.equal(calls, 1);
  now = 61000;
  await reader();
  assert.equal(calls, 2);
  const runtimeLimited = await reader({ providerLimitReason: "429 usage limit reached" });
  assert.equal(runtimeLimited.state, "exhausted");
  assert.equal(runtimeLimited.source, "openai_runtime_response");
  assert.equal((await reader()).state, "exhausted");
  assert.equal(calls, 2);
});
