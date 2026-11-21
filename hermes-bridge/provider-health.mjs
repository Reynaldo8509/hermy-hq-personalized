import { createHash, randomUUID } from "node:crypto";

export const HEALTH_PROVIDER = "custom:tokenharbor";
export const HEALTH_REQUESTED_MODEL = "deepseek-v4.1-flash:free";
export const HEALTH_CATALOG_URL = "https://tokenharbor.ai/v1/models";
export const OPENROUTER_HEALTH_PROVIDER = "openrouter";
export const OPENROUTER_HEALTH_REQUESTED_MODEL = "cohere/north-mini-code:free";
export const OPENROUTER_HEALTH_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const GROQ_HEALTH_PROVIDER = "groq";
export const GROQ_HEALTH_REQUESTED_MODEL = "openai/gpt-oss-120b";
export const GROQ_HEALTH_CATALOG_URL = "https://api.groq.com/openai/v1/models";
export const GROQ_ACCOUNT_TIER = "FREE";
export const GROQ_OPERATOR_EVIDENCE_SOURCE = "operator_verified_console_free_plan_2026-10-06";
export const GROQ_FREE_PLAN_RATE_LIMITS = Object.freeze({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 });
export const GROQ_FREE_EVIDENCE_SOURCE = `${GROQ_OPERATOR_EVIDENCE_SOURCE}+authenticated_catalog+official_free_plan_limits`;
export const OPENCODE_ZEN_HEALTH_PROVIDER = "opencode-zen";
export const OPENCODE_ZEN_HEALTH_REQUESTED_MODEL = "nemotron-3.5-lightning-free";
export const OPENCODE_ZEN_HEALTH_CATALOG_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_ZEN_PRICING_DOCS_URL = "https://docs.opencode.ai/docs/pt-br/zen/";
export const OPENCODE_ZEN_DOC_MODEL_NAME = "Nemotron 3.5 Lightning Free";
export const OPENCODE_ZEN_DOC_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
// Catalog evidence is short lived and never implies that an inference succeeded.
export const HEALTH_TTL_MS = 45 * 60 * 1000;
export const HEALTH_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
export const HEALTH_PROBE_TYPE = "provider_health";
export const HEALTH_PROBE_PROMPT = "Return exactly this JSON object and nothing else: {\"ok\":true}";
export const TOKENHARBOR_ALLOWED_ACTUAL_MODELS = Object.freeze([
  HEALTH_REQUESTED_MODEL,
  "deepseek-v4.1-flash",
]);
const ALLOWED_ACTUAL_MODELS = new Set(TOKENHARBOR_ALLOWED_ACTUAL_MODELS);

export function payloadSha256(payload) {
  return createHash("sha256").update(String(payload ?? "")).digest("hex");
}


export function createProviderHealthRequest(id = randomUUID()) {
  return {
    id: String(id), kind: "max.chief-of-staff", title: "Synthetic provider health probe",
    prompt: HEALTH_PROBE_PROMPT, origin: "test", sideEffecting: false, attachments: [],
    metadata: { probeType: HEALTH_PROBE_TYPE },
  };
}

export function assertHealthProbeEnvelope({ request, payload, args, provider = HEALTH_PROVIDER,
  model = HEALTH_REQUESTED_MODEL } = {}) {
  const expectedArgs = [
    "--safe-mode", "--provider", provider, "-m", model,
    "--reasoning", "low", "-z", HEALTH_PROBE_PROMPT, "--no-fallback",
    "--privacy-routing", "--privacy-final-gate", "--privacy-tool-free",
    "--privacy-remote-approved", "--privacy-payload-sha256", payloadSha256(HEALTH_PROBE_PROMPT),
  ];
  const exactArgs = Array.isArray(args) && args.length === expectedArgs.length
    && args.every((arg, index) => arg === expectedArgs[index]);
  const supportedRoute = (provider === HEALTH_PROVIDER && model === HEALTH_REQUESTED_MODEL)
    || (provider === OPENROUTER_HEALTH_PROVIDER && model === OPENROUTER_HEALTH_REQUESTED_MODEL);
  const valid = request?.metadata?.probeType === HEALTH_PROBE_TYPE
    && request?.origin === "test"
    && request?.prompt === HEALTH_PROBE_PROMPT
    && String(payload ?? "") === HEALTH_PROBE_PROMPT
    && supportedRoute
    && Array.isArray(request.attachments) && request.attachments.length === 0
    && request.sideEffecting === false && exactArgs;
  if (!valid) throw new Error("provider_health_probe_envelope_denied");
  return true;
}

function numericPrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function catalogPrices(model, pricing, keys) {
  const values = [];
  for (const object of pricing === model ? [pricing] : [pricing, model]) {
    for (const key of keys) {
      if (Object.hasOwn(object, key)) values.push(numericPrice(object[key]));
    }
  }
  return values;
}

export function verifyFreeCatalog(catalog, modelId = HEALTH_REQUESTED_MODEL) {
  const models = Array.isArray(catalog?.data) ? catalog.data
    : Array.isArray(catalog?.models) ? catalog.models : [];
  const model = models.find((candidate) => candidate && candidate.id === modelId);
  if (!model) return { modelAvailable: false, verifiedFree: false, status: "unavailable", reason: "model_missing" };
  const pricing = model.pricing && typeof model.pricing === "object" && !Array.isArray(model.pricing)
    ? model.pricing : model;
  const input = catalogPrices(model, pricing, ["input_usd_per_1m", "price_in_per_1m", "prompt", "input"]);
  const output = catalogPrices(model, pricing, ["output_usd_per_1m", "price_out_per_1m", "completion", "output"]);
  if (input.some((price) => price !== null && price !== 0)
      || output.some((price) => price !== null && price !== 0)) {
    return { modelAvailable: true, verifiedFree: false, status: "not_free", reason: "catalog_price_nonzero" };
  }
  if (input.length === 0 || output.length === 0 || input.includes(null) || output.includes(null)) {
    return { modelAvailable: true, verifiedFree: false, status: "unknown", reason: "catalog_price_unknown" };
  }
  return { modelAvailable: true, verifiedFree: true, status: "catalog_verified_free", reason: null };
}

export async function produceCatalogOnlyHealth({ readCatalog, now = Date.now(), provider = HEALTH_PROVIDER,
  requestedModel = HEALTH_REQUESTED_MODEL, verifyCatalogEvidence = null } = {}) {
  const checkedAt = Number(now);
  const base = {
    provider, requested_model: requestedModel, requestedModel, checkedAt, validUntil: checkedAt,
    status: "unknown", modelAvailable: false, freePrice: false, verified_free: false,
    catalogVerified: false, catalogSource: "authenticated_model_catalog",
    transportOk: false, syntheticInferenceOk: false, structuredJsonOk: false,
    finishReasonVerified: false, toolCompatibility: "not_required_safe_mode",
  };
  try {
    if (typeof readCatalog !== "function") throw new TypeError("catalog_reader_unavailable");
    const catalog = await readCatalog();
    const result = typeof verifyCatalogEvidence === "function"
      ? verifyCatalogEvidence({ catalog, modelId: requestedModel })
      : verifyFreeCatalog(catalog, requestedModel);
    if (result?.verifiedFree !== true || result?.modelAvailable !== true) {
      return { ...base, ...result, status: result?.status || "unknown", catalogVerified: false,
        reason: result?.reason || "catalog_not_verified" };
    }
    return { ...base, ...result, status: "catalog_verified_free", modelAvailable: true,
      freePrice: true, verified_free: true, catalogVerified: true,
      checkedAt, validUntil: checkedAt + HEALTH_TTL_MS, reason: null };
  } catch (error) {
    const status = Number(error?.status);
    return { ...base, status: status === 401 || status === 403 ? "auth_denied" : "unavailable",
      reason: status >= 400 ? `catalog_http_${status}` : "catalog_unavailable" };
  }
}

function htmlCellText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\s+/g, " ").trim();
}

function htmlTableRows(document) {
  return [...String(document ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlCellText(cell[1])));
}

export function verifyGroqFreeEvidence({ catalog, modelId = GROQ_HEALTH_REQUESTED_MODEL,
  accountTier = null, operatorEvidenceSource = null, rateLimits = null } = {}) {
  const models = Array.isArray(catalog?.data) ? catalog.data
    : Array.isArray(catalog?.models) ? catalog.models : [];
  const modelAvailable = models.some((candidate) => candidate && candidate.id === modelId);
  if (modelId !== GROQ_HEALTH_REQUESTED_MODEL || !modelAvailable) {
    return { modelAvailable: false, verifiedFree: false, status: "unavailable", reason: "model_missing" };
  }
  const expectedLimitKeys = Object.keys(GROQ_FREE_PLAN_RATE_LIMITS);
  const limitsMatch = rateLimits && Object.keys(rateLimits).length === expectedLimitKeys.length
    && expectedLimitKeys.every((key) => rateLimits[key] === GROQ_FREE_PLAN_RATE_LIMITS[key]);
  if (accountTier !== "FREE" || operatorEvidenceSource !== GROQ_OPERATOR_EVIDENCE_SOURCE || !limitsMatch) {
    return { modelAvailable: true, verifiedFree: false, status: "unknown", reason: "free_account_evidence_unverified" };
  }
  return { modelAvailable: true, verifiedFree: true, status: "catalog_verified_free",
    reason: null, accountTier: "FREE", freeEvidenceSource: GROQ_FREE_EVIDENCE_SOURCE };
}

export function verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml, modelId = OPENCODE_ZEN_HEALTH_REQUESTED_MODEL } = {}) {
  const models = Array.isArray(catalog) ? catalog
    : Array.isArray(catalog?.data) ? catalog.data
      : Array.isArray(catalog?.models) ? catalog.models : [];
  const modelAvailable = models.some((candidate) => candidate && candidate.id === modelId);
  if (!modelAvailable) return { modelAvailable: false, verifiedFree: false, status: "unavailable", reason: "model_missing" };
  const rows = htmlTableRows(pricingHtml);
  const modelRow = rows.some((cells) => cells[0] === OPENCODE_ZEN_DOC_MODEL_NAME
    && cells[1] === modelId && cells[2] === OPENCODE_ZEN_DOC_ENDPOINT);
  if (!modelRow) return { modelAvailable: true, verifiedFree: false, status: "unknown", reason: "official_model_mapping_unverified" };
  const pricingRow = rows.some((cells) => cells[0] === OPENCODE_ZEN_DOC_MODEL_NAME
    && cells[1]?.toLowerCase() === "free" && cells[2]?.toLowerCase() === "free");
  if (!pricingRow) return { modelAvailable: true, verifiedFree: false, status: "not_free", reason: "official_input_or_output_price_not_free" };
  return {
    modelAvailable: true, verifiedFree: true, status: "catalog_and_official_docs_verified_free", reason: null,
    freeEvidenceSource: "authenticated_catalog+official_pricing_docs",
  };
}

export function validateHealthProbeEvidence({ stdout, usage, expectedProviderLabel = "Token Harbor",
  allowedActualModels = ALLOWED_ACTUAL_MODELS } = {}) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout ?? "").trim()); } catch { /* invalid output */ }
  const structuredJsonOk = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed).length === 1 && parsed.ok === true);
  const finishReason = typeof usage?.finish_reason === "string" ? usage.finish_reason : null;
  const finishReasonVerified = finishReason === "stop";
  const actualProvider = String(usage?.actual_provider || "");
  const actualModel = String(usage?.actual_model || usage?.served_model || "");
  const transportOk = usage?.remote_attempted === true
    && usage?.remote_attempt_status === "success"
    && actualProvider === expectedProviderLabel
    && allowedActualModels.has(actualModel);
  return {
    structuredJsonOk,
    finishReason,
    finishReasonVerified,
    actualProvider: actualProvider || null,
    actualModel: actualModel || null,
    transportOk,
    promptTokens: Number.isSafeInteger(Number(usage?.input_tokens)) ? Number(usage.input_tokens) : null,
    completionTokens: Number.isSafeInteger(Number(usage?.output_tokens)) ? Number(usage.output_tokens) : null,
    totalTokens: Number.isSafeInteger(Number(usage?.total_tokens)) ? Number(usage.total_tokens) : null,
    latencyMs: Number.isFinite(Number(usage?.duration_ms)) ? Math.max(0, Number(usage.duration_ms)) : null,
  };
}

const SAFE_RESULT_FAILURE_REASONS = new Set([
  "auth", "auth_permanent", "billing", "content_policy_blocked", "context_overflow",
  "empty_response", "format_error", "image_corrupt", "image_too_large", "incomplete_response",
  "interpreter_shutdown", "invalid_encrypted_content", "invalid_response", "llama_cpp_grammar_pattern",
  "long_context_tier", "loop_error", "model_entitlement", "model_not_found",
  "multimodal_tool_content_unsupported", "oauth_long_context_beta_forbidden", "overloaded",
  "payload_too_large", "provider_policy_blocked", "rate_limit", "reasoning_mandatory",
  "role_alternation", "server_error", "session_busy", "ssl_cert_verification", "thinking_signature",
  "timeout", "truncated", "unknown", "upstream_blocked", "upstream_rate_limit",
]);

const PRETRANSPORT_FAILURE_CATEGORIES = new Set([
  "local_argument_validation", "credential_unavailable", "privacy_profile_configuration",
  "privacy_runtime_resolution", "final_gate_denied", "probe_envelope_denied",
  "cli_spawn_failure", "cli_nonzero_exit", "python_exception_other", "python_permission_error",
  "python_dependency_error", "python_timeout_error", "python_runtime_error", "python_value_error",
  "python_type_error", "python_key_error", "python_attribute_error", "python_assertion_error",
  "cli_turn_retries_exhausted", "cli_turn_empty_response_exhausted", "cli_turn_local_processing_error",
  "cli_turn_repeated_outer_errors", "cli_turn_error_near_max_iterations", "cli_turn_guardrail_halt",
  "cli_turn_interrupted", "cli_turn_incomplete", "cli_turn_failed_partial", "cli_turn_failed",
  "cli_turn_partial", "cli_turn_not_completed", "cli_result_failure_unknown_no_api_calls",
  "cli_result_failure_unknown_with_api_calls", "cli_empty_response", "cli_turn_budget_exhausted",
  "cli_turn_review_budget_exhausted", "cli_turn_restart_limit", "cli_turn_compaction_handoff",
  "cli_turn_context_compression_exhausted", "cli_turn_context_compression_timeout",
  "cli_turn_session_persistence", "cli_turn_pending_tool_result", "cli_turn_partial_stream_recovery",
  "cli_turn_prior_response_fallback", "cli_turn_local_context_too_small", "cli_turn_max_iterations",
  "unclassified_pre_transport_cli_failure",
  ...Array.from(SAFE_RESULT_FAILURE_REASONS, (reason) => `cli_result_failure_${reason}`),
]);

const TURN_EXIT_FAILURE_CATEGORIES = new Map([
  ["all_retries_exhausted_no_response", "cli_turn_retries_exhausted"],
  ["empty_response_exhausted", "cli_turn_empty_response_exhausted"],
  ["guardrail_halt", "cli_turn_guardrail_halt"],
  ["interpreter_shutdown", "cli_turn_interrupted"],
  ["interrupted_by_user", "cli_turn_interrupted"],
  ["interrupted_by_system", "cli_turn_interrupted"],
  ["system_aborted", "cli_turn_interrupted"],
  ["budget_exhausted", "cli_turn_budget_exhausted"],
  ["review_input_budget_exhausted", "cli_turn_review_budget_exhausted"],
  ["redirect_restart_limit_exceeded", "cli_turn_restart_limit"],
  ["rebuilt_restart_limit_exceeded", "cli_turn_restart_limit"],
  ["compaction_handoff_not_actionable", "cli_turn_compaction_handoff"],
  ["context_compression_exhausted", "cli_turn_context_compression_exhausted"],
  ["context_compression_timeout", "cli_turn_context_compression_timeout"],
  ["session_persistence_failed", "cli_turn_session_persistence"],
  ["pending_tool_result", "cli_turn_pending_tool_result"],
  ["partial_stream_recovery", "cli_turn_partial_stream_recovery"],
  ["fallback_prior_turn_content", "cli_turn_prior_response_fallback"],
  ["ollama_runtime_context_too_small", "cli_turn_local_context_too_small"],
]);

function classifySafeTurnExitReason(value) {
  if (typeof value !== "string") return null;
  if (TURN_EXIT_FAILURE_CATEGORIES.has(value)) return TURN_EXIT_FAILURE_CATEGORIES.get(value);
  for (const [prefix, category] of [
    ["local_processing_error(", "cli_turn_local_processing_error"],
    ["repeated_outer_errors(", "cli_turn_repeated_outer_errors"],
    ["error_near_max_iterations(", "cli_turn_error_near_max_iterations"],
    ["max_iterations_reached(", "cli_turn_max_iterations"],
    ["interrupted_by_system(", "cli_turn_interrupted"],
  ]) if (value.startsWith(prefix)) return category;
  return null;
}

const PYTHON_FAILURE_TYPE_CATEGORIES = new Map([
  ["PermissionError", "python_permission_error"],
  ["FileNotFoundError", "python_dependency_error"],
  ["ModuleNotFoundError", "python_dependency_error"],
  ["ImportError", "python_dependency_error"],
  ["TimeoutError", "python_timeout_error"],
  ["RuntimeError", "python_runtime_error"],
  ["ValueError", "python_value_error"],
  ["TypeError", "python_type_error"],
  ["KeyError", "python_key_error"],
  ["AttributeError", "python_attribute_error"],
  ["AssertionError", "python_assertion_error"],
]);

export function classifyPreTransportFailure({ usage = {}, stderr = "", errorCode = null } = {}) {
  const failure = typeof usage?.failure === "string" ? usage.failure.toLowerCase() : "";
  const failureType = typeof usage?.failure_type === "string" ? usage.failure_type : "";
  const turnExitText = typeof usage?.turn_exit_reason === "string" ? usage.turn_exit_reason.toLowerCase() : "";
  const childText = `${failure}\n${turnExitText}\n${String(stderr ?? "").toLowerCase()}`;
  if (failure === "local_argument_validation" || failureType === "ArgumentValidationError") return "local_argument_validation";
  if (childText.includes("remote provider credential is unavailable")
      || childText.includes("provider_catalog_credential_unavailable")) return "credential_unavailable";
  if (childText.includes("privacy transport configuration")) return "privacy_profile_configuration";
  if (childText.includes("privacy transport runtime could not be resolved")) return "privacy_runtime_resolution";
  if (childText.includes("provider_health_final_gate_denied")) return "final_gate_denied";
  if (childText.includes("provider_health_probe_envelope_denied")) return "probe_envelope_denied";
  const turnExitCategory = classifySafeTurnExitReason(usage?.turn_exit_reason);
  if (turnExitCategory) return turnExitCategory;
  if (PYTHON_FAILURE_TYPE_CATEGORIES.has(failureType)) return PYTHON_FAILURE_TYPE_CATEGORIES.get(failureType);
  if (failureType && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(failureType)) return "python_exception_other";
  const resultFailureReason = typeof usage?.failure_reason === "string" ? usage.failure_reason : "";
  if (resultFailureReason === "unknown" && Number.isSafeInteger(usage?.api_calls) && usage.api_calls >= 0) {
    return usage.api_calls === 0
      ? "cli_result_failure_unknown_no_api_calls"
      : "cli_result_failure_unknown_with_api_calls";
  }
  if (SAFE_RESULT_FAILURE_REASONS.has(resultFailureReason)) return `cli_result_failure_${resultFailureReason}`;
  if (usage?.interrupted === true) return "cli_turn_interrupted";
  if (usage?.failed === true && usage?.partial === true) return "cli_turn_failed_partial";
  if (usage?.partial === true) return "cli_turn_partial";
  if (usage?.failed === true) return "cli_turn_failed";
  if (usage?.completed === false) return "cli_turn_not_completed";
  if (usage?.completed === true && errorCode === 1) return "cli_empty_response";
  if (["ENOENT", "EACCES", "ENOTDIR"].includes(String(errorCode ?? "").toUpperCase())) return "cli_spawn_failure";
  if (typeof errorCode === "number" && errorCode !== 0) return "cli_nonzero_exit";
  return "unclassified_pre_transport_cli_failure";
}

const SAFE_DIAGNOSTIC_MODELS = new Map([
  [HEALTH_PROVIDER, new Set([HEALTH_REQUESTED_MODEL, "deepseek-v4.1-flash"])],
  [GROQ_HEALTH_PROVIDER, new Set([GROQ_HEALTH_REQUESTED_MODEL])],
  [OPENROUTER_HEALTH_PROVIDER, new Set([OPENROUTER_HEALTH_REQUESTED_MODEL])],
  [OPENCODE_ZEN_HEALTH_PROVIDER, new Set([OPENCODE_ZEN_HEALTH_REQUESTED_MODEL])],
]);
const SAFE_PYTHON_EXCEPTION_TYPES = new Set([
  "ArgumentValidationError", "FileNotFoundError", "ImportError", "IsADirectoryError",
  "JSONDecodeError", "ModuleNotFoundError", "NotADirectoryError", "OSError",
  "PermissionError", "SystemExit", "TimeoutError", "TypeError", "ValueError",
]);
const SAFE_PROCESS_SIGNALS = new Set([
  "SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL",
  "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM",
]);
const SAFE_NODE_ERROR_CODES = new Set([
  "EACCES", "EINTR", "EIO", "ENOTDIR", "ENOENT", "ETIMEDOUT",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);

function safePythonExceptionType(usage = {}, stderr = "") {
  const declared = typeof usage?.failure_type === "string" ? usage.failure_type : "";
  if (SAFE_PYTHON_EXCEPTION_TYPES.has(declared)) return declared;
  const text = String(stderr ?? "");
  for (const exceptionType of SAFE_PYTHON_EXCEPTION_TYPES) {
    if (new RegExp(`(?:^|\\b)${exceptionType}(?:\\b|:)`).test(text)) return exceptionType;
  }
  return "unknown_safe";
}

function safePythonReason({ usage = {}, stderr = "", errorCode = null } = {}) {
  const failureType = typeof usage?.failure_type === "string" ? usage.failure_type : "";
  const failure = typeof usage?.failure === "string" ? usage.failure : "";
  const text = `${failure}\n${String(stderr ?? "")}`;
  if (["ModuleNotFoundError", "ImportError"].includes(failureType)
      || /ModuleNotFoundError|No module named/.test(text)) return "module_not_found";
  if (failureType === "FileNotFoundError" || /FileNotFoundError/.test(text)) return "file_not_found";
  if (failureType === "PermissionError" || /PermissionError/.test(text)) return "permission_error";
  if (failureType === "JSONDecodeError" || /JSONDecodeError|json\.decoder/.test(text)) return "json_decode_error";
  if (failureType === "ArgumentValidationError" || /(?:^|\n)\s*usage:[^\n]*\n[^\n]*error:/i.test(text)) return "cli_usage_error";
  if (failureType === "TimeoutError" || errorCode === "ETIMEDOUT"
      || /TimeoutError|timed out|timeout/i.test(text)) return "timeout_before_transport";
  return "unknown_safe";
}

function safeStderrClassification({ usage = {}, stderr = "", errorCode = null } = {}) {
  const reason = safePythonReason({ usage, stderr, errorCode });
  if (reason !== "unknown_safe") return reason;
  if (!String(stderr ?? "").trim()) return "not_available";
  return "unclassified_safe";
}

const SAFE_DIAGNOSTIC_REASONS = new Set([
  "argument_error", "cli_usage_error", "file_not_found", "json_decode_error",
  "module_not_found", "permission_error", "timeout_before_transport", "unknown_safe",
]);
const SAFE_STDERR_CLASSIFICATIONS = new Set([
  ...SAFE_DIAGNOSTIC_REASONS, "not_available", "unclassified_safe",
]);

function sanitizePersistedPreTransportDiagnostics(value, provider, model) {
  if (!value || typeof value !== "object" || value.provider !== provider || value.model !== model
      || value.transport_attempted !== false || !SAFE_DIAGNOSTIC_MODELS.get(provider)?.has(model)) return null;
  const exceptionType = SAFE_PYTHON_EXCEPTION_TYPES.has(value.exception_type)
    ? value.exception_type : "unknown_safe";
  const code = Number.isInteger(value.process_exit_code) && value.process_exit_code >= 0 && value.process_exit_code <= 255
    ? value.process_exit_code : null;
  const signal = value.signal === null ? null
    : SAFE_PROCESS_SIGNALS.has(value.signal) ? value.signal : value.signal === "OTHER" ? "OTHER" : null;
  const errorCode = SAFE_NODE_ERROR_CODES.has(value.sanitized_error_code) ? value.sanitized_error_code : null;
  return {
    provider,
    model,
    stage: value.stage === "hermes_cli_inference" ? value.stage : "unknown_safe",
    exception_type: exceptionType,
    process_exit_code: code,
    signal,
    transport_attempted: false,
    usage_file_created: value.usage_file_created === true,
    invocation_prepared: value.invocation_prepared === true,
    stderr_classification: SAFE_STDERR_CLASSIFICATIONS.has(value.stderr_classification)
      ? value.stderr_classification : "unclassified_safe",
    python_safe_reason: SAFE_DIAGNOSTIC_REASONS.has(value.python_safe_reason)
      ? value.python_safe_reason : "unknown_safe",
    sanitized_error_code: errorCode,
  };
}

/** Build a fixed-shape, allowlisted diagnostic record for a pre-transport CLI failure. */
export function buildPreTransportDiagnostics({ provider, model, stage = "hermes_cli_inference",
  error = {}, usage = {}, stderr = "", transportAttempted = false,
  usageFileCreated = false, invocationPrepared = false } = {}) {
  const allowedModels = SAFE_DIAGNOSTIC_MODELS.get(provider);
  if (!allowedModels?.has(model) || transportAttempted !== false) return null;
  const rawExitCode = Number.isInteger(error?.code) ? error.code
    : Number.isInteger(usage?.exit_code) ? usage.exit_code : null;
  const processExitCode = rawExitCode !== null && rawExitCode >= 0 && rawExitCode <= 255 ? rawExitCode : null;
  const rawSignal = typeof error?.signal === "string" ? error.signal : "";
  const signal = rawSignal ? (SAFE_PROCESS_SIGNALS.has(rawSignal) ? rawSignal : "OTHER") : null;
  const rawErrorCode = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  return {
    provider,
    model,
    stage: stage === "hermes_cli_inference" ? stage : "unknown_safe",
    exception_type: safePythonExceptionType(usage, stderr),
    process_exit_code: processExitCode,
    signal,
    transport_attempted: false,
    usage_file_created: usageFileCreated === true,
    invocation_prepared: invocationPrepared === true,
    stderr_classification: safeStderrClassification({ usage, stderr, errorCode: rawErrorCode }),
    python_safe_reason: safePythonReason({ usage, stderr, errorCode: rawErrorCode }),
    sanitized_error_code: SAFE_NODE_ERROR_CODES.has(rawErrorCode) ? rawErrorCode : null,
  };
}

export function classifyProviderHealthFailure(error) {
  if (error && typeof error === "object" && Object.hasOwn(error, "transportAttempted")) {
    if (error.transportAttempted === false) return "pre_transport_error";
    const remoteStatus = Number(error.remoteHttpStatus);
    const hasVerifiedStatus = Number.isInteger(remoteStatus) && remoteStatus >= 100 && remoteStatus <= 599;
    if (error.transportAttempted !== true && !hasVerifiedStatus) return "transport_outcome_unknown";
    if (remoteStatus === 403 && error.provider === OPENCODE_ZEN_HEALTH_PROVIDER
        && error.model === OPENCODE_ZEN_HEALTH_REQUESTED_MODEL
        && error.safeErrorType === "FreeTierError") return "provider_policy_restricted";
    const groqRoute = error.provider === GROQ_HEALTH_PROVIDER && error.model === GROQ_HEALTH_REQUESTED_MODEL;
    if (remoteStatus === 402) return "payment_required";
    if (remoteStatus === 429) return "rate_limited";
    if (groqRoute && remoteStatus === 401) return "auth_failure";
    if (groqRoute && remoteStatus === 403) return "auth_or_provider_policy";
    if (remoteStatus === 401 || remoteStatus === 403) return "auth_denied";
    if (groqRoute && remoteStatus >= 500 && remoteStatus <= 599) return "provider_error";
    if (remoteStatus === 503) return "provider_503";
    if (remoteStatus >= 500 && remoteStatus <= 599) return "provider_5xx";
    return "transport_outcome_unknown";
  }
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 403 && error?.provider === OPENCODE_ZEN_HEALTH_PROVIDER
      && error?.model === OPENCODE_ZEN_HEALTH_REQUESTED_MODEL
      && error?.safeErrorType === "FreeTierError") return "provider_policy_restricted";
  const groqRoute = error?.provider === GROQ_HEALTH_PROVIDER && error?.model === GROQ_HEALTH_REQUESTED_MODEL;
  if (status === 402) return "payment_required";
  if (status === 429) return "rate_limited";
  if (groqRoute && status === 401) return "auth_failure";
  if (groqRoute && status === 403) return "auth_or_provider_policy";
  if (status === 401 || status === 403) return "auth_denied";
  if (groqRoute && status >= 500 && status <= 599) return "provider_error";
  if (status >= 500 && status <= 599) return "provider_5xx";
  if (error?.code === "credential_unavailable") return "credential_unavailable";
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(String(error?.code || error?.message || ""))) return "timeout";
  return "provider_error";
}

export function healthIsFresh(health, now = Date.now()) {
  const catalogOnly = health?.status === "catalog_verified_free"
    && health.catalogVerified === true && health.catalogSource === "authenticated_model_catalog";
  const inferenceVerified = health?.status === "healthy"
    && health.syntheticInferenceOk === true && health.transportOk === true
    && health.structuredJsonOk === true && health.finishReasonVerified === true;
  return Boolean((catalogOnly || inferenceVerified) && health.modelAvailable === true
    && health.freePrice === true && health.verified_free === true
    && health.toolCompatibility === "not_required_safe_mode"
    && Number.isFinite(Number(health.checkedAt)) && Number.isFinite(Number(health.validUntil))
    && Number(health.checkedAt) <= now && Number(health.validUntil) > now
    && Number(health.validUntil) - Number(health.checkedAt) <= HEALTH_TTL_MS);
}

export async function produceProviderHealth({ readCatalog, readOfficialPricingDocs = null,
  verifyCatalogEvidence = null, runProbe, now = Date.now(), probeId = randomUUID(),
  provider = HEALTH_PROVIDER, requestedModel = HEALTH_REQUESTED_MODEL,
  providerLabel = "Token Harbor", allowedActualModels = ALLOWED_ACTUAL_MODELS } = {}) {
  const checkedAt = Number(now);
  const base = {
    provider,
    requested_model: requestedModel,
    requestedModel,
    probeId: String(probeId),
    checkedAt,
    validUntil: checkedAt,
    status: "unknown",
    modelAvailable: false,
    freePrice: false,
    verified_free: false,
    transportOk: false,
    syntheticInferenceOk: false,
    structuredJsonOk: false,
    finishReasonVerified: false,
    toolCompatibility: "not_required_safe_mode",
    freeEvidenceSource: null,
  };
  let catalog;
  try {
    catalog = await readCatalog();
  } catch (error) {
    const errorClass = classifyProviderHealthFailure(error);
    return { ...base, status: provider === GROQ_HEALTH_PROVIDER ? errorClass : "unavailable",
      reason: errorClass, classification: errorClass, nextProbeAt: checkedAt + HEALTH_RETRY_COOLDOWN_MS };
  }
  let officialPricingDocs = null;
  if (typeof readOfficialPricingDocs === "function") {
    try {
      officialPricingDocs = await readOfficialPricingDocs();
    } catch (error) {
      const errorClass = classifyProviderHealthFailure(error);
      return { ...base, status: "unavailable", reason: "official_pricing_docs_" + errorClass,
        catalogCheckedAt: Number(now), nextProbeAt: checkedAt + HEALTH_RETRY_COOLDOWN_MS };
    }
  }
  let catalogResult;
  try {
    catalogResult = typeof verifyCatalogEvidence === "function"
      ? verifyCatalogEvidence({ catalog, pricingHtml: officialPricingDocs, modelId: requestedModel })
      : verifyFreeCatalog(catalog, requestedModel);
  } catch {
    catalogResult = { modelAvailable: false, verifiedFree: false, status: "unknown", reason: "pricing_evidence_invalid" };
  }
  const catalogCheckedAt = Number(now);
  if (!catalogResult.verifiedFree) {
    const cooldown = catalogResult.reason === "catalog_price_nonzero" ? 6 * 60 * 60 * 1000 : HEALTH_RETRY_COOLDOWN_MS;
    return { ...base, ...catalogResult, catalogCheckedAt, freePrice: false, verified_free: false,
      reason: catalogResult.reason, nextProbeAt: checkedAt + cooldown };
  }
  let evidence;
  try {
    evidence = validateHealthProbeEvidence({ ...(await runProbe()),
      expectedProviderLabel: providerLabel, allowedActualModels });
  } catch (error) {
    const errorClass = classifyProviderHealthFailure(error);
    const cooldown = errorClass === "payment_required" ? 6 * 60 * 60 * 1000 : HEALTH_RETRY_COOLDOWN_MS;
    const remoteAttemptStatus = errorClass === "provider_policy_restricted" ? "failed"
      : ["not_attempted", "success", "failed", "uncertain"].includes(error?.remoteAttemptStatus)
        ? error.remoteAttemptStatus : null;
    const lastVerifiedHttpStatus = error?.transportAttempted === true
      && Number.isInteger(Number(error?.remoteHttpStatus))
      && Number(error.remoteHttpStatus) >= 100 && Number(error.remoteHttpStatus) <= 599
      ? Number(error.remoteHttpStatus) : null;
    const preTransportFailureCategory = errorClass === "pre_transport_error"
      && PRETRANSPORT_FAILURE_CATEGORIES.has(String(error?.localFailureCategory || ""))
      ? error.localFailureCategory : null;
    const preTransportDiagnostics = errorClass === "pre_transport_error"
      ? sanitizePersistedPreTransportDiagnostics(error?.preTransportDiagnostics, provider, requestedModel)
      : null;
    return { ...base, ...catalogResult, catalogCheckedAt, freePrice: true, verified_free: true,
      status: provider === GROQ_HEALTH_PROVIDER ? errorClass : catalogResult.status,
      transportAttempted: typeof error?.transportAttempted === "boolean" ? error.transportAttempted : null,
      remoteAttemptStatus,
      lastVerifiedHttpStatus,
      classification: errorClass,
      ...(error?.safeErrorType === "FreeTierError" ? { safeErrorType: "FreeTierError" } : {}),
      ...(preTransportFailureCategory ? { preTransportFailureCategory } : {}),
      ...(preTransportDiagnostics ? { preTransportDiagnostics } : {}),
      reason: errorClass, nextProbeAt: checkedAt + cooldown };
  }
  const healthy = evidence.transportOk && evidence.structuredJsonOk && evidence.finishReasonVerified;
  const health = {
    ...base,
    ...catalogResult,
    catalogCheckedAt,
    freePrice: true,
    verified_free: true,
    freeEvidenceSource: catalogResult.freeEvidenceSource || "authenticated_catalog",
    transportOk: evidence.transportOk,
    syntheticInferenceOk: evidence.transportOk,
    structuredJsonOk: evidence.structuredJsonOk,
    finishReasonVerified: evidence.finishReasonVerified,
    finishReason: evidence.finishReason,
    actual_provider: evidence.actualProvider,
    actual_model: evidence.actualModel,
    latency_ms: evidence.latencyMs,
    prompt_tokens: evidence.promptTokens,
    completion_tokens: evidence.completionTokens,
    total_tokens: evidence.totalTokens,
    status: healthy ? "healthy" : "degraded",
    reason: healthy ? null : (!evidence.transportOk ? "transport_or_model_unverified"
      : !evidence.structuredJsonOk ? "structured_json_invalid" : "finish_reason_unverified"),
    validUntil: healthy ? checkedAt + HEALTH_TTL_MS : checkedAt,
    ...(healthy ? {} : { nextProbeAt: checkedAt + HEALTH_RETRY_COOLDOWN_MS }),
  };
  return health;
}

export function shouldRunProviderHealthProbe(state, now = Date.now()) {
  const health = state?.health;
  if (healthIsFresh(health, now)) return false;
  return !(Number.isFinite(Number(health?.nextProbeAt)) && Number(health.nextProbeAt) > now);
}
