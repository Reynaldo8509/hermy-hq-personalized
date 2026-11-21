import assert from "node:assert/strict";
import test from "node:test";
import { codexAdmission, codexAssignmentAllowed, codexAssignmentFromPrompt, codexParentAttemptAllowed, codexTaskFingerprint, isCodexPriorityAllowed, normalizeCodexPolicy } from "./codex-policy.mjs";

const valid = { priority: "critical", target: "Hermy HQ Codex worker admission", expectedOutcome: "Return an auditable worker eligibility decision", rationale: "This requires a complex engineering capability unavailable to routine agents.", taskClass: "complex_engineering", codexRequiredReason: "The worker admission control plane requires engineering changes.", lowerRouteFailed: false, exclusiveCapability: false, requestedBy: "agent", requestedExecutor: "codex", requiredCapability: "read_only", parentRequestId: "parent-1", normalizedIntent: "Audit worker admission" };
const prompt = "[[CODEX_ASSIGNMENT_V1:" + JSON.stringify(valid) + "]]\nTask body";

test("local rolling limits remain telemetry only and default admission is critical", () => {
  assert.equal(normalizeCodexPolicy(null).localTimeQuotaEnabled, false);
  assert.equal(normalizeCodexPolicy(null).minimumPriority, "critical");
  assert.equal(isCodexPriorityAllowed("critical", null), true);
  assert.equal(isCodexPriorityAllowed("important", null), false);
});

test("central admission blocks routine work and admits qualifying complex work", () => {
  assert.equal(codexAdmission({ priority: "normal", taskClass: "uptime", codexRequiredReason: "Routine check", requestedBy: "agent" }).admitted, false);
  assert.equal(codexAdmission({ priority: "critical", taskClass: "complex_engineering", codexRequiredReason: "A special engineering capability is required.", requestedBy: "agent" }).admitted, true);
  assert.equal(codexAdmission({ priority: "important", taskClass: "complex_debug", codexRequiredReason: "The compatible lower route failed with evidence.", lowerRouteFailed: true, requestedBy: "agent" }).admitted, true);
  assert.equal(codexAdmission({ priority: "important", taskClass: "complex_debug", codexRequiredReason: "The compatible lower route failed with evidence.", requestedBy: "agent" }).admitted, false);
  assert.equal(codexAdmission({ priority: "low", taskClass: "uptime", requestedBy: "owner", requestedExecutor: "codex" }).admitted, true);
});

test("assignment contract carries class and reason", () => {
  assert.deepEqual(codexAssignmentFromPrompt(prompt), valid);
  assert.equal(codexAssignmentAllowed(prompt, null, "approved"), true);
  assert.equal(codexAssignmentAllowed(prompt, null, "queued"), false);
  const task = { origin: "max", kind: "codex.audit", status: "queued", sideEffecting: false, action: "audit", capability: "read_only", prompt: "[[CODEX_ASSIGNMENT_V1:" + JSON.stringify(valid) + "]]\n[[CODEX_PARENT_V1:parent-1]]\n[[CODEX_INTENT_V1:read_only]]\nAudit.\n\n[Tarea solicitada]\nRead status." };
  assert.equal(codexAssignmentAllowed(task.prompt, null, "queued", task), true);
  assert.equal(codexAssignmentAllowed(task.prompt.replace("parent-1", "parent-2"), null, "queued", task), false);
  assert.equal(codexAssignmentAllowed(task.prompt, null, "awaiting_approval", { ...task, status: "awaiting_approval" }), false);
  assert.equal(codexAssignmentAllowed("ordinary request", null, "approved"), false);
});

test("dedup fingerprint normalizes equivalent parent intent and target", () => {
  const a = { prompt: "[[CODEX_PARENT_V1:p1]]\n[Tarea solicitada]\nRead Service State", kind: "codex.audit" };
  const b = { prompt: "[[CODEX_PARENT_V1:p1]]\n[Tarea solicitada]\n read   service state ", kind: "codex.audit" };
  const c = { ...b, prompt: b.prompt.replace("p1", "p2") };
  assert.equal(codexTaskFingerprint(a), codexTaskFingerprint(b));
  assert.notEqual(codexTaskFingerprint(a), codexTaskFingerprint(c));
});

test("one automatic Codex attempt is allowed per MAX parent, including after a terminal result", () => {
  const first = { id: "a", origin: "max", status: "done", kind: "codex.audit", createdAt: "2026-10-02T10:00:00Z", prompt: "[[CODEX_PARENT_V1:p1]]\n[Tarea solicitada]\nAudit A" };
  const second = { id: "b", origin: "max", status: "queued", kind: "codex.audit", createdAt: "2026-10-02T10:01:00Z", prompt: "[[CODEX_PARENT_V1:p1]]\n[Tarea solicitada]\nAudit B" };
  const unrelated = { ...second, id: "c", prompt: second.prompt.replace("p1", "p2") };
  assert.equal(codexTaskFingerprint(first) === codexTaskFingerprint(second), false);
  assert.equal(codexParentAttemptAllowed(first, [first, second]), true);
  assert.equal(codexParentAttemptAllowed(second, [first, second]), false);
  assert.equal(codexParentAttemptAllowed(unrelated, [first, second, unrelated]), true);
});
