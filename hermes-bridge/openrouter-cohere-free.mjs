import { readProviderCredential } from "./provider-credentials.mjs";

export const OPENROUTER_COHERE_MODEL = "cohere/north-mini-code:free";
export const OPENROUTER_CHAT_COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";
const APPROVED_PROVIDER = "cohere";
// MAX triage and ATLAS's six validated evidence fields both need more than the
// prior 512/1024 caps. Keep one finite ceiling far below the verified catalog cap.
const MAX_OUTPUT_TOKENS = Object.freeze({ max: 2048, atlas: 4096 });
const ALLOWED_OUTPUT_LIMITS = new Set(Object.values(MAX_OUTPUT_TOKENS));
const ALLOWED_REASONING_EFFORTS = new Set(["minimal", "none"]);
const SAFE_CAUSE_CLASSES = new Set(["AbortError", "TypeError", "Error", "SyntaxError", "FetchError", "ConnectTimeoutError"]);

function safeError(code, { status = null, attempted = false, finishReason = null, usage = null,
  phase = "preflight", causeClass = null } = {}) {
  const safeCauseClass = causeClass === null ? "none"
    : SAFE_CAUSE_CLASSES.has(causeClass) ? causeClass : "unclassified";
  return Object.assign(new Error(code), {
    code, transportAttempted: attempted, ...(Number.isInteger(status) ? { remoteHttpStatus: status } : {}),
    remoteStage: phase, remoteCauseClass: safeCauseClass,
    ...(typeof finishReason === "string" && ["length", "stop", "end_turn", "tool_calls", "content_filter"].includes(finishReason)
      ? { remoteFinishReason: finishReason } : {}),
    ...(usage && typeof usage === "object" ? { remoteUsage: usage } : {}),
  });
}

function safeUsage(payload) {
  const nonNegativeInteger = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : {};
  const out = {
    input_tokens: nonNegativeInteger(usage.prompt_tokens),
    output_tokens: nonNegativeInteger(usage.completion_tokens),
    total_tokens: nonNegativeInteger(usage.total_tokens),
    reasoning_tokens: nonNegativeInteger(usage.completion_tokens_details?.reasoning_tokens),
    api_calls: 1,
  };
  if (payload?.provider === "Cohere") out.actual_provider = "Cohere";
  if (payload?.model === OPENROUTER_COHERE_MODEL) out.actual_model = OPENROUTER_COHERE_MODEL;
  return out;
}

export async function invokeOpenRouterCohereFree(prompt, {
  credentialReader = readProviderCredential,
  fetchImpl = globalThis.fetch,
  endpoint = OPENROUTER_CHAT_COMPLETIONS,
  timeoutMs = 30_000,
  maxOutputTokens = MAX_OUTPUT_TOKENS.max,
  reasoningEffort = "minimal",
} = {}) {
  const text = String(prompt ?? "");
  if (!text.trim() || text.length > 100_000) throw safeError("openrouter_payload_rejected", { phase: "request_validation" });
  if (endpoint !== OPENROUTER_CHAT_COMPLETIONS) throw safeError("openrouter_endpoint_not_allowlisted");
  if (!ALLOWED_OUTPUT_LIMITS.has(maxOutputTokens)) throw safeError("openrouter_output_limit_not_allowlisted");
  if (!ALLOWED_REASONING_EFFORTS.has(reasoningEffort)) throw safeError("openrouter_reasoning_effort_not_allowlisted");
  if (typeof fetchImpl !== "function") throw safeError("openrouter_transport_unavailable");
  let key;
  try { key = credentialReader("OPENROUTER_API_KEY"); }
  catch { throw safeError("openrouter_credential_unavailable", { phase: "credential_resolution" }); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(30_000, timeoutMs)));
  timer.unref?.();
  const body = {
    model: OPENROUTER_COHERE_MODEL,
    messages: [{ role: "user", content: text }],
    max_tokens: maxOutputTokens,
    temperature: 0,
    stream: false,
    reasoning: { effort: reasoningEffort },
    tools: [],
    tool_choice: "none",
    provider: { only: [APPROVED_PROVIDER], order: [APPROVED_PROVIDER], allow_fallbacks: false, require_parameters: true },
  };
  let response;
  const startedAt = Date.now();
  try {
    response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw safeError(error?.name === "AbortError" ? "openrouter_timeout_outcome_unknown" : "openrouter_transport_outcome_unknown", {
      attempted: null, phase: "http_transport", causeClass: error?.name,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) throw safeError(`openrouter_http_${Number(response?.status) || 0}`, {
    status: Number(response?.status), attempted: true, phase: "http_response",
  });
  let payload;
  try { payload = await response.json(); }
  catch (error) {
    throw safeError("openrouter_response_invalid", {
      status: Number(response.status), attempted: true, phase: "response_parse", causeClass: error?.name,
    });
  }
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  const actualProvider = String(payload?.provider || "").trim().toLowerCase();
  // Keep response diagnostics specific without recording provider text or any
  // response body. A missing or changed backend/model is a hard deny.
  if (payload?.model !== OPENROUTER_COHERE_MODEL) {
    throw safeError("openrouter_response_model_mismatch", { status: Number(response.status), attempted: true, phase: "response_validation" });
  }
  if (actualProvider !== APPROVED_PROVIDER) {
    throw safeError("openrouter_response_provider_mismatch", { status: Number(response.status), attempted: true, phase: "response_validation" });
  }
  if (choice?.finish_reason !== "stop" && choice?.finish_reason !== "end_turn") {
    throw safeError(choice?.finish_reason === "length" ? "openrouter_output_truncated" : "openrouter_finish_reason_rejected", {
      status: Number(response.status), attempted: true, finishReason: choice?.finish_reason,
      usage: safeUsage(payload), phase: "response_validation",
    });
  }
  if (typeof content !== "string" || !content.trim()) {
    throw safeError("openrouter_content_empty", { status: Number(response.status), attempted: true, phase: "response_validation" });
  }
  const inputTokens = Number.isSafeInteger(Number(payload?.usage?.prompt_tokens)) ? Number(payload.usage.prompt_tokens) : null;
  const outputTokens = Number.isSafeInteger(Number(payload?.usage?.completion_tokens)) ? Number(payload.usage.completion_tokens) : null;
  const totalTokens = Number.isSafeInteger(Number(payload?.usage?.total_tokens)) ? Number(payload.usage.total_tokens)
    : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const cost = Number(payload?.usage?.cost);
  return {
    content,
    usage: {
      provider: "Cohere", actual_provider: "Cohere", model: OPENROUTER_COHERE_MODEL,
      actual_model: OPENROUTER_COHERE_MODEL, remote_attempted: true, remote_attempt_status: "success",
      remote_http_status: Number(response.status), input_tokens: inputTokens,
      output_tokens: outputTokens, total_tokens: totalTokens,
      finish_reason: choice.finish_reason, api_calls: 1,
      ...(Number.isFinite(cost) && cost >= 0 ? { actual_cost_usd: cost, cost_status: cost === 0 ? "reported_zero" : "actual" } : {}),
      duration_ms: Date.now() - startedAt,
    },
  };
}
