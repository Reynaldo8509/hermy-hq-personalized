import test from "node:test";
import assert from "node:assert/strict";
import { classifyDispatchRisk, commandRequiresApproval, dispatchConfirmation, dispatchPresentation, effectiveSideEffecting, normalizeOperationalSnapshot, readingFreshness, summarizeRequestCounts } from "./command-center-domain.mjs";

const now = Date.parse("2026-09-28T12:00:00.000Z");

test("Hermes is only called online when its heartbeat is recent", () => {
  const recent = normalizeOperationalSnapshot({ health: { online: true, lastSeen: new Date(now - 60_000).toISOString() }, now });
  const stale = normalizeOperationalSnapshot({ health: { online: true, lastSeen: new Date(now - 6 * 60_000).toISOString() }, now });
  const down = normalizeOperationalSnapshot({ health: { online: false, lastSeen: new Date(now - 60_000).toISOString() }, now });
  assert.equal(recent.hermes.status, "online");
  assert.equal(stale.hermes.status, "stale");
  assert.equal(down.hermes.status, "offline");
});

test("service failures and Qwen state are not presented as current when the snapshot is stale", () => {
  const snapshot = normalizeOperationalSnapshot({
    infrastructure: {
      collectedAt: new Date(now - 46 * 60_000).toISOString(),
      nodes: {
        vps: { services: [{ unit: "hermes.service", state: "failed" }] },
        "dell-g15": { qwen: { status: "online", checkedAt: new Date(now - 46 * 60_000).toISOString(), latencyMs: 12, modelIds: ["qwen-local"] } },
      },
    }, now,
  });
  assert.equal(snapshot.infrastructure.failingServices, null);
  assert.equal(snapshot.infrastructure.qwen.status, "stale");
  assert.deepEqual(snapshot.infrastructure.qwen.modelIds, ["qwen-local"]);
});

test("missing and future timestamps stay unknown instead of inventing availability", () => {
  assert.equal(readingFreshness(null, now), "unknown");
  assert.equal(readingFreshness(new Date(now + 5 * 60_000).toISOString(), now), "unknown");
  const snapshot = normalizeOperationalSnapshot({ health: { online: true }, infrastructure: {}, now });
  assert.equal(snapshot.hermes.status, "unknown");
  assert.equal(snapshot.infrastructure.failingServices, null);
  assert.equal(snapshot.infrastructure.qwen.status, "unknown");
  const emptyFresh = normalizeOperationalSnapshot({ infrastructure: { collectedAt: new Date(now).toISOString(), nodes: { vps: { services: [] }, "dell-g15": { qwen: { status: "online", checkedAt: new Date(now).toISOString(), latencyMs: null } } } }, now });
  assert.equal(emptyFresh.infrastructure.failingServices, null);
  assert.equal(emptyFresh.infrastructure.qwen.latencyMs, null);
});

test("request status summaries preserve actual counts only", () => {
  assert.deepEqual(summarizeRequestCounts([{ status: "running", count: 2 }, { status: "done", count: 4 }]), { running: 2, done: 4 });
});

test("dispatch only confirms a real successful response and routes privileged work to approval", () => {
  assert.deepEqual(dispatchConfirmation(201, { request: { id: "req-1", status: "queued" }, duplicate: false }), { request: { id: "req-1", status: "queued" }, duplicate: false });
  assert.deepEqual(dispatchConfirmation(200, { request: { id: "req-1", status: "awaiting_approval" }, duplicate: true }).request, { id: "req-1", status: "awaiting_approval" });
  assert.throws(() => dispatchConfirmation(403, { error: "No autorizado" }), /No autorizado/);
  assert.throws(() => dispatchConfirmation(201, { request: { id: "req-2" } }), /no confirmó/);
});

test("English and Spanish external actions are routed through individual approval", () => {
  assert.equal(commandRequiresApproval("send this email"), true);
  assert.equal(commandRequiresApproval("eliminar el archivo remoto"), true);
  assert.equal(commandRequiresApproval("reinicia el servicio y confirma su estado"), true);
  assert.equal(commandRequiresApproval("run systemctl restart hermes.service"), true);
  assert.equal(commandRequiresApproval("summarize these notes"), false);
  assert.equal(effectiveSideEffecting(false, "restart the Hermes service"), true);
  assert.equal(effectiveSideEffecting(false, "summarize these notes"), false);
  assert.equal(effectiveSideEffecting(true, "summarize these notes"), true);
});

test("dispatch presentation keeps approval, execution, completion, and validation distinct", () => {
  assert.equal(dispatchPresentation({ status: "awaiting_approval" }).state, "approval");
  assert.equal(dispatchPresentation({ status: "running" }).state, "running");
  assert.match(dispatchPresentation({ status: "done" }).message, /valida el resultado/);
  assert.equal(dispatchPresentation({ status: "failed" }).state, "failed");
});

test("dispatch presentation keeps approval, execution, completion, and validation distinct", () => {
  assert.equal(dispatchPresentation({ status: "awaiting_approval" }).state, "approval");
  assert.equal(dispatchPresentation({ status: "running" }).state, "running");
  assert.match(dispatchPresentation({ status: "done" }).message, /valida el resultado/);
  assert.equal(dispatchPresentation({ status: "failed" }).state, "failed");
});


test("server-side dispatch classification requires known structured read-only operations", () => {
  const safe = classifyDispatchRisk({ kind: "atlas.research", action: "research", capability: "read_only", clientFlag: false, prompt: "Compare official release notes" });
  assert.equal(safe.requiresApproval, false);
  assert.equal(safe.action, "research");
  assert.equal(classifyDispatchRisk({ kind: "atlas.research", action: "research", capability: "read_only", clientFlag: false, prompt: "publish a report" }).requiresApproval, true);
  assert.equal(classifyDispatchRisk({ kind: "atlas.research", action: "research", capability: "admin", clientFlag: false, prompt: "Compare releases" }).requiresApproval, true);
  assert.equal(classifyDispatchRisk({ kind: "unregistered.agent", action: "review", capability: "read_only", clientFlag: false, prompt: "Summarize" }).requiresApproval, true);
  assert.equal(classifyDispatchRisk({ kind: "atlas.research", action: "research", capability: "read_only", clientFlag: true, prompt: "Compare releases" }).requiresApproval, true);
});
