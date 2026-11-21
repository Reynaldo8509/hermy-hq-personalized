import test from "node:test";
import assert from "node:assert/strict";
import { approvalMatches, approvalParameters, sameRequestPayload } from "./phase2-domain.mjs";

test("legacy approval snapshots retain their v1 shape and remain matchable", () => {
  const request = { id: "legacy-1", origin: "web", kind: "oneshot", title: "legacy", prompt: "read",
    sideEffecting: true, action: "execute", capability: "read_only", dependsOn: [], contractVersion: 1,
    executionMode: "read_only", scope: { id: "new-field" }, requestedBy: "max" };
  const snapshot = { requestId: "legacy-1", origin: "web", kind: "oneshot", title: "legacy", prompt: "read",
    sideEffecting: true, action: "execute", capability: "read_only", dependencies: [] };
  assert.deepEqual(approvalParameters(request), snapshot);
  assert.equal(approvalMatches({ parameters_snapshot: snapshot }, request), true);
});

test("v2 approval fingerprint binds structured scope and server provenance", () => {
  const request = { id: "new-1", origin: "web", kind: "aegis.security", title: "passive", prompt: "read",
    sideEffecting: true, action: "audit", capability: "read_only", dependsOn: ["b", "a"], contractVersion: 2,
    executionMode: "read_only", scope: { id: "vps.passive-security.v1", resourceIds: ["vps:oracle-production"], effects: { externalIO: false } },
    privacyClass: "LOCAL_ONLY", requestedBy: "max", authSource: "hermy_hq_internal_secret",
    riskReasons: ["agent_requires_approval", "client_requested_approval", "effective_action_side_effecting"] };
  const snapshot = approvalParameters(request);
  assert.equal(approvalMatches({ parameters_snapshot: snapshot }, request), true);
  assert.equal(approvalMatches({ parameters_snapshot: snapshot }, { ...request, scope: { ...request.scope, resourceIds: ["*"] } }), false);
  assert.equal(approvalMatches({ parameters_snapshot: { ...snapshot, contractVersion: 1 } }, request), false);
});

test("idempotency payload compares structured authority fields", () => {
  const base = { id: "r", origin: "web", kind: "aegis.security", title: "t", prompt: "p", sideEffecting: true,
    action: "audit", capability: "read_only", dependsOn: [], contractVersion: 2, executionMode: "read_only",
    scope: { id: "vps.passive-security.v1", resourceIds: ["vps:oracle-production"], effects: { externalIO: false } },
    privacyClass: "LOCAL_ONLY", requestedBy: "max", authSource: "hermy_hq_internal_secret",
    riskReasons: ["agent_requires_approval", "client_requested_approval", "effective_action_side_effecting"] };
  assert.equal(sameRequestPayload(base, base), true);
  assert.equal(sameRequestPayload(base, { ...base, authSource: "client_payload" }), false);
  assert.equal(sameRequestPayload(base, { ...base, scope: { ...base.scope, resourceIds: ["*"] } }), false);
});
