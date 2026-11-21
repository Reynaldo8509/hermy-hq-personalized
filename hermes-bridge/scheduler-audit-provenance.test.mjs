import assert from "node:assert/strict";
import {
  createSchedulerAuditProvenance,
  isRecoverableSchedulerProvenanceFailure,
  planScheduledAuditRecovery,
  pruneInactiveSchedulerAuditProvenance,
} from "./scheduler-audit-provenance.mjs";

function request(id, kind = "ledger.operations") {
  return {
    id, kind, origin: "system", sideEffecting: false,
    title: kind === "ledger.operations" ? "Ledger · auditoría de continuidad y salud operativa" : "Domus · auditoría de hogar e integraciones",
    prompt: kind === "ledger.operations" ? "Auditoría periódica de solo lectura. Revisa backups." : "Auditoría periódica de solo lectura y baja verbosidad. Revisa el estado.",
    action: null, capability: null,
  };
}

const authority = createSchedulerAuditProvenance();
const original = request("internal-1");
authority.issue(original.id, original.kind, original);
assert.equal(authority.resolve({ ...original, schedulerProvenance: "ledger", schedulerCapability: "forged" }), "ledger");
assert.equal(authority.resolve(original), null, "the proof is consumed once and cannot authorize retries");
assert.deepEqual(authority.pendingIds(), []);
assert.deepEqual(authority.inFlightIds(), ["internal-1"], "consumed proof only marks the current process as executing");
authority.revoke("internal-1");
assert.deepEqual(authority.inFlightIds(), []);

const forged = createSchedulerAuditProvenance();
assert.equal(forged.resolve(request("payload-only")), null, "a DB/API-shaped payload cannot mint a proof");
assert.throws(() => forged.issue("bad", "ledger.operations"), /invalid_scheduler_audit_provenance_issue/);
assert.throws(() => forged.issue("bad", "ledger.operations", { ...request("bad"), origin: "user" }), /invalid_scheduler_audit_provenance_issue/);
assert.throws(() => forged.issue("bad", "ledger.operations", { ...request("bad"), sideEffecting: true }), /invalid_scheduler_audit_provenance_issue/);

const duplicate = createSchedulerAuditProvenance();
const duplicateRequest = request("duplicate-id");
duplicate.issue(duplicateRequest.id, duplicateRequest.kind, duplicateRequest);
assert.throws(() => duplicate.issue(duplicateRequest.id, duplicateRequest.kind, duplicateRequest), /invalid_scheduler_audit_provenance_issue/);
assert.equal(duplicate.resolve(request("copied-to-new-id")), null, "cloned DB rows cannot reuse a proof");

const afterRestart = createSchedulerAuditProvenance();
assert.equal(afterRestart.resolve(duplicateRequest), null, "restart does not load authority from queued DB rows");

const lifecycle = createSchedulerAuditProvenance();
for (const [id, state] of Object.entries({ queued: "queued", approved: "approved", running: "running", cancelled: "cancelled", rejected: "rejected", failed: "failed", done: "done" })) {
  const row = request(`lifecycle-${id}`);
  lifecycle.issue(row.id, row.kind, row);
}
const states = new Map(Object.entries({ queued: "queued", approved: "approved", running: "running", cancelled: "cancelled", rejected: "rejected", failed: "failed", done: "done" }).map(([key, value]) => [`lifecycle-${key}`, value]));
const swept = await pruneInactiveSchedulerAuditProvenance(lifecycle, async ids => ids.filter(id => ["queued", "approved", "running"].includes(states.get(id))));
assert.deepEqual(swept, { revoked: 4, failClosed: false });
assert.deepEqual(lifecycle.pendingIds().sort(), ["lifecycle-approved", "lifecycle-queued", "lifecycle-running"]);

const failedSweep = createSchedulerAuditProvenance();
for (const id of ["cancel-race", "queue-read-error"]) {
  const row = request(id);
  failedSweep.issue(row.id, row.kind, row);
}
const failure = new Error("DB unavailable");
let reported = null;
const failedSweepResult = await pruneInactiveSchedulerAuditProvenance(failedSweep, async () => { throw failure; }, error => { reported = error; });
assert.deepEqual(failedSweepResult, { revoked: 2, failClosed: true });
assert.equal(reported, failure);
assert.deepEqual(failedSweep.pendingIds(), []);

const emptySweep = createSchedulerAuditProvenance();
let queriedEmpty = false;
assert.deepEqual(await pruneInactiveSchedulerAuditProvenance(emptySweep, async () => { queriedEmpty = true; return []; }), { revoked: 0, failClosed: false });

assert.equal(queriedEmpty, false);

const staleInFlight = createSchedulerAuditProvenance();
const staleInFlightRequest = request("finished-in-flight");
staleInFlight.issue(staleInFlightRequest.id, staleInFlightRequest.kind, staleInFlightRequest);
assert.equal(staleInFlight.resolve(staleInFlightRequest), "ledger");
const inFlightSweep = await pruneInactiveSchedulerAuditProvenance(staleInFlight, async () => []);
assert.deepEqual(inFlightSweep, { revoked: 1, failClosed: false });
assert.deepEqual(staleInFlight.inFlightIds(), [], "terminal task cleanup removes only the in-flight marker");
assert.equal(staleInFlight.resolve(staleInFlightRequest), null, "cleanup never restores a consumed proof");

const failedInFlightSweepAuthority = createSchedulerAuditProvenance();
const failedInFlightRequest = request("failed-in-flight-sweep");
failedInFlightSweepAuthority.issue(failedInFlightRequest.id, failedInFlightRequest.kind, failedInFlightRequest);
assert.equal(failedInFlightSweepAuthority.resolve(failedInFlightRequest), "ledger");
const failedInFlightSweepResult = await pruneInactiveSchedulerAuditProvenance(
  failedInFlightSweepAuthority,
  async () => { throw new Error("DB unavailable"); },
);
assert.deepEqual(failedInFlightSweepResult, { revoked: 1, failClosed: true });
assert.deepEqual(failedInFlightSweepAuthority.inFlightIds(), []);
assert.equal(failedInFlightSweepAuthority.resolve(failedInFlightRequest), null);



const canonical = {
  kind: "ledger.operations",
  origin: "system",
  sideEffecting: false,
  title: "Ledger · auditoría de continuidad y salud operativa",
  prompt: "Auditoría periódica de solo lectura. Revisa backups.",
  action: "audit",
  capability: "read_only",
};
const staleAfterRestart = { ...canonical, id: "old-after-restart", status: "queued" };
assert.deepEqual(
  planScheduledAuditRecovery([staleAfterRestart], canonical),
  { staleIds: ["old-after-restart"], currentIds: [], blockedIds: [] },
  "a canonical orphan is recoverable only by the scheduler",
);
assert.deepEqual(
  planScheduledAuditRecovery([staleAfterRestart], canonical, { activeRequestId: staleAfterRestart.id }),
  { staleIds: [], currentIds: [staleAfterRestart.id], blockedIds: [] },
  "current in-process work is never replaced",
);
const activeProof = createSchedulerAuditProvenance();
activeProof.issue(staleAfterRestart.id, staleAfterRestart.kind, staleAfterRestart);
assert.deepEqual(
  planScheduledAuditRecovery([staleAfterRestart], canonical, { liveAuthorityIds: activeProof.pendingIds() }),
  { staleIds: [], currentIds: [staleAfterRestart.id], blockedIds: [] },
  "a capability still pending in this process protects the queued request",
);
for (const tampered of [
  { ...staleAfterRestart, prompt: "changed" },
  { ...staleAfterRestart, origin: "user" },
  { ...staleAfterRestart, sideEffecting: true },
  { ...staleAfterRestart, action: "execute" },
  { ...staleAfterRestart, capability: "write" },
]) {
  assert.deepEqual(
    planScheduledAuditRecovery([tampered], canonical),
    { staleIds: [], currentIds: [], blockedIds: [staleAfterRestart.id] },
    "payload or privilege changes cannot be adopted during recovery",
  );
}
const staleAuthority = createSchedulerAuditProvenance();
assert.equal(staleAuthority.resolve(staleAfterRestart), null, "restart never restores the old proof");
const freshAfterRestart = { ...canonical, id: "fresh-after-restart" };
staleAuthority.issue(freshAfterRestart.id, freshAfterRestart.kind, freshAfterRestart);
assert.equal(staleAuthority.resolve(staleAfterRestart), null, "recovery never reuses the old request ID");
assert.equal(staleAuthority.resolve(freshAfterRestart), "ledger", "the scheduler issues a new proof for a new ID");
assert.equal(staleAuthority.resolve(freshAfterRestart), null, "the recovered request remains one-shot");
assert.equal(
  isRecoverableSchedulerProvenanceFailure(
    { ...staleAfterRestart, status: "failed", error: "SCHEDULER_PROVENANCE_REQUIRED" },
    canonical,
  ),
  true,
);
assert.equal(
  isRecoverableSchedulerProvenanceFailure(
    { ...staleAfterRestart, status: "failed", error: "SCHEDULER_PROVENANCE_INVALID" },
    canonical,
  ),
  false,
);
assert.equal(
  isRecoverableSchedulerProvenanceFailure(
    { ...staleAfterRestart, status: "cancelled", error: "SCHEDULER_PROVENANCE_REQUIRED" },
    canonical,
  ),
  false,
);
assert.equal(
  isRecoverableSchedulerProvenanceFailure(
    { ...staleAfterRestart, status: "failed", error: "SCHEDULER_CAPABILITY_EXPIRED_BRIDGE_PROCESS" },
    canonical,
  ),
  true,
  "a CAS-abandoned row can be retried if fresh request insertion was interrupted",
);

console.log("PASS: scheduler proof is exact-payload, one-shot, memory-only, fail-closed across restart/cancel/retry/duplicate and DB sweep failures");
