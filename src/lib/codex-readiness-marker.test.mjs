import assert from "node:assert/strict";
import test from "node:test";
import { codexReadinessMarkerPresent, codexReadinessTaskVerified } from "./codex-readiness-marker.mjs";

test("readiness marker requires an exact validation field", () => {
  assert.equal(codexReadinessMarkerPresent("VALIDACION: CODEX_WORKER_READY_OK"), true);
  assert.equal(codexReadinessMarkerPresent("VALIDACION: CODEX_WORKER_READY_OK=NO_CONFIRMADO"), false);
  assert.equal(codexReadinessMarkerPresent("LIMITACIONES: CODEX_WORKER_READY_OK"), false);
  assert.equal(codexReadinessMarkerPresent(""), false);
});

test("Codex availability requires the exact read-only task and a successful real Codex attempt", () => {
  const task = { id: "task-1", kind: "codex.audit", origin: "max", status: "done", sideEffecting: false, action: "audit", capability: "read_only", result: "VALIDACION: CODEX_WORKER_READY_OK" };
  const attempt = { request_id: "task-1", status: "success", provider: "openai", model: "codex" };
  assert.equal(codexReadinessTaskVerified(task, attempt), true);
  assert.equal(codexReadinessTaskVerified({ ...task, result: "VALIDACION: CODEX_WORKER_READY_OK=NO_CONFIRMADO" }, attempt), false);
  assert.equal(codexReadinessTaskVerified({ ...task, sideEffecting: true }, attempt), false);
  assert.equal(codexReadinessTaskVerified(task, { ...attempt, provider: "qwen-local-tailscale", model: "qwen3-8b-local" }), false);
  assert.equal(codexReadinessTaskVerified(task, { ...attempt, status: "failed" }), false);
  assert.equal(codexReadinessTaskVerified(task, { ...attempt, request_id: "other" }), false);
});
