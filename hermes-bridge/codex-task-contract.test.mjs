import assert from "node:assert/strict";
import test from "node:test";
import { codexTaskPolicy } from "./codex-task-contract.mjs";

const assignment = { priority: "important", target: "Hermy HQ worker queue", expectedOutcome: "Return a bounded read-only result", rationale: "The readiness test needs a specific task and an auditable worker result." };
const tag = "[[CODEX_ASSIGNMENT_V1:" + JSON.stringify(assignment) + "]]\n";
const audit = (payload, overrides = {}) => ({
  origin: "max", kind: "codex.audit", status: "queued", sideEffecting: false,
  action: "audit", capability: "read_only",
  prompt: tag + "[[CODEX_INTENT_V1:read_only]]\nRead-only instructions.\n\n[Tarea solicitada]\n" + payload,
  ...overrides,
});

test("codex.audit with the immutable read-only capability is eligible while queued", () => {
  assert.deepEqual(codexTaskPolicy(audit("Read the worker status and return evidence.")), { eligible: true, intent: "read_only", reason: null });
});

test("codex.change needs the privileged capability and an approved status", () => {
  const change = { ...audit("Update the source file."), kind: "codex.change", status: "queued", sideEffecting: true, action: "engineering_change", capability: "privileged", prompt: tag + "[[CODEX_INTENT_V1:write]]\nChange task.\n\n[Tarea solicitada]\nUpdate the source file." };
  assert.equal(codexTaskPolicy(change).eligible, false);
  assert.equal(codexTaskPolicy({ ...change, status: "approved" }).eligible, true);
});

test("destructive work remains approval-gated as a codex.change", () => {
  const destructive = { ...audit("Delete a generated test fixture."), kind: "codex.change", sideEffecting: true, action: "engineering_change", capability: "privileged", prompt: tag + "[[CODEX_INTENT_V1:write]]\nDestructive task.\n\n[Tarea solicitada]\nDelete a generated test fixture." };
  assert.equal(codexTaskPolicy(destructive).reason, "change_requires_approval");
  assert.equal(codexTaskPolicy({ ...destructive, status: "approved" }).eligible, true);
});

test("a read-only label cannot authorize write intent", () => {
  const mislabeled = audit("Write a file in the repository and report its path.");
  assert.deepEqual(codexTaskPolicy(mislabeled), { eligible: false, reason: "read_only_intent_conflicts_with_payload" });
  assert.equal(codexTaskPolicy(audit("Do not write files; report only the observed state.")).eligible, true);
});

test("unknown or mismatched capabilities fail closed", () => {
  assert.equal(codexTaskPolicy(audit("Read service state.", { capability: "privileged" })).eligible, false);
  assert.equal(codexTaskPolicy(audit("Read service state.", { sideEffecting: true })).eligible, false);
  assert.equal(codexTaskPolicy(audit("Read service state.", { origin: "web" })).eligible, false);
});

test("owner manual override bypasses assignment priority only with server authorization and retains read-only enforcement", () => {
  const manual = { ...audit("Read service state and return evidence."), origin: "web" };
  assert.equal(codexTaskPolicy(manual).eligible, false);
  assert.equal(codexTaskPolicy(manual, "queued", true).eligible, true);
  assert.equal(codexTaskPolicy({ ...manual, prompt: tag + "[[CODEX_INTENT_V1:read_only]]\nRead-only instructions.\n\n[Tarea solicitada]\nWrite a file in the repository." }, "queued", true).eligible, false);
  assert.equal(codexTaskPolicy({ ...manual, capability: "privileged" }, "queued", true).eligible, false);
});

test("manual engineering work remains blocked until the individual human approval", () => {
  const change = {
    ...audit("Update the requested source file."),
    origin: "web", kind: "codex.change", status: "awaiting_approval", sideEffecting: true,
    action: "engineering_change", capability: "privileged",
    prompt: "[[CODEX_INTENT_V1:write]]\n\n[Tarea solicitada]\nUpdate the requested source file.",
  };
  assert.equal(codexTaskPolicy(change, change.status, true).eligible, false);
  assert.equal(codexTaskPolicy({ ...change, status: "approved" }, "approved", true).eligible, true);
});
