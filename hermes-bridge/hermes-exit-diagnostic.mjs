function safeIdentifier(value) {
  const text = String(value || "");
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(text) ? text : null;
}

function safeReferenceErrorDetail(error) {
  if (safeIdentifier(error?.name) !== "ReferenceError" || typeof error?.message !== "string") return "unrecorded";
  const missing = error.message.match(/^([A-Za-z_][A-Za-z0-9_]*) is not defined$/);
  if (missing) return `missing_binding_${missing[1]}`;
  const temporal = error.message.match(/^Cannot access '([A-Za-z_][A-Za-z0-9_]*)' before initialization$/);
  if (temporal) return `initialization_order_${temporal[1]}`;
  return "unclassified_reference_error";
}

function safeSourceLocation(error) {
  if (typeof error?.stack !== "string" || error.stack.length > 64 * 1024) return "unrecorded";
  for (const line of error.stack.split(/\r?\n/).slice(1, 12)) {
    const match = line.match(/^\s*at (?:.*?\()?([^()\s]+):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const file = match[1].split(/[\\/]/).at(-1);
    const row = Number(match[2]);
    if (/^[A-Za-z0-9_.-]{1,120}$/.test(file) && Number.isSafeInteger(row) && row > 0) {
      return `${file}:${row}`;
    }
  }
  return "unrecorded";
}

const SAFE_PRIVACY_TRANSPORT_ERROR_CODES = new Set([
  "provider_config_duplicate", "provider_config_invalid", "provider_config_mismatch",
  "model_config_mismatch", "endpoint_mismatch", "profile_pair_not_allowed",
  "credential_unavailable", "privacy_metadata_missing", "safe_transport_flags_missing",
  "remote_approval_missing", "prior_context_present", "payload_binding_invalid",
  "runtime_resolution_failed", "unclassified",
]);

const SAFE_OPENROUTER_ADAPTER_FAILURES = new Map([
  ["openrouter_payload_rejected", "request_validation"],
  ["openrouter_endpoint_not_allowlisted", "preflight"],
  ["openrouter_output_limit_not_allowlisted", "preflight"],
  ["openrouter_transport_unavailable", "preflight"],
  ["openrouter_credential_unavailable", "credential_resolution"],
  ["openrouter_timeout_outcome_unknown", "http_transport"],
  ["openrouter_transport_outcome_unknown", "http_transport"],
  ["openrouter_response_invalid", "response_parse"],
  ["openrouter_response_model_mismatch", "response_validation"],
  ["openrouter_response_provider_mismatch", "response_validation"],
  ["openrouter_output_truncated", "response_validation"],
  ["openrouter_finish_reason_rejected", "response_validation"],
  ["openrouter_content_empty", "response_validation"],
]);

const SAFE_PERSISTENCE_SQLSTATE_CLASSES = new Map([
  ["08", "database_connection"],
  ["22", "database_data_error"],
  ["23", "database_constraint"],
  ["25", "database_transaction_state"],
  ["28", "database_authorization"],
  ["40", "database_transaction_rollback"],
  ["42", "database_query"],
  ["53", "database_resource_limit"],
  ["54", "database_program_limit"],
  ["55", "database_object_state"],
  ["57", "database_operation_interrupted"],
  ["58", "database_system_error"],
  ["XX", "database_internal_error"],
]);
const SAFE_PERSISTENCE_CLIENT_CODES = new Map([
  ["ECONNREFUSED", "database_connection"],
  ["ECONNRESET", "database_connection"],
  ["EPIPE", "database_connection"],
  ["ETIMEDOUT", "database_timeout"],
]);

/** Return only fixed persistence diagnostics; never expose SQL, messages, or values. */
export function summarizePersistenceFailure(error) {
  let code = null;
  let name = null;
  try {
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.name === "string") name = error.name;
  } catch {
    // Uninspectable error objects remain a generic, fail-safe persistence failure.
  }
  const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  const failureClass = sqlState
    ? SAFE_PERSISTENCE_SQLSTATE_CLASSES.get(code.slice(0, 2)) || "database_error"
    : SAFE_PERSISTENCE_CLIENT_CODES.get(code) || (name === "AbortError" || name === "TimeoutError"
      ? "database_timeout" : "database_error");
  const errorClass = sqlState ? "postgres_error"
    : SAFE_PERSISTENCE_CLIENT_CODES.has(code) ? "database_client_error"
      : name === "AbortError" || name === "TimeoutError" ? "timeout_error" : "unknown_error";
  return `phase=persistence; failure_class=${failureClass}; error_class=${errorClass}`;
}

function safeOpenRouterAdapterCode(value) {
  if (typeof value !== "string") return null;
  if (SAFE_OPENROUTER_ADAPTER_FAILURES.has(value)) return value;
  return /^openrouter_http_(?:0|[1-5][0-9]{2})$/.test(value) ? value : null;
}

function safeHermesExitDiagnostic(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 600) return false;
  const fields = value.split("; ");
  const prefix = fields.shift() || "";
  const processExit = /^hermes_oneshot_exit_(?:[1-9][0-9]{0,2})$/.test(prefix);
  const adapterFailure = prefix === "hermes_adapter_failure";
  if (!processExit && !adapterFailure) return false;
  const enumValue = (allowed) => (candidate) => allowed.has(candidate);
  const identifierValue = (candidate) => safeIdentifier(candidate) === candidate;
  const boolValue = (candidate) => candidate === "true" || candidate === "false";
  const boundedInteger = (maxDigits, min = 0, max = Number.MAX_SAFE_INTEGER) => (candidate) => {
    if (!new RegExp(`^(?:0|[1-9][0-9]{0,${maxDigits - 1}})$`).test(candidate)) return false;
    const number = Number(candidate);
    return Number.isSafeInteger(number) && number >= min && number <= max;
  };
  const validators = new Map([
    ["outcome", enumValue(new Set(["interrupted", "incomplete_turn", "failed", "reason_unavailable"]))],
    ["failure_type", identifierValue],
    ["failure_type_source", enumValue(new Set(["stderr_traceback"]))],
    ["completed", boolValue], ["partial", boolValue], ["failed", boolValue],
    ["turn_exit_reason_present", boolValue], ["finish_reason_present", boolValue],
    ["turn_exit_reason", (candidate) => identifierValue(candidate)
      || /^max_iterations_reached\([0-9]{1,4}\/[0-9]{1,4}\)$/.test(candidate)],
    ["finish_reason", enumValue(SAFE_FINISH_REASONS)],
    ["failure_reason", identifierValue],
    ["privacy_transport_error_code", enumValue(SAFE_PRIVACY_TRANSPORT_ERROR_CODES)],
    ["privacy_api_error_class", identifierValue],
    ["privacy_api_error_reason", identifierValue],
    ["privacy_api_error_status", boundedInteger(3, 100, 599)],
    ["privacy_remote_attempted", boolValue],
    ["api_calls", boundedInteger(5, 0, 10000)],
    ["final_response_present", boolValue],
    ["final_response_chars", boundedInteger(7, 0, 1000000)],
    ["message_count", boundedInteger(6, 0, 100000)],
    ["last_message_role", enumValue(new Set(["system", "user", "assistant", "tool", "other"]))],
    ["remote_attempted", (candidate) => boolValue(candidate)
      || ["yes", "no", "unverified"].includes(candidate)],
    ["http_status", boundedInteger(3, 100, 599)],
    ["input_tokens", boundedInteger(15)], ["output_tokens", boundedInteger(15)],
    ["total_tokens", boundedInteger(15)],
    ["error_class", enumValue(new Set(["Error", "AbortError", "TypeError", "unclassified"]))],
    ["cause_class", enumValue(new Set(["none", "AbortError", "TypeError", "Error", "SyntaxError",
      "FetchError", "ConnectTimeoutError", "unclassified"]))],
    ["error_code", (candidate) => safeOpenRouterAdapterCode(candidate) === candidate],
    ["target_provider", enumValue(new Set(["openrouter"]))],
    ["target_model", enumValue(new Set(["cohere/north-mini-code:free"]))],
    ["phase", enumValue(new Set(["request_validation", "preflight", "credential_resolution",
      "http_transport", "http_response", "response_parse", "response_validation"]))],
  ]);
  const seen = new Set();
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator < 1) return false;
    const key = field.slice(0, separator);
    const candidate = field.slice(separator + 1);
    const validate = validators.get(key);
    if (!validate || seen.has(key) || !validate(candidate)) return false;
    seen.add(key);
  }
  if (adapterFailure && !["error_class", "cause_class", "error_code", "target_provider", "target_model", "phase", "remote_attempted"]
    .every((required) => seen.has(required))) return false;
  return true;
}

function safeTurnExitReason(value) {
  const identifier = safeIdentifier(value);
  if (identifier) return identifier;
  const text = String(value || "");
  const iterations = text.match(/^max_iterations_reached\(([0-9]{1,4})\/([0-9]{1,4})\)$/);
  if (iterations) return `max_iterations_reached(${iterations[1]}/${iterations[2]})`;
  const response = text.match(/^text_response\(finish_reason=(stop|length|tool_calls|function_call|content_filter|error|unknown)\)$/);
  if (response) return `text_response_${response[1]}`;
  for (const reason of ["local_processing_error", "repeated_outer_errors", "error_near_max_iterations",
    "interrupted_by_system", "interrupted_during_api_call"]) {
    if (text.startsWith(`${reason}(`) && text.endsWith(")")) return reason;
  }
  return null;
}

const SAFE_FINISH_REASONS = new Set([
  "stop", "length", "tool_calls", "function_call", "content_filter", "error", "unknown",
]);

function tracebackFailureType(stderr) {
  if (typeof stderr !== "string" || stderr.length > 1024 * 1024) return null;
  const marker = "Traceback (most recent call last):";
  const start = stderr.lastIndexOf(marker);
  if (start < 0) return null;
  const finalLine = stderr.slice(start).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || "";
  const match = finalLine.match(/^((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)(?::(?:\s|$)|$)/);
  return safeIdentifier(match?.[1]?.split(".").at(-1));
}

export function summarizeHermesExit(exitCode, usage = {}, stderr = "") {
  const code = Number(exitCode);
  if (!Number.isInteger(code) || code < 1 || code > 255) return null;
  if (!usage || typeof usage !== "object") usage = {};
  const failureType = safeIdentifier(usage.failure_type) || tracebackFailureType(stderr);
  const failureReason = safeIdentifier(usage.failure_reason);
  const turnExitReason = safeTurnExitReason(usage.turn_exit_reason);
  const privacyApiErrorClass = safeIdentifier(usage.privacy_api_error_class);
  const privacyApiErrorReason = safeIdentifier(usage.privacy_api_error_reason);
  const finishReason = typeof usage.finish_reason === "string" && SAFE_FINISH_REASONS.has(usage.finish_reason)
    ? usage.finish_reason : null;
  const completed = typeof usage.completed === "boolean" ? usage.completed : null;
  const partial = typeof usage.partial === "boolean" ? usage.partial : null;
  const failed = typeof usage.failed === "boolean" ? usage.failed : null;
  const interrupted = usage.interrupted === true;

  const fields = [`hermes_oneshot_exit_${code}`];
  if (failureType) {
    fields.push(`failure_type=${failureType}`);
    if (!safeIdentifier(usage.failure_type)) fields.push("failure_type_source=stderr_traceback");
  } else if (interrupted) fields.push("outcome=interrupted");
  else if (completed === false || partial === true) fields.push("outcome=incomplete_turn");
  else if (usage.failed === true) fields.push("outcome=failed");
  else fields.push("outcome=reason_unavailable");
  if (completed !== null) fields.push(`completed=${completed}`);
  if (partial !== null) fields.push(`partial=${partial}`);
  if (failed !== null) fields.push(`failed=${failed}`);
  if (turnExitReason) fields.push(`turn_exit_reason=${turnExitReason}`);
  else if (Object.hasOwn(usage, "turn_exit_reason")) fields.push(`turn_exit_reason_present=${usage.turn_exit_reason != null}`);
  if (finishReason) fields.push(`finish_reason=${finishReason}`);
  else if (Object.hasOwn(usage, "finish_reason")) fields.push(`finish_reason_present=${usage.finish_reason != null}`);
  if (failureReason) fields.push(`failure_reason=${failureReason}`);
  if (SAFE_PRIVACY_TRANSPORT_ERROR_CODES.has(usage.privacy_transport_error_code)) {
    fields.push(`privacy_transport_error_code=${usage.privacy_transport_error_code}`);
  }
  if (privacyApiErrorClass) fields.push(`privacy_api_error_class=${privacyApiErrorClass}`);
  if (privacyApiErrorReason) fields.push(`privacy_api_error_reason=${privacyApiErrorReason}`);
  const privacyApiErrorStatus = Number(usage.privacy_api_error_status);
  if (Number.isInteger(privacyApiErrorStatus) && privacyApiErrorStatus >= 100 && privacyApiErrorStatus <= 599) {
    fields.push(`privacy_api_error_status=${privacyApiErrorStatus}`);
  }
  if (typeof usage.privacy_remote_attempted === "boolean") {
    fields.push(`privacy_remote_attempted=${usage.privacy_remote_attempted}`);
  }
  const apiCalls = Number(usage.api_calls);
  if (Number.isSafeInteger(apiCalls) && apiCalls >= 0 && apiCalls <= 10000) fields.push(`api_calls=${apiCalls}`);
  if (typeof usage.final_response_present === "boolean") fields.push(`final_response_present=${usage.final_response_present}`);
  const responseChars = Number(usage.final_response_chars);
  if (Number.isSafeInteger(responseChars) && responseChars >= 0 && responseChars <= 1_000_000) {
    fields.push(`final_response_chars=${responseChars}`);
  }
  const messageCount = Number(usage.message_count);
  if (Number.isSafeInteger(messageCount) && messageCount >= 0 && messageCount <= 100_000) {
    fields.push(`message_count=${messageCount}`);
  }
  if (["system", "user", "assistant", "tool", "other"].includes(usage.last_message_role)) {
    fields.push(`last_message_role=${usage.last_message_role}`);
  }
  if (typeof usage.remote_attempted === "boolean") fields.push(`remote_attempted=${usage.remote_attempted}`);
  const httpStatus = Number(usage.remote_http_status);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    fields.push(`http_status=${httpStatus}`);
  }
  const inputTokens = Number(usage.input_tokens);
  if (Number.isSafeInteger(inputTokens) && inputTokens >= 0) fields.push(`input_tokens=${inputTokens}`);
  const outputTokens = Number(usage.output_tokens);
  if (Number.isSafeInteger(outputTokens) && outputTokens >= 0) fields.push(`output_tokens=${outputTokens}`);
  const totalTokens = Number(usage.total_tokens);
  if (Number.isSafeInteger(totalTokens) && totalTokens >= 0) fields.push(`total_tokens=${totalTokens}`);
  return fields.join("; ");
}

/**
 * Summarize one-shot failures without exposing messages, prompts, response bodies,
 * credentials, or arbitrary error properties. Numeric Hermes CLI exits keep the
 * established format; the pinned OpenRouter adapter uses a closed set of text codes.
 */
export function summarizeHermesOneShotFailure(error, usage = {}, stderr = "") {
  if (Number.isInteger(error?.code)) return summarizeHermesExit(error.code, usage, stderr);
  const errorCode = safeOpenRouterAdapterCode(error?.code);
  if (!errorCode) return null;
  const phase = SAFE_OPENROUTER_ADAPTER_FAILURES.get(errorCode)
    || (/^openrouter_http_/.test(errorCode) ? "http_response" : null);
  if (!phase || (error?.remoteStage != null && error.remoteStage !== phase)) return null;
  const errorClass = ["Error", "AbortError", "TypeError"].includes(error?.name)
    ? error.name : "unclassified";
  const attempted = error?.transportAttempted === true ? "yes"
    : error?.transportAttempted === false ? "no" : "unverified";
  const fields = [
    "hermes_adapter_failure",
    `error_class=${errorClass}`,
    `cause_class=${["none", "AbortError", "TypeError", "Error", "SyntaxError", "FetchError", "ConnectTimeoutError"]
      .includes(error?.remoteCauseClass) ? error.remoteCauseClass : "unclassified"}`,
    `error_code=${errorCode}`,
    "target_provider=openrouter",
    "target_model=cohere/north-mini-code:free",
    `phase=${phase}`,
    `remote_attempted=${attempted}`,
  ];
  const status = Number.isInteger(error?.remoteHttpStatus)
      && error.remoteHttpStatus >= 100 && error.remoteHttpStatus <= 599
    ? error.remoteHttpStatus : null;
  if (status !== null) fields.push(`http_status=${status}`);
  const finishReason = ["stop", "length", "end_turn", "tool_calls", "function_call", "content_filter", "error", "unknown"]
    .includes(error?.remoteFinishReason) ? error.remoteFinishReason : null;
  if (finishReason) fields.push(`finish_reason=${finishReason}`);
  const adapterUsage = error?.remoteUsage && typeof error.remoteUsage === "object"
    ? error.remoteUsage : {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    const value = adapterUsage[key];
    if (Number.isSafeInteger(value) && value >= 0) fields.push(`${key}=${value}`);
  }
  const summary = fields.join("; ");
  return safeHermesExitDiagnostic(summary) ? summary : null;
}

/** Return only bounded process/one-shot fields suitable for operational logs. */
export function safeHermesFailureSummary(error) {
  const code = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
    ? `exit_${error.code}` : null;
  const signal = typeof error?.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(error.signal)
    ? `signal_${error.signal}` : null;
  const errorName = safeIdentifier(error?.name) || "unclassified";
  const errorCode = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
    ? `exit_${error.code}` : safeIdentifier(error?.code) || "unrecorded";
  const errorDetail = safeReferenceErrorDetail(error);
  const sourceLocation = safeSourceLocation(error);
  const processOutcome = code || signal
    || (errorCode !== "unrecorded" ? "process_error" : "process_outcome_unrecorded");
  const diagnostic = error?.hermesOneShot === true
      && typeof error.hermesExitDiagnostic === "string"
      && safeHermesExitDiagnostic(error.hermesExitDiagnostic)
    ? error.hermesExitDiagnostic
    : "hermes_one_shot_detail_unavailable";
  return Object.freeze({ processOutcome, errorName, errorCode, errorDetail, sourceLocation, diagnostic });
}

export function formatCommandFailure(error) {
  const exit = Number.isInteger(error?.code) ? `exit ${error.code}`
    : error?.signal ? `signal ${error.signal}` : "command error";
  if (error?.hermesOneShot === true) {
    const safeDiagnostic = typeof error.hermesExitDiagnostic === "string" && error.hermesExitDiagnostic
      && safeHermesExitDiagnostic(error.hermesExitDiagnostic)
      ? error.hermesExitDiagnostic : "hermes_oneshot_reason_unavailable";
    return `${exit}: ${safeDiagnostic}`.slice(0, 600);
  }
  const detail = String(error?.stderr || error?.stdout || error?.message || "no diagnostic output")
    .replace(/\s+/g, " ").trim();
  return `${exit}: ${detail}`.slice(0, 600);
}
