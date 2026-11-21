import assert from "node:assert/strict";
import test from "node:test";
import { runMaxTriageOrInference } from "./max-triage-no-replay.mjs";

test("failed MAX triage is terminal and cannot replay generic inference", async () => {
  let inferenceCalls = 0;
  await assert.rejects(runMaxTriageOrInference(
    async () => { throw Object.assign(new Error("sanitized triage failure"), { code: "max_triage_failed" }); },
    async () => { inferenceCalls += 1; return "must not run"; },
  ), /sanitized triage failure/);
  assert.equal(inferenceCalls, 0);
});

test("only an explicit null triage result permits exactly one generic inference", async () => {
  let inferenceCalls = 0;
  assert.equal(await runMaxTriageOrInference(async () => null, async () => {
    inferenceCalls += 1;
    return "one pass";
  }), "one pass");
  assert.equal(inferenceCalls, 1);
});

test("a delegated triage result prevents generic inference", async () => {
  let inferenceCalls = 0;
  assert.equal(await runMaxTriageOrInference(async () => "delegated", async () => {
    inferenceCalls += 1;
    return "must not run";
  }), "delegated");
  assert.equal(inferenceCalls, 0);
});
