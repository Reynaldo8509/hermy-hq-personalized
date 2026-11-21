import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMaxExcelntTextOnlyTask, maxExcelntPublicFailure, parseMaxExcelntSelection,
  runMaxExcelntTextOnly, MAX_EXCELNT_HTTP_TIMEOUT_MS, MAX_EXCELNT_POLL_INTERVAL_MS,
  MAX_EXCELNT_RUN_WAIT_MS,
} from "./max-hermes-text-only.mjs";

const selection = { provider: "excelnt", model: "gpt-6-luna", profile: "max-hq", mode: "text_only" };
const task = { id: "cmtestrequest01", kind: "max.chief-of-staff", origin: "max", sideEffecting: false,
  capability: "read_only", action: "coordinate", prompt: "Responde únicamente OK.",
  scope: { maxModelSelection: selection } };
const catalog = { providers: [{ name: "EXCELNT", slug: "excelnt", authenticated: true,
  models: ["gpt-6-luna", "claude-fable-5", "mimo-v2.6-flash"] }] };

test("only explicitly scoped MAX text-only tasks reach the authenticated EXCELNT profile", async () => {
  let postCount = 0;
  const calls = [];
  const diagnostics = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("/v1/runs")) {
      postCount += 1;
      return { ok: true, status: 202, json: async () => ({ run_id: "run_test_1", status: "queued" }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: "completed", output: "OK",
      runtime: { provider: "excelnt", model: "gpt-6-luna" } }) };
  };
  const boundSelection = assertMaxExcelntTextOnlyTask(task, "REMOTE_FREE_ALLOWED");
  const output = await runMaxExcelntTextOnly(task, boundSelection, {
    fetchImpl: fakeFetch, env: { CREDENTIALS_DIRECTORY: "/credential-dir" }, readFile: () => "service-bearer-test-value",
    pollIntervalMs: 0, onDiagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(output, "OK");
  assert.equal(postCount, 1);
  const post = calls.find((call) => call.url.endsWith("/v1/runs"));
  assert.match(post.url, /\/p\/max-hq\/v1\/runs$/);
  assert.equal(post.options.headers.Authorization, "Bearer service-bearer-test-value");
  assert.equal(post.options.headers["Idempotency-Key"], task.id);
  const body = JSON.parse(post.options.body);
  assert.equal(body.provider, "excelnt");
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.model_options, { max_tokens: 512 });
  assert.equal(body.instructions.includes("No tienes herramientas"), true);
  assert.deepEqual(diagnostics.at(-1), {
    requestId: task.id,
    requestedProvider: "excelnt",
    requestedModel: "gpt-6-luna",
    effectiveProvider: "excelnt",
    effectiveModel: "gpt-6-luna",
    apiHttpStatus: 200,
    upstreamHttpStatus: null,
    errorCode: null,
    finalStatus: "completed",
  });
});

test("a selected model outside the authenticated catalog is denied before inference", async () => {
  let inferenceCount = 0;
  const fakeFetch = async (url) => {
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    inferenceCount += 1;
    throw new Error("should_not_post");
  };
  await assert.rejects(runMaxExcelntTextOnly(task, { ...selection, model: "other/model" }, {
    fetchImpl: fakeFetch, env: { CREDENTIALS_DIRECTORY: "/credential-dir" }, readFile: () => "service-bearer-test-value",
  }), /not_in_authenticated_catalog/);
  assert.equal(inferenceCount, 0);
});

test("the Bridge rejects LOCAL_ONLY, side-effecting, and non-MAX selections before transport", () => {
  assert.equal(assertMaxExcelntTextOnlyTask(task, "REMOTE_FREE_ALLOWED").model, "gpt-6-luna");
  assert.throws(() => assertMaxExcelntTextOnlyTask(task, "LOCAL_ONLY"), /local_only/);
  assert.throws(() => assertMaxExcelntTextOnlyTask({ ...task, sideEffecting: true }, "PUBLIC"), /task_denied/);
  assert.throws(() => assertMaxExcelntTextOnlyTask({ ...task, kind: "atlas.research" }, "PUBLIC"), /task_denied/);
  assert.equal(parseMaxExcelntSelection({ kind: "max.chief-of-staff", scope: null }), null);
  assert.throws(() => parseMaxExcelntSelection({ scope: { maxModelSelection: { ...selection, profile: "default" } } }), /selection_invalid/);
});

test("an ambiguous API timeout is surfaced without retrying POST", async () => {
  let postCount = 0;
  const fakeFetch = async (url) => {
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("/v1/runs")) { postCount += 1; throw new Error("simulated_timeout"); }
    throw new Error("unexpected_poll");
  };
  await assert.rejects(runMaxExcelntTextOnly(task, selection, {
    fetchImpl: fakeFetch, env: { CREDENTIALS_DIRECTORY: "/credential-dir" }, readFile: () => "service-bearer-test-value",
  }), /max_excelnt_run_unknown_after_send/);
  assert.equal(postCount, 1);
});

test("EXCELNT overload preserves the upstream 503 and requested/effective route", async () => {
  let postCount = 0;
  const diagnostics = [];
  const fakeFetch = async (url) => {
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("/v1/runs")) {
      postCount += 1;
      return { ok: true, status: 202, json: async () => ({ run_id: "run_overloaded_test", status: "queued" }) };
    }
    return { ok: true, status: 200, json: async () => ({
      status: "failed",
      error_code: "server_overloaded",
      error: "HTTP 503: The server is currently experiencing high load and could not process your request.",
    }) };
  };
  await assert.rejects(runMaxExcelntTextOnly(task, selection, {
    fetchImpl: fakeFetch,
    env: { CREDENTIALS_DIRECTORY: "/credential-dir" },
    readFile: () => "service-bearer-test-value",
    pollIntervalMs: 0,
    onDiagnostic: (entry) => diagnostics.push(entry),
  }), (error) => {
    assert.equal(maxExcelntPublicFailure(error)?.message, "EXCELNT está sobrecargado (HTTP 503). Inténtalo más tarde");
    return error.code === "max_excelnt_upstream_overloaded_http_503";
  });
  assert.equal(postCount, 1);
  assert.deepEqual(diagnostics.at(-1), {
    requestId: task.id,
    requestedProvider: "excelnt",
    requestedModel: "gpt-6-luna",
    effectiveProvider: "excelnt",
    effectiveModel: "gpt-6-luna",
    apiHttpStatus: 200,
    upstreamHttpStatus: 503,
    errorCode: "max_excelnt_upstream_overloaded_http_503",
    finalStatus: "failed",
  });
  assert.equal(JSON.stringify(diagnostics).includes("high load"), false);
});

test("an accepted run with an unavailable status remains ambiguous and is never posted twice", async () => {
  let postCount = 0;
  const diagnostics = [];
  const fakeFetch = async (url) => {
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("/v1/runs")) {
      postCount += 1;
      return { ok: true, status: 202, json: async () => ({ run_id: "run_ambiguous_test", status: "queued" }) };
    }
    throw new Error("simulated_status_timeout");
  };
  await assert.rejects(runMaxExcelntTextOnly(task, selection, {
    fetchImpl: fakeFetch,
    env: { CREDENTIALS_DIRECTORY: "/credential-dir" },
    readFile: () => "service-bearer-test-value",
    pollIntervalMs: 0,
    onDiagnostic: (entry) => diagnostics.push(entry),
  }), (error) => {
    assert.match(maxExcelntPublicFailure(error)?.message || "", /No se pudo confirmar/);
    return error.code === "max_excelnt_run_unknown_after_send";
  });
  assert.equal(postCount, 1);
  assert.equal(diagnostics.at(-1).finalStatus, "unknown_after_send");
});

test("EXCELNT timeout settings are explicit and limited to its adapter", () => {
  assert.equal(MAX_EXCELNT_HTTP_TIMEOUT_MS, 10000);
  assert.equal(MAX_EXCELNT_POLL_INTERVAL_MS, 500);
  assert.equal(MAX_EXCELNT_RUN_WAIT_MS, 360000);
});

test("failed Hermes run reports a sanitized terminal diagnostic", async () => {
  const diagnostics = [];
  const fakeFetch = async (url) => {
    if (url.endsWith("/api/model/options")) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("/v1/runs")) return { ok: true, status: 202, json: async () => ({ run_id: "run_failed_test", status: "started" }) };
    return { ok: true, status: 200, json: async () => ({
      status: "failed",
      model: "gpt-6-luna",
      error: "EXCELNT_MANUAL_INFERENCE_DISABLED: no request was sent; private prompt omitted",
    }) };
  };
  await assert.rejects(runMaxExcelntTextOnly(task, selection, {
    fetchImpl: fakeFetch,
    env: { CREDENTIALS_DIRECTORY: "/credential-dir" },
    readFile: () => "service-bearer-test-value",
    pollIntervalMs: 0,
    onDiagnostic: (entry) => diagnostics.push(entry),
  }), /hermes_api_run_failed:EXCELNT_MANUAL_INFERENCE_DISABLED/);
  assert.deepEqual(diagnostics.at(-1), {
    requestId: task.id,
    requestedProvider: "excelnt",
    requestedModel: "gpt-6-luna",
    effectiveProvider: "unknown",
    effectiveModel: "unknown",
    apiHttpStatus: 200,
    upstreamHttpStatus: null,
    errorCode: "EXCELNT_MANUAL_INFERENCE_DISABLED",
    finalStatus: "failed",
  });
  assert.equal(JSON.stringify(diagnostics).includes("private prompt"), false);
});
