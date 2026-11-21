import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentWorkStatus } from "../src/lib/agent-work-status.mjs";

test("no active task is idle even when runtime availability is unverified", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unknown" }), "idle");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unverified" }), "idle");
});

test("a current task or running request is working", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unknown", currentTask: "task-1" }), "working");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unknown", hasRunningRequest: true }), "working");
});

test("queued or approval-waiting work does not appear as running", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unknown", hasRunningRequest: false }), "idle");
});

test("administrative pause remains explicit while health failures stay separate from workload", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "paused" }), "paused");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "offline" }), "idle");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "error" }), "idle");
});
