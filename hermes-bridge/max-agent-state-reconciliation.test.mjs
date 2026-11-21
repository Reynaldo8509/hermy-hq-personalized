import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STALE_WORK_GRACE_MS,
  RECONCILE_STALE_MAX_WORK_SQL,
  reconcileStaleMaxWorkState,
} from "./max-agent-state-reconciliation.mjs";

const now = Date.parse("2026-10-25T20:00:00Z");

function fakeDatabase(state, requests = []) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    const live = requests.some((request) => request.kind?.startsWith("max.")
      && request.origin !== "codex" && request.status === "running");
    const lastActive = Date.parse(state.lastActive || state.updatedAt);
    const stale = Number.isFinite(lastActive) && lastActive < params[0].getTime();
    if (state.id !== "max" || state.status !== "working" || live || !stale) return { rows: [] };
    state.status = "online";
    state.currentTask = null;
    state.updatedAt = new Date(now).toISOString();
    return { rows: [{ id: "max" }] };
  };
  return { query, calls };
}

test("terminal failure, cancellation, and restart residue are reconciled after the grace", async () => {
  for (const status of ["failed", "cancelled", "done"]) {
    const state = {
      id: "max", status: "working", currentTask: "private task title",
      lastActive: new Date(now - MAX_STALE_WORK_GRACE_MS - 1).toISOString(),
      updatedAt: new Date(now - 10 * MAX_STALE_WORK_GRACE_MS).toISOString(),
      tasksCompleted: 9, recentActivity: [{ action: "preserved" }],
    };
    const beforeHistory = structuredClone({ tasksCompleted: state.tasksCompleted, recentActivity: state.recentActivity });
    const db = fakeDatabase(state, [{ kind: "max.chief-of-staff", origin: "web", status }]);
    const result = await reconcileStaleMaxWorkState(db.query, now);

    assert.deepEqual(result, { reconciled: true });
    assert.equal(state.status, "online");
    assert.equal(state.currentTask, null);
    assert.deepEqual({ tasksCompleted: state.tasksCompleted, recentActivity: state.recentActivity }, beforeHistory);
    assert.equal(db.calls.length, 1);
  }
});

test("a running MAX request protects the work marker", async () => {
  const state = {
    id: "max", status: "working", currentTask: "live work",
    lastActive: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
    updatedAt: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
  };
  const db = fakeDatabase(state, [{ kind: "max.deep-analysis", origin: "web", status: "running" }]);
  assert.deepEqual(await reconcileStaleMaxWorkState(db.query, now), { reconciled: false });
  assert.equal(state.status, "working");
  assert.equal(state.currentTask, "live work");
});

test("fresh transitions and paused states are preserved", async () => {
  const fresh = {
    id: "max", status: "working", currentTask: "new work",
    lastActive: new Date(now - 1000).toISOString(), updatedAt: new Date(now - 1000).toISOString(),
  };
  assert.equal((await reconcileStaleMaxWorkState(fakeDatabase(fresh).query, now)).reconciled, false);
  assert.equal(fresh.status, "working");
  const paused = {
    id: "max", status: "paused", currentTask: null,
    lastActive: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
    updatedAt: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
  };
  assert.equal((await reconcileStaleMaxWorkState(fakeDatabase(paused).query, now)).reconciled, false);
  assert.equal(paused.status, "paused");
});

test("reconciliation is idempotent and the SQL rechecks state plus a live request atomically", async () => {
  const state = {
    id: "max", status: "working", currentTask: "stale",
    lastActive: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
    updatedAt: new Date(now - 5 * MAX_STALE_WORK_GRACE_MS).toISOString(),
  };
  const db = fakeDatabase(state);
  assert.equal((await reconcileStaleMaxWorkState(db.query, now)).reconciled, true);
  assert.equal((await reconcileStaleMaxWorkState(db.query, now)).reconciled, false);
  assert.equal(db.calls.length, 2);
  assert.match(RECONCILE_STALE_MAX_WORK_SQL, /state\.status='working'/);
  assert.match(RECONCILE_STALE_MAX_WORK_SQL, /COALESCE\(state\."lastActive", state\."updatedAt"\) < \$1/);
  assert.match(RECONCILE_STALE_MAX_WORK_SQL, /request\.status='running'/);
});
