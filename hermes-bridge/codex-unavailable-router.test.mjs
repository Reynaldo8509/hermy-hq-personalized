import assert from "node:assert/strict";
import test from "node:test";
import { codexUnavailableRoute } from "./codex-unavailable-router.mjs";

test("dedicated Codex capacity failures never fall back to another agent or local Qwen", () => {
  for (const taskClass of ["analysis_only", "code_generation", "structured_tools", "restricted_execution", "privileged_execution"]) {
    const result = codexUnavailableRoute({ taskClass, capacity: "exhausted", workerHealthy: true });
    assert.equal(result.fallback_executor, null);
    assert.equal(result.fallback_model, null);
    assert.equal(result.execution_deferred, true);
  }
});

test("code generation remains proposal-only and privileged work remains deferred", () => {
  const proposal = codexUnavailableRoute({ taskClass: "code_generation", capacity: "unknown", workerHealthy: false });
  assert.match(proposal.fallback_scope, /proposal_only_no_execution/);
  assert.equal(proposal.fallback_executor, null);
  const privileged = codexUnavailableRoute({ taskClass: "privileged_execution", capacity: "available", workerHealthy: true });
  assert.equal(privileged.execution_deferred, true);
  assert.equal(privileged.fallback_executor, null);
});

test("capacity and worker health remain separate without automatic substitute execution", () => {
  const result = codexUnavailableRoute({ taskClass: "analysis_only", capacity: "unknown", workerHealthy: true });
  assert.equal(result.reason, "provider_capacity_unknown");
  assert.equal(result.worker_healthy, true);
  assert.equal(result.fallback_executor, null);
  const owner = codexUnavailableRoute({ taskClass: "analysis_only", capacity: "unknown", workerHealthy: true, requestedBy: "owner" });
  assert.equal(owner.status, "NEEDS_OWNER_OVERRIDE");
  assert.equal(owner.fallback_executor, null);
});
