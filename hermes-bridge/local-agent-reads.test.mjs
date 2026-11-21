import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedDeterministicAgentRead } from "./local-agent-reads.mjs";
import { classifyMiloSubject } from "./milo-subject-triage.mjs";
import { routeFailureForRequest } from "./scheduled-audit-routing.mjs";

const unavailable = { tier: "local_model_unavailable" };

test("Aegis passive audit, Ledger audit, and Milo triage are bounded local read paths", () => {
  for (const request of [
    { kind: "aegis.security", action: "audit", capability: "read_only", sideEffecting: false, origin: "web" },
    { kind: "ledger.operations", action: "audit", capability: "read_only", sideEffecting: false, origin: "max" },
    { kind: "milo.email", action: "triage", capability: "read_only", sideEffecting: false, origin: "web" },
  ]) {
    assert.equal(isAuthorizedDeterministicAgentRead(request), true);
    assert.equal(routeFailureForRequest(request, unavailable), null);
  }
});

test("deterministic reads reject forged origin, write capability, side effects, and attachments", () => {
  const base = { kind: "milo.email", action: "triage", capability: "read_only", sideEffecting: false, origin: "web" };
  for (const change of [
    { origin: "workflow" }, { capability: "privileged" }, { sideEffecting: true },
    { attachments: [{ name: "private" }] }, { action: "send" },
  ]) assert.equal(isAuthorizedDeterministicAgentRead({ ...base, ...change }), false);
  assert.equal(routeFailureForRequest({ ...base, sideEffecting: true }, unavailable), "LOCAL_MODEL_UNAVAILABLE");
});

test("Milo classifies only synthetic subject strings locally without mailbox access", () => {
  assert.equal(classifyMiloSubject("Invitación a entrevista"), "high");
  assert.equal(classifyMiloSubject("Vacante de empleo"), "medium");
  assert.equal(classifyMiloSubject("Boletín semanal"), "low");
  assert.equal(classifyMiloSubject(""), "low");
});
