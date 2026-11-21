import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentRegistryView, buildLogicalAgentRuntimeContract } from "./agent-registry.mjs";
import { agentForKind } from "./phase2-domain.mjs";

test("Hermes registry includes logical agents while identifying worker runtime separately", () => {
  const roster = [
    { id: "max", name: "Max", role: "orchestrator", prompt: "never expose" },
    { id: "codex", name: "Codex", role: "engineering" },
    { id: "milo", name: "Milo", role: "scheduled" },
    { id: "atlas", name: "Atlas", role: "research" },
  ];
  const rows = buildAgentRegistryView(roster, [
    { id: "codex", status: "idle", lastActive: new Date("2026-09-30T00:00:00Z"), currentTask: "private" },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["max", "codex", "milo", "atlas"]);
  assert.equal(rows[0].runtime_kind, "logical_orchestrator");
  assert.equal(rows[1].runtime_kind, "dedicated_worker");
  assert.equal(rows[1].worker_unit, "codex-hermy-vps.service");
  assert.equal(rows[2].runtime_kind, "scheduled_worker");
  assert.equal(rows[3].runtime_kind, "shared_hermes_runtime");
  assert.equal(rows[1].status, "idle");
  assert.equal(rows[0].status, "unknown");
  assert.equal(rows[1].lastActive, "2026-09-30T00:00:00.000Z");
  assert.equal(rows[0].can_delegate, true);
  assert.equal(rows[1].can_delegate, false);
  assert.equal(rows[1].provider_policy, "openai-codex-worker");
  assert.equal(rows[1].approval_policy, "human approval required for sensitive side effects");
  assert.equal(rows[0].last_seen, rows[0].lastActive);
  assert.equal(JSON.stringify(rows).includes("private"), false);
  assert.equal(JSON.stringify(rows).includes("never expose"), false);
});

test("registry derives explicit primary, fallback, capability and cost policy centrally", () => {
  const [agent] = buildAgentRegistryView([{ id: "max", name: "Max", role: "orchestrator" }], []);
  assert.equal(agent.provider_policy, "custom:tokenharbor");
  assert.equal(agent.model_policy, "deepseek-v4.1-flash:free");
  assert.equal(agent.fallback_policy, "openrouter/cohere/north-mini-code:free");
  assert.deepEqual(agent.required_capabilities, ["reasoning", "structured", "delegation"]);
  assert.equal(agent.free_only, true);
  assert.match(agent.policy_validation, /actual route proven per inference attempt/);
});

test("the Action Center roster exposes exactly eight unique agents and runtime kinds", () => {
  const roster = [
    ["max", "Max", "orchestrator"], ["codex", "Codex", "worker"], ["atlas", "Atlas", "research"],
    ["aegis", "Aegis", "security"], ["milo", "Milo", "scheduled"], ["pulse", "Pulse", "social"],
    ["ledger", "Ledger", "operations"], ["domus", "Domus", "home"],
  ].map(([id, name, role]) => ({ id, name, role }));
  const rows = buildAgentRegistryView(roster, []);
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((row) => row.id)).size, 8);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.runtime_kind])), {
    max: "logical_orchestrator",
    codex: "dedicated_worker",
    atlas: "shared_hermes_runtime",
    aegis: "shared_hermes_runtime",
    milo: "scheduled_worker",
    pulse: "shared_hermes_runtime",
    ledger: "shared_hermes_runtime",
    domus: "shared_hermes_runtime",
  });
});

test("MAX keeps failed last execution separate from a healthy shared route", () => {
  const max = buildLogicalAgentRuntimeContract({
    recordedStatus: "error",
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: true,
    lastSeen: "2026-10-02T20:17:00.499Z",
    runtimeHeartbeatAt: "2026-10-02T22:18:38.176Z",
    lastExecution: {
      id: "cmurebknk0005ao1bc6yamzwq",
      status: "failed",
      startedAt: "2026-10-02T20:08:41.615Z",
      finishedAt: "2026-10-02T20:17:00.496Z",
    },
  });

  assert.equal(max.status, "idle");
  assert.equal(max.recorded_status, "error");
  assert.equal(max.route_available, true);
  assert.equal(max.runtime_status, "idle");
  assert.equal(max.last_execution_status, "failed");
  assert.equal(max.last_execution_id, "cmurebknk0005ao1bc6yamzwq");
  assert.equal(max.last_execution_at, "2026-10-02T20:17:00.496Z");
  assert.equal(max.last_seen, "2026-10-02T20:17:00.499Z");
  assert.equal(max.last_seen_source, "AgentState.lastActive");
  assert.equal(max.runtime_heartbeat_at, "2026-10-02T22:18:38.176Z");
  assert.equal(max.provider_route_health, "unknown");
});

test("MAX route is unavailable even when the last execution succeeded", () => {
  const max = buildLogicalAgentRuntimeContract({
    recordedStatus: "done",
    sharedRuntimeHeartbeatFresh: false,
    routeConfigured: true,
    lastExecution: { id: "max-done", status: "done", finishedAt: "2026-10-02T20:00:00Z" },
  });

  assert.equal(max.status, "idle");
  assert.equal(max.route_available, false);
  assert.equal(max.runtime_status, "unavailable");
  assert.equal(max.last_execution_status, "done");
});

test("MAX with no recorded execution can still expose a healthy shared route", () => {
  const max = buildLogicalAgentRuntimeContract({
    recordedStatus: "unknown",
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: true,
  });

  assert.equal(max.route_available, true);
  assert.equal(max.runtime_status, "idle");
  assert.equal(max.last_execution_status, "none");
  assert.equal(max.last_execution_at, null);
});

test("changing MAX last execution result does not change runtime or route health", () => {
  const base = {
    recordedStatus: "error",
    sharedRuntimeHeartbeatFresh: true,
    routeConfigured: true,
  };
  const failed = buildLogicalAgentRuntimeContract({ ...base, lastExecution: { status: "failed" } });
  const done = buildLogicalAgentRuntimeContract({ ...base, lastExecution: { status: "done" } });

  assert.equal(failed.route_available, done.route_available);
  assert.equal(failed.runtime_status, done.runtime_status);
  assert.equal(failed.status, done.status);
  assert.notEqual(failed.last_execution_status, done.last_execution_status);
});

test("MAX task classification stays distinct from Codex delegated work", () => {
  assert.equal(agentForKind("max.chief-of-staff", "max"), "max");
  assert.equal(agentForKind("max.chief-of-staff", "web"), "max");
  assert.equal(agentForKind("codex.audit", "max"), "codex");
});
