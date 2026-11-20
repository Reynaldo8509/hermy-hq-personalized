import assert from "node:assert/strict";
import { isScheduledLedgerAudit, runLedgerAudit } from "./ledger-audit.mjs";
import { createSchedulerAuditProvenance } from "./scheduler-audit-provenance.mjs";

const scheduled = { id: "scheduler-ledger-test", kind: "ledger.operations", origin: "system", sideEffecting: false,
  title: "Ledger · auditoría de continuidad y salud operativa",
  prompt: "Auditoría periódica de solo lectura. Revisa backups." };
const authority = createSchedulerAuditProvenance();
assert.equal(isScheduledLedgerAudit(scheduled), false);
authority.issue(scheduled.id, scheduled.kind, scheduled);
const provenance = authority.resolve(scheduled);
assert.equal(provenance, "ledger");
assert.equal(isScheduledLedgerAudit(scheduled, provenance), true);
for (const change of [{ origin: "user" }, { sideEffecting: true }, { kind: "codex.engineering" }, { prompt: "Repara backup" }]) {
  assert.equal(isScheduledLedgerAudit({ ...scheduled, ...change }, provenance), false);
}
const calls = [];
const report = await runLedgerAudit(async () => ({ rows: [{ kind: "ledger.operations", failures: 1 }] }),
  async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes("list-unit-files")) return { stdout: "hermes-vps-backup.service static -\npg_basebackup@.service disabled -\n" };
    if (args.includes("show")) return { stdout: "Result=exit-code\nExecMainStatus=23" };
    if (file === "git") throw Object.assign(new Error("missing"), { code: 128 });
    return { stdout: "" };
  });
assert.match(report, /ATENCIÓN/);
assert.match(report, /NO VERIFICADO/);
assert.match(report, /no demuestra recuperabilidad/);
assert.ok(calls.find(c => c.args.includes("show")).args.includes("hermes-vps-backup.service"));
assert.ok(!calls.find(c => c.args.includes("show")).args.includes("pg_basebackup@.service"));
assert.ok(calls.every(c => c.options.timeout === 8000 && !c.options.shell));
const failed = await runLedgerAudit(async () => { throw new Error("DB unavailable"); }, async () => { throw new Error("probe unavailable"); });
assert.match(failed, /Historial de agentes HQ no disponible/);
assert.doesNotMatch(failed, /Bloqueadores de comprobación: ninguno/);
console.log("PASS: authenticated scheduler provenance, scheduled scope, failure visibility and bounded read-only probes");
