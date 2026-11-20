import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentAvailability } from "../src/lib/agent-availability.mjs";

const now = Date.parse("2026-09-28T05:00:00.000Z");

test("idle registry without an independent worker heartbeat is not available", () => {
  const health = deriveAgentAvailability({
    agentId: "max",
    reportedStatus: "idle",
    lastActive: "2026-09-25T21:00:00.000Z",
    now,
  });
  assert.equal(health.status, "unknown");
  assert.equal(health.availability.state, "unknown");
  assert.equal(health.processState, "not-monitored");
});

test("stale Codex idle record becomes unavailable rather than idle", () => {
  const health = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: "2026-09-28T04:58:00.000Z",
    now,
  });
  assert.equal(health.status, "offline");
  assert.equal(health.availability.state, "unavailable");
});

test("healthy worker service and fresh heartbeat make the route available without execution proof", () => {
  const health = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: "2026-09-28T04:59:45.000Z",
    codexWorkerServiceHealthy: true,
    providerCapacity: "unknown",
    now,
  });
  assert.equal(health.processState, "running");
  assert.equal(health.dependencyState, "reachable");
  assert.equal(health.availability.state, "available");
  assert.equal(health.routeAvailable, true);
  assert.equal(health.recentExecutionVerified, false);
  assert.equal(health.providerCapacity, "unknown");
  assert.equal(health.executionCapability, "unverified");
});

test("recent completed task and fresh healthy worker heartbeat verify execution separately", () => {
  const health = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: "2026-09-28T04:59:45.000Z",
    lastSuccessfulTaskAt: "2026-09-28T04:40:00.000Z",
    codexWorkerServiceHealthy: true,
    now,
  });
  assert.equal(health.availability.state, "available");
  assert.equal(health.routeAvailable, true);
  assert.equal(health.recentExecutionVerified, true);
  assert.equal(health.executionCapability, "verified");
});

test("pause, emergency stop and open circuit override readiness", () => {
  const base = { agentId: "codex", reportedStatus: "idle", lastActive: "2026-09-28T04:59:45.000Z", lastSuccessfulTaskAt: "2026-09-28T04:40:00.000Z", codexWorkerServiceHealthy: true, now };
  assert.equal(deriveAgentAvailability({ ...base, reportedStatus: "paused" }).availability.state, "paused");
  const emergency = deriveAgentAvailability({ ...base, emergencyStopActive: true });
  assert.equal(emergency.availability.state, "blocked");
  assert.equal(emergency.routeAvailable, false);
  const circuit = deriveAgentAvailability({ ...base, circuit: { open: true, activeAgent: "codex-backup" } });
  assert.equal(circuit.availability.state, "unavailable");
  assert.equal(circuit.routeAvailable, false);
});
