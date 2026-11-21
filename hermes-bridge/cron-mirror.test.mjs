import test from "node:test";
import assert from "node:assert/strict";
import { failedCronMirror, parseCronJobs, successfulCronMirror } from "./cron-mirror.mjs";

const EMPTY_CRON_OUTPUT = "No scheduled jobs\nRun `hermes cron add` to create one.\n";

test("empty cron output is zero jobs, not output lines", () => {
  assert.deepEqual(parseCronJobs(EMPTY_CRON_OUTPUT), []);
  assert.deepEqual(successfulCronMirror(EMPTY_CRON_OUTPUT, "2026-10-17T00:00:00.000Z").jobs, []);
});

test("scheduled cron output becomes structured job records", () => {
  const raw = [
    "Scheduled jobs:",
    "  a1b2c3d4 [active]",
    "    Name: Morning digest",
    "    Schedule: 0 8 * * *",
    "    Next run: 2026-10-18T08:00:00Z",
    "    Last run: 2026-10-17T08:00:00Z success",
  ].join("\n");
  assert.deepEqual(parseCronJobs(raw), [{
    id: "a1b2c3d4", status: "active", name: "Morning digest", schedule: "0 8 * * *",
    nextRun: "2026-10-18T08:00:00Z", lastRun: "2026-10-17T08:00:00Z", lastResult: "success",
    deliver: null, skills: null, script: null, mode: null,
  }]);
});

test("cron command failure stays an error and preserves the last successful snapshot", () => {
  const previous = successfulCronMirror("  a1b2c3d4 [active]\n    Name: digest\n", "2026-10-16T00:00:00.000Z");
  const failed = failedCronMirror(previous, "2026-10-17T00:00:00.000Z");
  assert.equal(failed.syncStatus, "error");
  assert.equal(failed.syncError, "cron_list_failed");
  assert.equal(failed.syncedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(failed.lastAttemptAt, "2026-10-17T00:00:00.000Z");
  assert.deepEqual(failed.jobs, previous.jobs);
});
