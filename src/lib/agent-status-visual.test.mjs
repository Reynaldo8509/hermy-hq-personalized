import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_STATUS_VISUALS, getAgentStatusVisual } from "./agent-status-visual.mjs";

test("idle is yellow and green is reserved for active work", () => {
  assert.equal(AGENT_STATUS_VISUALS.idle.color, "var(--warn)");
  assert.equal(AGENT_STATUS_VISUALS.idle.office.dot, "bg-yellow-400");
  assert.equal(AGENT_STATUS_VISUALS.working.color, "#fb923c");
  assert.equal(AGENT_STATUS_VISUALS.working.office.dot, "bg-orange-400");
  assert.notEqual(AGENT_STATUS_VISUALS.working.color, "var(--up)");
  assert.equal(AGENT_STATUS_VISUALS.active.color, "var(--up)");
});

test("availability, offline, error, paused, and unknown have distinct state colors", () => {
  const colors = ["online", "offline", "error", "paused", "unknown"].map((state) => AGENT_STATUS_VISUALS[state].color);
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(AGENT_STATUS_VISUALS.offline.office.dot, "bg-neutral-600");
  assert.equal(AGENT_STATUS_VISUALS.error.office.dot, "bg-red-400");
  assert.equal(AGENT_STATUS_VISUALS.paused.office.dot, "bg-violet-400");
  assert.equal(AGENT_STATUS_VISUALS.unknown.office.dot, "bg-pink-400");
  assert.equal(getAgentStatusVisual("not-a-state").label, "Unknown");
});
