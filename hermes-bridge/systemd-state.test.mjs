import test from "node:test";
import assert from "node:assert/strict";
import { isActionableSystemdFailure, parseSystemdUnitState } from "./systemd-state.mjs";

test("systemd status distinguishes active, real failures, access errors, and unknown units", () => {
  assert.equal(parseSystemdUnitState("loaded active running"), "active");
  assert.equal(parseSystemdUnitState("loaded inactive dead"), "inactive");
  assert.equal(parseSystemdUnitState("loaded failed failed"), "failed");
  assert.equal(parseSystemdUnitState("Failed to connect to bus: Permission denied"), "permission_denied");
  assert.equal(parseSystemdUnitState("not-found inactive dead"), "unknown");
  assert.equal(parseSystemdUnitState(""), "unknown");
});

test("only deterministically inactive or failed units trigger incident classification", () => {
  assert.equal(isActionableSystemdFailure("inactive"), true);
  assert.equal(isActionableSystemdFailure("failed"), true);
  assert.equal(isActionableSystemdFailure("permission_denied"), false);
  assert.equal(isActionableSystemdFailure("unknown"), false);
  assert.equal(isActionableSystemdFailure("active"), false);
});
