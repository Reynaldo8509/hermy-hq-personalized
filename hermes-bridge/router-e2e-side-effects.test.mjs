import assert from "node:assert/strict";
import test from "node:test";
import {
  notifySpecialistOutcomeIfAllowed,
  publishAtlasReportIfAllowed,
} from "../src/lib/router-e2e-side-effects.mjs";

const atlasRequest = { id: "synthetic-atlas-1", kind: "atlas.research", title: "Fictional report", origin: "test", sideEffecting: false };

test("origin=test synthetic routing E2E suppresses Atlas report publication and nested Telegram effects", async () => {
  const calls = { reportFile: 0, wikiCommit: 0, mirror: 0, telegram: 0 };
  const published = await publishAtlasReportIfAllowed({
    request: atlasRequest,
    result: "complete six-field synthetic report",
    routingE2ETest: true,
  }, async () => {
    calls.reportFile += 1;
    calls.wikiCommit += 1;
    calls.mirror += 1;
    calls.telegram += 1;
  });

  assert.equal(published, null);
  assert.deepEqual(calls, { reportFile: 0, wikiCommit: 0, mirror: 0, telegram: 0 });
});

test("origin=test synthetic routing E2E suppresses specialist external notifications", async () => {
  let notifications = 0;
  const notified = await notifySpecialistOutcomeIfAllowed({
    agent: { id: "atlas", name: "Atlas" },
    request: atlasRequest,
    status: "done",
    routingE2ETest: true,
  }, async () => { notifications += 1; });

  assert.equal(notified, false);
  assert.equal(notifications, 0);
});

test("normal Atlas requests keep the existing publisher and specialist notification behavior", async () => {
  const calls = { report: 0, telegram: 0, notification: 0 };
  const report = await publishAtlasReportIfAllowed({
    request: atlasRequest,
    result: "normal Atlas report",
  }, async (request, result) => {
    calls.report += 1;
    calls.telegram += 1;
    assert.equal(request, atlasRequest);
    assert.equal(result, "normal Atlas report");
    return { rel: "atlas_report.md", telegram: true };
  });
  const notified = await notifySpecialistOutcomeIfAllowed({
    agent: { id: "atlas", name: "Atlas" },
    request: atlasRequest,
    status: "done",
  }, async () => { calls.notification += 1; });

  assert.deepEqual(report, { rel: "atlas_report.md", telegram: true });
  assert.equal(notified, true);
  assert.deepEqual(calls, { report: 1, telegram: 1, notification: 1 });
});
