import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentAvailability, effectiveLogicalAgentStatus, isRoutableAvailabilityState } from "./agent-availability.mjs";

test("shared-runtime and active fallback are routable while unverified states stay excluded", () => {
  for (const state of ["available", "shared-runtime", "degraded"]) assert.equal(isRoutableAvailabilityState(state), true);
  for (const state of ["unknown", "unverified", "unavailable", "blocked", "paused", null]) assert.equal(isRoutableAvailabilityState(state), false);
});

test("logical agent is routable only through a fresh shared Hermes heartbeat", () => {
  const result = deriveAgentAvailability({
    agentId: "max",
    reportedStatus: "idle",
    sharedRuntimeHeartbeatFresh: true,
    sharedRuntimeHeartbeatAgeMs: 12000,
    routeConfigured: true,
    now: 1_000_000,
  });
  assert.equal(result.availability.state, "shared-runtime");
  assert.equal(result.executionCapability, "routable-via-shared-runtime");
  assert.match(result.availability.reason, /no un proceso independiente/);
});

test("stale or unconfigured shared runtime does not claim logical agent availability", () => {
  const stale = deriveAgentAvailability({
    agentId: "atlas",
    reportedStatus: "idle",
    sharedRuntimeHeartbeatFresh: false,
    routeConfigured: true,
    now: 1_000_000,
  });
  const unconfigured = deriveAgentAvailability({
    agentId: "atlas",
    reportedStatus: "idle",
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: false,
    now: 1_000_000,
  });
  assert.equal(stale.availability.state, "unknown");
  assert.equal(unconfigured.availability.state, "unknown");
});

test("reported workload status stays separate from shared-runtime routability", () => {
  for (const reportedStatus of ["error", "offline"]) {
    const result = deriveAgentAvailability({
      agentId: "max",
      reportedStatus,
      sharedRuntimeHeartbeatFresh: true,
      routeConfigured: true,
      now: 1_000_000,
    });
    assert.equal(result.status, reportedStatus);
    assert.equal(result.availability.state, "shared-runtime");
    assert.equal(result.executionCapability, "routable-via-shared-runtime");
  }
});

test("administrative pause overrides shared runtime readiness", () => {
  const result = deriveAgentAvailability({
    agentId: "domus",
    reportedStatus: "paused",
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: true,
    now: 1_000_000,
  });
  assert.equal(result.availability.state, "paused");
  assert.equal(result.executionCapability, "blocked");
});

test("Codex route stays available without a recent execution when service and heartbeat are healthy", () => {
  const result = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: 990_000,
    codexWorkerServiceHealthy: true,
    lastSuccessfulTaskAt: null,
    providerCapacity: "available",
    now: 1_000_000,
  });
  assert.equal(result.availability.state, "available");
  assert.equal(result.routeAvailable, true);
  assert.equal(result.runtimeStatus, "idle");
  assert.equal(result.recentExecutionVerified, false);
  assert.equal(result.providerCapacity, "available");
  const running = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "working",
    lastActive: 990_000,
    codexWorkerServiceHealthy: true,
    lastSuccessfulTaskAt: null,
    now: 1_000_000,
  });
  assert.equal(running.runtimeStatus, "running");
});

test("Codex route is unavailable when its dedicated worker service is down", () => {
  const result = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: 990_000,
    codexWorkerServiceHealthy: false,
    now: 1_000_000,
  });
  assert.equal(result.routeAvailable, false);
  assert.equal(result.runtimeStatus, "unavailable");
  assert.equal(result.availability.state, "unavailable");
});

test("Codex route is unavailable while the health circuit is open", () => {
  const result = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: 990_000,
    codexWorkerServiceHealthy: true,
    circuit: { open: true, reason: "worker transport failure" },
    now: 1_000_000,
  });
  assert.equal(result.routeAvailable, false);
  assert.equal(result.runtimeStatus, "unavailable");
});

test("provider exhaustion remains separate from a healthy Codex runtime route", () => {
  const result = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    lastActive: 990_000,
    codexWorkerServiceHealthy: true,
    providerCapacity: "exhausted",
    now: 1_000_000,
  });
  assert.equal(result.routeAvailable, true);
  assert.equal(result.availability.state, "available");
  assert.equal(result.providerCapacity, "exhausted");
});

test("Codex still requires a fresh independent worker heartbeat", () => {
  const result = deriveAgentAvailability({
    agentId: "codex",
    reportedStatus: "idle",
    codexWorkerServiceHealthy: true,
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: true,
    now: 1_000_000,
  });
  assert.equal(result.routeAvailable, false);
  assert.equal(result.availability.state, "unavailable");
  assert.equal(result.processState, "stale");
});


test("historical Max failure no longer pins runtime status after shared runtime recovery", () => {
  assert.equal(effectiveLogicalAgentStatus("max", "error", true, false), "idle");
  assert.equal(effectiveLogicalAgentStatus("max", "error", true, true), "error");
  assert.equal(effectiveLogicalAgentStatus("max", "error", false, false), "error");
  assert.equal(effectiveLogicalAgentStatus("atlas", "error", true, false), "error");
});
