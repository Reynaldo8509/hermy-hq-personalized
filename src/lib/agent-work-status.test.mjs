import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentWorkStatus } from "./agent-work-status.mjs";

test("agents with no active request are idle even when health is unavailable", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "error" }), "idle");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "offline" }), "idle");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "unknown" }), "idle");
});

test("active work takes precedence over reported health, while administrative pause remains", () => {
  assert.equal(deriveAgentWorkStatus({ healthStatus: "error", hasRunningRequest: true }), "working");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "online", currentTask: "task" }), "working");
  assert.equal(deriveAgentWorkStatus({ healthStatus: "paused", hasRunningRequest: true }), "paused");
});
