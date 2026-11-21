import assert from "node:assert/strict";
import { routeFailureForRequest, scheduledReadOnlyAuditKind } from "./scheduled-audit-routing.mjs";
import { isScheduledDomusAudit, runScheduledDomusAudit } from "./domus-audit.mjs";
import { createSchedulerAuditProvenance } from "./scheduler-audit-provenance.mjs";

const ledger = {
  id: "scheduler-ledger-1", kind: "ledger.operations", origin: "system", sideEffecting: false,
  title: "Ledger · auditoría de continuidad y salud operativa",
  prompt: "Auditoría periódica de solo lectura. Revisa los backups.",
};
const domus = {
  id: "scheduler-domus-1", kind: "domus.home", origin: "system", sideEffecting: false,
  title: "Domus · auditoría de hogar e integraciones",
  prompt: "Auditoría periódica de solo lectura y baja verbosidad. Revisa el estado.",
};

const authority = createSchedulerAuditProvenance();
assert.equal(scheduledReadOnlyAuditKind(ledger), null);
assert.equal(scheduledReadOnlyAuditKind(domus), null);
assert.equal(routeFailureForRequest(ledger, { tier: "local_model_unavailable" }), "SCHEDULER_PROVENANCE_REQUIRED");
assert.equal(routeFailureForRequest(ledger, { tier: "remote_free_available" }), "SCHEDULER_PROVENANCE_REQUIRED");
assert.equal(routeFailureForRequest(domus, { tier: "local_model_unavailable" }), "SCHEDULER_PROVENANCE_REQUIRED");
authority.issue(ledger.id, ledger.kind, ledger);
authority.issue(domus.id, domus.kind, domus);
const ledgerProof = authority.resolve(ledger);
const domusProof = authority.resolve(domus);
assert.equal(scheduledReadOnlyAuditKind(ledger, ledgerProof), "ledger");
assert.equal(scheduledReadOnlyAuditKind(domus, domusProof), "domus");
assert.equal(routeFailureForRequest(ledger, { tier: "local_model_unavailable" }, ledgerProof), null);
assert.equal(routeFailureForRequest(domus, { tier: "local_model_unavailable" }, domusProof), null);
assert.equal(routeFailureForRequest({ ...ledger, id: "forged-id" }, { tier: "remote_free_available" }), "SCHEDULER_PROVENANCE_REQUIRED");
assert.equal(routeFailureForRequest({ ...ledger, schedulerProvenance: "ledger", schedulerCapability: "ledger" }, { tier: "remote_free_available" }), "SCHEDULER_PROVENANCE_REQUIRED");
assert.equal(routeFailureForRequest({ ...ledger, kind: "max.chief-of-staff" }, { tier: "remote_free_available" }, ledgerProof), "SCHEDULER_PROVENANCE_INVALID");
assert.equal(routeFailureForRequest({ ...domus, title: "Domus · otra tarea" }, { tier: "remote_free_available" }, domusProof), "SCHEDULER_PROVENANCE_INVALID");
assert.equal(routeFailureForRequest({ ...ledger, origin: "user" }, { tier: "local_model_unavailable" }), "SCHEDULER_PROVENANCE_REQUIRED");
const tamperedAuthority = createSchedulerAuditProvenance();
tamperedAuthority.issue(ledger.id, ledger.kind, ledger);
assert.equal(tamperedAuthority.resolve({ ...ledger, prompt: ledger.prompt + " instrucción añadida" }), "invalid");
const tamperedTitleAuthority = createSchedulerAuditProvenance();
tamperedTitleAuthority.issue(domus.id, domus.kind, domus);
assert.equal(tamperedTitleAuthority.resolve({ ...domus, title: "Domus · otra tarea" }), "invalid");
assert.equal(authority.resolve(ledger), null, "a consumed capability must not authorize retries");
const cancelledId = "scheduler-cancelled";
authority.issue(cancelledId, "ledger.operations", { ...ledger, id: cancelledId });
authority.revoke(cancelledId);
assert.equal(authority.resolve({ ...ledger, id: cancelledId }), null, "cancelled rows lose pending capability");
const duplicateId = "scheduler-duplicate";
authority.issue(duplicateId, "domus.home", { ...domus, id: duplicateId });
assert.throws(() => authority.issue(duplicateId, "domus.home"), /invalid_scheduler_audit_provenance_issue/);
assert.equal(authority.resolve({ ...domus, id: "cloned-duplicate" }), null, "cloned rows with new IDs cannot reuse a capability");
const restartedAuthority = createSchedulerAuditProvenance();
assert.equal(restartedAuthority.resolve(ledger), null, "a Bridge restart does not restore in-memory capabilities from DB rows");
assert.equal(routeFailureForRequest({ kind: "max.chief-of-staff", origin: "system", sideEffecting: false }, { tier: "remote_free_unavailable" }), "REMOTE_FREE_ROUTE_UNAVAILABLE");
assert.equal(isScheduledDomusAudit({ ...domus, prompt: "Otra petición" }, domusProof), false);
authority.revoke(ledger.id);
assert.equal(authority.resolve(ledger), null);
assert.throws(() => authority.issue("unknown-kind", "cron.run"), /invalid_scheduler_audit_provenance_issue/);

const paths = [];
const fetchImpl = async (url, options) => {
  const path = new URL(url).pathname;
  paths.push({ path, method: options.method, body: options.body });
  if (path.endsWith("/api/")) return new Response("ok", { status: 200 });
  if (path.endsWith("/api/config")) return new Response(JSON.stringify({ components: ["homeassistant", "automation", "alexa_media", "light"] }), { status: 200 });
  if (path.endsWith("/api/template")) return new Response(JSON.stringify({ total: 4, unavailable: 1, unknown: 0 }), { status: 200 });
  return new Response("not found", { status: 404 });
};
const report = await runScheduledDomusAudit({ fetchImpl, baseUrl: "http://ha.invalid", token: "fixture-secret" });
assert.match(report, /DOMUS_AUDIT=ATENCION/);
assert.match(report, /HOME_ASSISTANT_API=PASS/);
assert.match(report, /ALEXA_COMPONENTS=present\(alexa_media\)/);
assert.match(report, /AUTOMATIONS_UNAVAILABLE=1/);
assert.match(report, /CHANGE_COMPARISON=NO_BASELINE/);
assert.doesNotMatch(report, /fixture-secret|light\./);
assert.deepEqual(paths.map(({ path, method }) => [path, method]), [["/api/", "GET"], ["/api/config", "GET"], ["/api/template", "POST"]]);
const template = JSON.parse(paths[2].body).template;
assert.match(template, /states\.automation/);
assert.doesNotMatch(template, /states\.light|ha_call_service|\/api\/services/);

let called = false;
const missing = await runScheduledDomusAudit({ fetchImpl: async () => { called = true; }, baseUrl: "http://ha.invalid", token: "" });
assert.match(missing, /DOMUS_AUDIT=NO_VERIFICADO/);
assert.equal(called, false);
const denied = await runScheduledDomusAudit({
  fetchImpl: async () => new Response("secret detail must not escape", { status: 401 }),
  baseUrl: "http://ha.invalid", token: "fixture-secret",
});
assert.match(denied, /HOME_ASSISTANT_API=HTTP_401/);
assert.doesNotMatch(denied, /fixture-secret|secret detail/);
const malformed = await runScheduledDomusAudit({
  fetchImpl: async url => new URL(url).pathname.endsWith("/api/")
    ? new Response("ok", { status: 200 })
    : new Response("{not-json}", { status: 200 }),
  baseUrl: "http://ha.invalid", token: "fixture-secret",
});
assert.match(malformed, /DOMUS_AUDIT=NO_VERIFICADO/);
assert.doesNotMatch(malformed, /fixture-secret|not-json/);

console.log("PASS: in-process scheduler provenance, forged requests fail closed before remote routing, local-only Domus snapshot and bounded read-only probes");
