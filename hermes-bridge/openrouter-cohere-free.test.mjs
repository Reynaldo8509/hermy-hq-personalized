import assert from "node:assert/strict";
import test from "node:test";
import { invokeOpenRouterCohereFree, OPENROUTER_COHERE_MODEL, OPENROUTER_CHAT_COMPLETIONS } from "./openrouter-cohere-free.mjs";

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const valid = { provider: "Cohere", model: OPENROUTER_COHERE_MODEL,
  choices: [{ message: { content: "synthetic response" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0 } };

test("fixed free Cohere route dispatches one tool-free request with upstream fallbacks disabled", async () => {
  const calls = [];
  const result = await invokeOpenRouterCohereFree("synthetic prompt", {
    credentialReader: (key) => { assert.equal(key, "OPENROUTER_API_KEY"); return "synthetic-secret"; },
    fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return response(200, valid); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENROUTER_CHAT_COMPLETIONS);
  assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-secret");
  assert.equal(calls[0].body.model, OPENROUTER_COHERE_MODEL);
  assert.equal(calls[0].body.max_tokens, 2048);
  assert.deepEqual(calls[0].body.reasoning, { effort: "minimal" });
  assert.deepEqual(calls[0].body.provider, { only: ["cohere"], order: ["cohere"], allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(calls[0].body.tools, []);
  assert.equal(calls[0].body.tool_choice, "none");
  assert.equal(result.content, "synthetic response");
  assert.equal(result.usage.actual_provider, "Cohere");
  assert.equal(result.usage.total_tokens, 16);
});

test("MAX and ATLAS use exact fixed output bounds and arbitrary limits are denied", async (t) => {
  let body;
  await invokeOpenRouterCohereFree("synthetic Atlas report", {
    maxOutputTokens: 4096,
    reasoningEffort: "none",
    credentialReader: () => "synthetic",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response(200, valid);
    },
  });
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.reasoning, { effort: "none" });
  await t.test("unlisted limit", async () => {
    await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
      maxOutputTokens: 8192,
      credentialReader: () => "synthetic",
      fetchImpl: async () => { throw new Error("must not dispatch"); },
    }), /openrouter_output_limit_not_allowlisted/);
  });
});

test("reasoning effort is restricted to supported minimal or none values", async (t) => {
  let body;
  await invokeOpenRouterCohereFree("synthetic concise triage", {
    reasoningEffort: "none",
    credentialReader: () => "synthetic",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response(200, valid);
    },
  });
  assert.deepEqual(body.reasoning, { effort: "none" });
  await t.test("unsupported reasoning mode is denied before dispatch", async () => {
    await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
      reasoningEffort: "high",
      credentialReader: () => "synthetic",
      fetchImpl: async () => { throw new Error("must not dispatch"); },
    }), /openrouter_reasoning_effort_not_allowlisted/);
  });
});

test("provider, model, and finish reason mismatches fail closed", async (t) => {
  for (const [name, payload, pattern] of [
    ["paid or other model", { ...valid, model: "cohere/north-mini-code" }, /openrouter_response_model_mismatch/],
    ["other backend", { ...valid, provider: "Groq" }, /openrouter_response_provider_mismatch/],
    ["truncation", { ...valid, choices: [{ ...valid.choices[0], finish_reason: "length" }] }, /openrouter_output_truncated/],
    ["tool call", { ...valid, choices: [{ message: { tool_calls: [{ id: "x" }] }, finish_reason: "tool_calls" }] }, /openrouter_finish_reason_rejected/],
  ]) await t.test(name, async () => {
    await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
      credentialReader: () => "synthetic", fetchImpl: async () => response(200, payload),
    }), pattern);
  });
});

test("OpenRouter response rejection diagnostics are specific and contain no response data", async (t) => {
  for (const [name, payload, expected] of [
    ["missing upstream provider", { ...valid, provider: undefined }, "openrouter_response_provider_mismatch"],
    ["paid model response", { ...valid, model: "cohere/north-mini-code" }, "openrouter_response_model_mismatch"],
    ["truncated response", { ...valid, choices: [{ ...valid.choices[0], finish_reason: "length" }] }, "openrouter_output_truncated"],
    ["unsupported finish reason", { ...valid, choices: [{ ...valid.choices[0], finish_reason: "tool_calls" }] }, "openrouter_finish_reason_rejected"],
    ["empty content", { ...valid, choices: [{ message: { content: "  " }, finish_reason: "stop" }] }, "openrouter_content_empty"],
  ]) await t.test(name, async () => {
    await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
      credentialReader: () => "synthetic", fetchImpl: async () => response(200, payload),
    }), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.remoteHttpStatus, 200);
      assert.equal(error.transportAttempted, true);
      assert.equal(Object.hasOwn(error, "response"), false);
      if (expected === "openrouter_output_truncated") {
        assert.equal(error.remoteFinishReason, "length");
        assert.equal(error.remoteUsage.actual_provider, "Cohere");
        assert.equal(error.remoteUsage.actual_model, OPENROUTER_COHERE_MODEL);
        assert.equal(error.remoteUsage.input_tokens, 12);
        assert.equal(error.remoteUsage.output_tokens, 4);
        assert.equal(error.remoteUsage.total_tokens, 16);
      }
      return true;
    });
  });
});

test("auth, quota, server errors, timeout, and unavailable model are surfaced once without provider retries", async (t) => {
  for (const status of [401, 403, 404, 429, 500, 503]) await t.test(String(status), async () => {
    let calls = 0;
    await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
      credentialReader: () => "synthetic", fetchImpl: async () => { calls += 1; return response(status, {}); },
    }), (error) => error.remoteHttpStatus === status && error.transportAttempted === true);
    assert.equal(calls, 1);
  });
  let calls = 0;
  await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
    credentialReader: () => "synthetic", fetchImpl: async () => { calls += 1; throw Object.assign(new Error("timeout"), { name: "AbortError" }); },
  }), /openrouter_timeout_outcome_unknown/);
  assert.equal(calls, 1);
  await assert.rejects(invokeOpenRouterCohereFree("synthetic", {
    credentialReader: () => { throw new Error("missing"); }, fetchImpl: async () => { calls += 1; return response(200, valid); },
  }), /openrouter_credential_unavailable/);
  assert.equal(calls, 1);
});
