import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLEXITY_CLASSES, createRouterE2EPermit, MIMO26_ROUTE, OPENCODE_ZEN_FREE_ROUTE,
  GROQ_FREE_ROUTE, OPENROUTER_FREE_ROUTE, PRIVACY_CLASSES,
} from "./privacy-model-router.mjs";
import { consumeRouterE2EPermit, persistIssuedRouterE2EPermit } from "./router-permit-store.mjs";

const now = 1_000_000;
const request = {
  id: "phase211-store-test", kind: "max.chief-of-staff", title: "Synthetic architecture",
  prompt: "Design a fictional multi-step architecture", origin: "test",
  sideEffecting: false, action: "coordinate", capability: "read_only",
};
const payload = "Design a fictional multi-step architecture";
const readiness = {
  provider: MIMO26_ROUTE.provider, requested_model: MIMO26_ROUTE.model, status: "catalog_verified_free",
  modelAvailable: true, freePrice: true, verified_free: true,
  catalogVerified: true, catalogSource: "authenticated_model_catalog",
  transportOk: true, syntheticInferenceOk: true, structuredJsonOk: true,
  finishReasonVerified: true, toolCompatibility: "not_required_safe_mode",
  checkedAt: now - 1000, validUntil: now + 100_000,
};
const makePermit = (overrides = {}) => createRouterE2EPermit({
  request, effectivePayload: payload,
  privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
  complexityClass: COMPLEXITY_CLASSES.COMPLEX,
  readiness, safeMode: true, privacyToolFree: true, toolCount: 0,
  memory: false, skills: false, mcp: false, history: "none",
  privacyFinalGateAllowed: true, routeTier: "mimo26_e2e_once", now,
  ...overrides,
});

function makeStoreQuery() {
  const rows = new Map();
  const query = async (sql, values) => {
    const key = values[0];
    if (sql.startsWith('INSERT INTO "DataStore"')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, JSON.parse(values[1]));
      return { rowCount: 1, rows: [{ key }] };
    }
    if (sql.startsWith('UPDATE "DataStore"')) {
      const row = rows.get(key);
      if (!row) return { rowCount: 0, rows: [] };
      const expected = [
        row.source === values[11],
        row.permitId === values[2],
        row.requestFingerprint === values[3],
        row.payloadHash === values[4],
        row.provider === values[5],
        row.requestedModel === values[6],
        row.effectiveModel === values[7],
        row.privacyClass === values[8],
        row.policyVersion === values[9],
        row.routeTier === values[12],
        row.nonce === values[13],
        String(row.issuedAt) === values[14],
        String(row.expiresAt) === values[15],
        row.requestId === values[16],
        (row.qwenAvailable == null ? null : String(row.qwenAvailable)) === values[17],
        row.status === "ISSUED",
        row.consumedAt == null,
        Number(row.expiresAt) > Number(values[10]),
      ];
      if (!expected.every(Boolean)) return { rowCount: 0, rows: [] };
      rows.set(key, { ...row, status: "CONSUMED", consumedAt: values[1] });
      return { rowCount: 1, rows: [{ key }] };
    }
    throw new Error("unexpected store query");
  };
  return { query, rows };
}

test("router permit persistence stores only bound metadata and consumes once", async () => {
  const permit = makePermit();
  assert.ok(permit);
  const { query, rows } = makeStoreQuery();
  const key = await persistIssuedRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now);
  const stored = rows.get(key);
  assert.equal(stored.status, "ISSUED");
  assert.equal(stored.payloadHash, permit.payloadHash);
  assert.equal(JSON.stringify(stored).includes(payload), false);
  assert.equal(Object.hasOwn(stored, "prompt"), false);
  assert.equal(await consumeRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 1), true);
  assert.equal(rows.get(key).status, "CONSUMED");
  assert.equal(await consumeRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 2), false);
});

test("remote primary permits are valid and bind Qwen availability", async () => {
  const permit = makePermit({ routeTier: "mimo26_primary", qwenAvailable: false });
  assert.ok(permit);
  assert.equal(permit.qwenAvailable, false);
  const { query, rows } = makeStoreQuery();
  const key = await persistIssuedRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now);
  rows.set(key, { ...rows.get(key), qwenAvailable: true });
  assert.equal(await consumeRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 1), false);
});

test("permit store rejects payload and request TOCTOU changes and expired permits", async () => {
  const permit = makePermit();
  const { query, rows } = makeStoreQuery();
  await persistIssuedRouterE2EPermit(query, request, permit, { effectivePayload: payload }, now);
  assert.equal(await consumeRouterE2EPermit(query, request, permit, {
    effectivePayload: payload + " changed", provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 1), false);
  assert.equal(await consumeRouterE2EPermit(query, { ...request, id: "other" }, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 1), false);
  assert.equal(await consumeRouterE2EPermit(query, request, permit, {
    effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
  }, now + 60_001), false);
  assert.equal(rows.get(`routing-e2e-authorization:${request.id}:${permit.permitId}`).status, "ISSUED");
});

test("persisted permit must match the issued nonce, times, and request id", async () => {
  for (const field of ["nonce", "issuedAt", "expiresAt", "requestId"]) {
    const permit = makePermit();
    const { query, rows } = makeStoreQuery();
    const key = await persistIssuedRouterE2EPermit(query, request, permit, { effectivePayload: payload }, now);
    rows.set(key, { ...rows.get(key), [field]: field === "nonce" ? "different-nonce-value"
      : field === "requestId" ? "different-request" : Number(permit[field]) + 1 });
    assert.equal(await consumeRouterE2EPermit(query, request, permit, {
      effectivePayload: payload, provider: MIMO26_ROUTE.provider,
      model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model,
    }, now + 1), false, field);
    assert.notEqual(rows.get(key).status, "CONSUMED", field);
  }
});

test("a permit cannot be issued twice for the same request and permit ID", async () => {
  const permit = makePermit();
  const { query } = makeStoreQuery();
  await persistIssuedRouterE2EPermit(query, request, permit, { effectivePayload: payload }, now);
  await assert.rejects(
    persistIssuedRouterE2EPermit(query, request, permit, { effectivePayload: payload }, now),
    /router_e2e_permit_already_issued/,
  );
});

test("quarantined OpenCode cannot receive a request-scoped permit", () => {
  const denied = makePermit({
    provider: OPENCODE_ZEN_FREE_ROUTE.provider,
    requestedModel: OPENCODE_ZEN_FREE_ROUTE.model,
    effectiveModel: OPENCODE_ZEN_FREE_ROUTE.model,
    readiness: { ...readiness, provider: OPENCODE_ZEN_FREE_ROUTE.provider,
      requested_model: OPENCODE_ZEN_FREE_ROUTE.model },
    routeTier: "remote_free_failover",
  });
  assert.equal(denied, null);
});

test("one request can issue distinct single-use permits for a verified-free failover provider", async () => {
  const { query, rows } = makeStoreQuery();
  const primary = makePermit();
  const openRouterReadiness = { ...readiness, provider: OPENROUTER_FREE_ROUTE.provider,
    requested_model: OPENROUTER_FREE_ROUTE.model };
  const backup = makePermit({
    provider: OPENROUTER_FREE_ROUTE.provider,
    requestedModel: OPENROUTER_FREE_ROUTE.model,
    effectiveModel: OPENROUTER_FREE_ROUTE.model,
    readiness: openRouterReadiness,
    routeTier: "remote_free_failover",
  });
  const primaryBinding = { effectivePayload: payload, provider: MIMO26_ROUTE.provider,
    model: MIMO26_ROUTE.model, effectiveModel: MIMO26_ROUTE.model };
  const backupBinding = { effectivePayload: payload, provider: OPENROUTER_FREE_ROUTE.provider,
    model: OPENROUTER_FREE_ROUTE.model, effectiveModel: OPENROUTER_FREE_ROUTE.model };
  const primaryKey = await persistIssuedRouterE2EPermit(query, request, primary, primaryBinding, now);
  const backupKey = await persistIssuedRouterE2EPermit(query, request, backup, backupBinding, now);
  assert.notEqual(primaryKey, backupKey);
  assert.equal(rows.size, 2);
  assert.equal(await consumeRouterE2EPermit(query, request, primary, primaryBinding, now + 1), true);
  assert.equal(await consumeRouterE2EPermit(query, request, backup, backupBinding, now + 2), true);
  assert.equal(rows.get(primaryKey).status, "CONSUMED");
  assert.equal(rows.get(backupKey).status, "CONSUMED");
  assert.equal(await consumeRouterE2EPermit(query, request, backup, backupBinding, now + 3), false);
});


test("Groq cannot receive a request-scoped permit even when its account evidence claims Free", async () => {
  const groqReadiness = { ...readiness, provider: GROQ_FREE_ROUTE.provider,
    requested_model: GROQ_FREE_ROUTE.model, accountTier: "FREE",
    freeEvidenceSource: "operator_verified_console_free_plan_2026-10-06+authenticated_catalog+official_free_plan_limits" };
  const groqPermit = createRouterE2EPermit({
    request, effectivePayload: payload, provider: GROQ_FREE_ROUTE.provider,
    requestedProvider: GROQ_FREE_ROUTE.provider, requestedModel: GROQ_FREE_ROUTE.model,
    effectiveModel: GROQ_FREE_ROUTE.model, privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED,
    complexityClass: COMPLEXITY_CLASSES.COMPLEX, readiness: groqReadiness,
    safeMode: true, privacyToolFree: true, toolCount: 0, memory: false,
    skills: false, mcp: false, history: "none", privacyFinalGateAllowed: true,
    routeTier: "remote_free_failover", now,
  });
  assert.equal(groqPermit, null);
});
