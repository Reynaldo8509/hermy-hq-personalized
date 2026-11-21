import assert from "node:assert/strict";
import test from "node:test";
import { isTransportFailure, retryDelayMs, safeTransportCause } from "./worker-reliability.mjs";

test("network retry grows exponentially and stays capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(5_000, attempt)),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000],
  );
});

test("invalid poll delay gets a bounded default", () => {
  assert.equal(retryDelayMs(Number.NaN, 1), 5_000);
  assert.equal(retryDelayMs(-1, 1), 250);
});

test("transport errors are classified without logging URL or credentials", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("request to http://private.invalid/path?token=secret failed"), { code: "ECONNRESET" }),
  });
  assert.equal(isTransportFailure(error), true);
  const summary = safeTransportCause(error);
  assert.equal(summary, "TypeError cause=ECONNRESET");
  assert.doesNotMatch(summary, /private|token|secret|path/i);
  assert.equal(isTransportFailure(new Error("503 service unavailable")), false);
});
