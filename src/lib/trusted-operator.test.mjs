import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalOperatorMessage,
  loadTrustedOperatorIdentity,
  operatorFingerprint,
  operatorTaskStatusTransition,
  isTrustedOperatorPath,
  validateOperatorTask,
  verifyOperatorSignature,
  TRUSTED_CODEX_OPERATOR_ID,
} from "./trusted-operator.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const identity = {
  operatorId: TRUSTED_CODEX_OPERATOR_ID, enabled: true, publicKeyPem,
  fingerprintSha256: operatorFingerprint(publicKeyPem), scopes: ["workspace.inspect"],
};

function signedRequest(overrides = {}) {
  const values = {
    operatorId: TRUSTED_CODEX_OPERATOR_ID,
    method: "POST",
    pathAndQuery: "/api/hermes/operator/requests",
    timestamp: String(Date.now()),
    nonce: randomBytes(24).toString("base64url"),
    rawBody: JSON.stringify({ idempotencyKey: "synthetic-review-key", operation: "workspace.inspect" }),
    ...overrides,
  };
  const signature = sign(null, canonicalOperatorMessage(values), privateKey).toString("base64url");
  return {
    values,
    headers: {
      "x-hermy-operator-id": values.operatorId,
      "x-hermy-operator-timestamp": values.timestamp,
      "x-hermy-operator-nonce": values.nonce,
      "x-hermy-operator-signature": signature,
    },
  };
}

test("verifies Ed25519 signatures bound to method, path, timestamp, nonce, and body", () => {
  const { values, headers } = signedRequest();
  assert.equal(verifyOperatorSignature({ ...values, headers, identity }).ok, true);
  assert.equal(verifyOperatorSignature({ ...values, headers, identity, rawBody: values.rawBody + " " }).ok, false);
  assert.equal(verifyOperatorSignature({ ...values, headers, identity, pathAndQuery: "/other" }).ok, false);
  assert.equal(verifyOperatorSignature({ ...values, headers: { ...headers, "x-hermy-operator-timestamp": String(Date.now() - 600_000) }, identity }).reason,
    "operator_signature_stale");
});

test("loads only a well-formed, non-writable trusted identity registry and rejects symlinks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermy-operator-review-"));
  try {
    const file = path.join(directory, "registry.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, identities: { [identity.operatorId]: identity } }), { mode: 0o600 });
    assert.equal(loadTrustedOperatorIdentity({ registryFile: file, requireRootOwner: false })?.operatorId, identity.operatorId);
    const link = path.join(directory, "registry-link.json");
    fs.symlinkSync(file, link);
    assert.equal(loadTrustedOperatorIdentity({ registryFile: link, requireRootOwner: false }), null);
    fs.chmodSync(file, 0o666);
    assert.equal(loadTrustedOperatorIdentity({ registryFile: file, requireRootOwner: false }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("requires explicitly scoped operation and resource identity", () => {
  const valid = {
    idempotencyKey: "synthetic-review-key", operation: "workspace.inspect", title: "Synthetic audit",
    prompt: "Read-only synthetic test", resourceId: "codex-trusted-operator:workspace",
  };
  assert.equal(validateOperatorTask(valid, { operatorScopes: ["workspace.inspect"] }).ok, true);
  assert.equal(validateOperatorTask(valid, { operatorScopes: [] }).reason, "operator_scope_not_granted");
  assert.equal(validateOperatorTask({ ...valid, resourceId: "other" }, { operatorScopes: ["workspace.inspect"] }).reason,
    "operator_resource_scope_mismatch");
  assert.equal(validateOperatorTask({ ...valid, unexpected: true }, { operatorScopes: ["workspace.inspect"] }).reason,
    "request_fields_unknown");
  assert.equal(validateOperatorTask({ ...valid, operation: "service.restart", service: "unlisted.service", resourceId: "codex-trusted-operator:hermy-platform" },
    { operatorScopes: ["service.restart"] }).reason, "service_not_allowlisted");
});

test("enforces one-way operator task state transitions", () => {
  assert.deepEqual(operatorTaskStatusTransition("approved", "claim"), { ok: true, status: "running" });
  assert.deepEqual(operatorTaskStatusTransition("done", "claim"), { ok: false, reason: "operator_task_transition_replay_or_conflict" });
  assert.deepEqual(operatorTaskStatusTransition("approved", "complete"), { ok: false, reason: "operator_task_transition_replay_or_conflict" });
});

test("allows only exact operator API paths and methods to bypass interactive proxy auth", () => {
  assert.equal(isTrustedOperatorPath("POST", "/api/hermes/operator/requests"), true);
  assert.equal(isTrustedOperatorPath("GET", "/api/hermes/operator/requests"), true);
  assert.equal(isTrustedOperatorPath("PATCH", "/api/hermes/operator/requests/request_123456"), true);
  assert.equal(isTrustedOperatorPath("DELETE", "/api/hermes/operator/requests/request_123456"), false);
  assert.equal(isTrustedOperatorPath("GET", "/api/hermes/operator/requests/request_123456"), false);
  assert.equal(isTrustedOperatorPath("POST", "/api/hermes/operator/requests/../../settings"), false);
});
