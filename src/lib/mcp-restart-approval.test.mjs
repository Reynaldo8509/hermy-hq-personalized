import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpRestartApproval,
  humanFacingMcpApproval,
  humanFacingMcpApprovalSnapshot,
  MCP_RESTART_APPROVAL_ACTION,
  MCP_RESTART_MAX_BODY_BYTES,
  MCP_RESTART_MAX_REQUESTS_PER_HOUR,
  MCP_RESTART_PRINCIPAL,
  MCP_RESTART_TTL_MS,
  MCP_RESTART_UNIT,
  mcpRestartApprovalMatches,
  mcpRestartApprovalSnapshot,
  publicMcpRestartStatus,
  readBoundedJson,
  validateMcpRestartBody,
} from "./mcp-restart-approval.mjs";

const nonce = "a".repeat(43);
const requestId = "0123456789abcdef0123456789abcdef01234567";

test("request body parser enforces JSON, identity encoding, and a streaming byte limit", async () => {
  const valid = new Request("https://hq.invalid/api/mcp/restart-requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "restart", unit: MCP_RESTART_UNIT }),
  });
  assert.deepEqual(await readBoundedJson(valid), { value: { operation: "restart", unit: MCP_RESTART_UNIT } });

  const wrongType = new Request("https://hq.invalid/api/mcp/restart-requests", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  });
  assert.equal((await readBoundedJson(wrongType)).error, "content_type_must_be_application_json");

  const compressed = new Request("https://hq.invalid/api/mcp/restart-requests", {
    method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "{}",
  });
  assert.equal((await readBoundedJson(compressed)).error, "content_encoding_not_supported");

  const oversized = new Request("https://hq.invalid/api/mcp/restart-requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(MCP_RESTART_MAX_BODY_BYTES) }),
  });
  assert.equal((await readBoundedJson(oversized)).error, "request_body_too_large");
});

test("the request contract permits only the exact restart and unit", () => {
  assert.equal(validateMcpRestartBody({ operation: "restart", unit: MCP_RESTART_UNIT }), true);
  for (const body of [
    null,
    [],
    { operation: "stop", unit: MCP_RESTART_UNIT },
    { operation: "restart", unit: "hermy-hq-vps.service" },
    { operation: "restart", unit: MCP_RESTART_UNIT, nonce },
    { operation: "restart", unit: MCP_RESTART_UNIT, ttl: 86400 },
  ]) assert.equal(validateMcpRestartBody(body), false);
});

function approvalRecord(id, approvalNonce = nonce, now = new Date()) {
  return {
    id,
    request_id: id,
    action: MCP_RESTART_APPROVAL_ACTION,
    status: "pending",
    requested_by: MCP_RESTART_PRINCIPAL,
    approved_by: null,
    created_at: now,
    expires_at: new Date(now.getTime() + MCP_RESTART_TTL_MS),
    parameters_snapshot: mcpRestartApprovalSnapshot({ requestId: id, nonce: approvalNonce }),
  };
}

class MemoryApprovalStore {
  approvals = [];
  audits = [];
  lockCalls = 0;
  async lock() { this.lockCalls += 1; }
  async findPending(unit) {
    return this.approvals.find((entry) => entry.status === "pending" &&
      entry.parameters_snapshot.unit === unit && entry.expires_at > new Date()) || null;
  }
  async countRecent() {
    return this.approvals.filter((entry) => entry.created_at > new Date(Date.now() - 60 * 60 * 1000)).length;
  }
  async createApproval({ requestId: id, snapshot, action, requester }) {
    const now = new Date();
    const row = { id, request_id: id, action, status: "pending", requested_by: requester,
      approved_by: null, created_at: now, expires_at: new Date(now.getTime() + MCP_RESTART_TTL_MS),
      parameters_snapshot: snapshot };
    this.approvals.push(row);
    return row.expires_at;
  }
  async writeAudit({ requestId: id, expiresAt }) { this.audits.push({ requestId: id, state: "PENDING", expiresAt }); }
}

function serialTransaction(store) {
  let chain = Promise.resolve();
  return async (input) => {
    const prior = chain;
    let release;
    chain = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await createMcpRestartApproval({ ...input, store }); }
    finally { release(); }
  };
}

test("request is a standalone ActionApproval, never a dispatcher AgentRequest", async () => {
  const store = new MemoryApprovalStore();
  const result = await createMcpRestartApproval({ store, requestId, nonce });
  assert.equal(result.duplicate, false);
  assert.equal(store.approvals.length, 1);
  assert.equal(store.approvals[0].action, MCP_RESTART_APPROVAL_ACTION);
  assert.equal(store.approvals[0].status, "pending");
  assert.equal(store.approvals[0].id, store.approvals[0].request_id);
  assert.equal(store.approvals[0].parameters_snapshot.unit, MCP_RESTART_UNIT);
  assert.equal(store.audits[0].state, "PENDING");
  assert.equal("createRequest" in store, false);
  assert.equal("requests" in store, false);
});

test("same pending request is returned with its server nonce; no duplicate approval is created", async () => {
  const store = new MemoryApprovalStore();
  const transact = serialTransaction(store);
  const first = await transact({ requestId, nonce });
  const second = await transact({ requestId: "1111111111111111111111111111111111111111", nonce: "b".repeat(43) });
  assert.equal(first.requestId, second.requestId);
  assert.equal(second.duplicate, true);
  assert.equal(second.nonce, nonce);
  assert.equal(store.approvals.length, 1);
  assert.equal(store.audits.length, 1);
});

test("only exact snapshot fields bind the pending approval", async () => {
  const store = new MemoryApprovalStore();
  const record = approvalRecord(requestId);
  assert.equal(mcpRestartApprovalMatches(record, requestId, nonce), true);
  assert.equal(mcpRestartApprovalMatches({ ...record, requested_by: "codex" }, requestId, nonce), false);
  assert.equal(mcpRestartApprovalMatches({ ...record, parameters_snapshot: { ...record.parameters_snapshot, unit: "other.service" } }, requestId, nonce), false);
  assert.equal(mcpRestartApprovalMatches({ ...record, parameters_snapshot: { ...record.parameters_snapshot, nonce: "b".repeat(43) } }, requestId, nonce), false);
  assert.equal((await createMcpRestartApproval({ store, requestId, nonce })).duplicate, false);
});

test("creation is serialized, deduplicated, and rate limited", async () => {
  const store = new MemoryApprovalStore();
  const transact = serialTransaction(store);
  const inputs = [
    { requestId: "1".repeat(40), nonce: "a".repeat(43) },
    { requestId: "2".repeat(40), nonce: "b".repeat(43) },
    { requestId: "3".repeat(40), nonce: "c".repeat(43) },
  ];
  const created = await Promise.all(inputs.map((input) => transact(input)));
  assert.equal(created.filter((item) => item.duplicate).length, 2);
  assert.equal(store.approvals.length, 1);
  assert.equal(MCP_RESTART_MAX_REQUESTS_PER_HOUR, 3);
  for (let index = 0; index < 2; index += 1) {
    store.approvals[store.approvals.length - 1].status = "expired";
    const item = inputs[index + 1];
    const result = await transact({ requestId: `${index + 4}`.repeat(40), nonce: String.fromCharCode(100 + index).repeat(43) });
    assert.notEqual(result.rateLimited, true);
  }
  store.approvals[store.approvals.length - 1].status = "expired";
  const rateLimited = await transact({ requestId: "7".repeat(40), nonce: "e".repeat(43) });
  assert.equal(rateLimited.rateLimited, true);
});

test("approval status exposes no nonce and requires a human actor for APPROVED", () => {
  const now = new Date("2026-11-22T20:00:00.000Z");
  const row = approvalRecord(requestId, nonce, now);
  const pending = publicMcpRestartStatus(row, new Date(now.getTime() + 1000));
  assert.equal(pending.status, "PENDING");
  assert.equal("nonce" in pending, false);
  const approvedByService = publicMcpRestartStatus({ ...row, status: "approved", approved_by: MCP_RESTART_PRINCIPAL }, now);
  assert.equal(approvedByService.status, "EXPIRED");
  const approvedByHuman = publicMcpRestartStatus({ ...row, status: "approved", approved_by: "human-operator" }, now);
  assert.equal(approvedByHuman.status, "APPROVED");
  const expired = publicMcpRestartStatus(row, new Date(now.getTime() + MCP_RESTART_TTL_MS + 1));
  assert.equal(expired.status, "EXPIRED");
});

test("human-facing snapshot redacts retry nonce but preserves the exact operation", () => {
  const snapshot = mcpRestartApprovalSnapshot({ requestId, nonce });
  const visible = humanFacingMcpApprovalSnapshot(snapshot);
  assert.equal("nonce" in visible, false);
  assert.equal(visible.nonceSha256, snapshot.nonceSha256);
  assert.equal(visible.unit, MCP_RESTART_UNIT);
  assert.equal(visible.operation, "restart");
});

test("human approval rows redact the nonce and use the standalone request title", () => {
  const snapshot = mcpRestartApprovalSnapshot({ requestId, nonce });
  const visible = humanFacingMcpApproval({ id: requestId, title: null, parameters_snapshot: snapshot });
  assert.equal(visible.title, snapshot.title);
  assert.equal("nonce" in visible.parameters_snapshot, false);
  assert.equal(visible.parameters_snapshot.unit, MCP_RESTART_UNIT);
  const unrelated = { parameters_snapshot: { note: "existing approval" } };
  assert.equal(humanFacingMcpApproval(unrelated).parameters_snapshot.note, "existing approval");
});

test("invalid IDs, short nonces, and malformed expiry are rejected", () => {
  assert.throws(() => mcpRestartApprovalSnapshot({ requestId: "../approval", nonce }));
  assert.throws(() => mcpRestartApprovalSnapshot({ requestId, nonce: "bad" }));
  const invalid = approvalRecord(requestId);
  invalid.parameters_snapshot = { ...invalid.parameters_snapshot, nonceSha256: "0".repeat(64) };
  assert.equal(publicMcpRestartStatus(invalid), null);
});
