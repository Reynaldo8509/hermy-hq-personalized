import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROFILE_BASE = "http://127.0.0.1:8642/p/max-hq";
const PROFILE_NAME = "max-hq";
const TEXT_ONLY_INSTRUCTIONS = "Responde solo con texto. No tienes herramientas, no ejecutes acciones, no delegues y no afirmes que consultaste sistemas externos. Usa únicamente el contexto entregado.";
export const MAX_EXCELNT_HTTP_TIMEOUT_MS = 10000;
export const MAX_EXCELNT_POLL_INTERVAL_MS = 500;
export const MAX_EXCELNT_RUN_WAIT_MS = 360000;
const EXCELNT_OVERLOAD_CODE = "max_excelnt_upstream_overloaded_http_503";
const EXCELNT_UNKNOWN_CODE = "max_excelnt_run_unknown_after_send";
const EXCELNT_OVERLOAD_MESSAGE = "EXCELNT está sobrecargado (HTTP 503). Inténtalo más tarde";
const EXCELNT_UNKNOWN_MESSAGE = "No se pudo confirmar el resultado de EXCELNT. No se reintentó para evitar duplicar la solicitud.";

function scopeObject(scope) {
  if (typeof scope === "string") {
    try { return JSON.parse(scope); } catch { return {}; }
  }
  return scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
}

export function parseMaxExcelntSelection(request) {
  const scope = scopeObject(request?.scope);
  if (!Object.prototype.hasOwnProperty.call(scope, "maxModelSelection")) return null;
  const value = scope.maxModelSelection;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.provider !== "excelnt" || value.profile !== PROFILE_NAME || value.mode !== "text_only"
      || typeof value.model !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,160}$/.test(value.model)) {
    throw new Error("max_excelnt_selection_invalid");
  }
  return { provider: "excelnt", model: value.model, profile: PROFILE_NAME, mode: "text_only" };
}

export function assertMaxExcelntTextOnlyTask(request, privacyClass) {
  const selection = parseMaxExcelntSelection(request);
  if (!selection) return null;
  if (request?.kind !== "max.chief-of-staff" || request?.origin !== "max"
      || request?.sideEffecting === true || request?.capability !== "read_only"
      || request?.action !== "coordinate" || (Array.isArray(request?.attachments) && request.attachments.length)) {
    throw new Error("max_excelnt_text_only_task_denied");
  }
  if (privacyClass === "LOCAL_ONLY") throw new Error("max_excelnt_local_only_denied");
  return selection;
}

export function extractExcelntModels(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.providers)) throw new Error("hermes_model_options_invalid");
  const provider = payload.providers.find((entry) => entry && typeof entry === "object"
    && entry.slug === "excelnt" && String(entry.name || "").toUpperCase() === "EXCELNT");
  if (!provider || provider.authenticated !== true || !Array.isArray(provider.models)) throw new Error("hermes_excelnt_catalog_unavailable");
  return [...new Set(provider.models.filter((id) => typeof id === "string" && /^[^\s\u0000-\u001f\u007f]{1,160}$/.test(id)))];
}

export function readMaxHermesCredential({ env = process.env, readFile = readFileSync } = {}) {
  if (!env.CREDENTIALS_DIRECTORY) throw new Error("hermes_service_credential_unavailable");
  const token = String(readFile(join(env.CREDENTIALS_DIRECTORY, "max-hq-api-server-key"), "utf8")).trim();
  if (token.length < 16 || /[\r\n\0]/.test(token)) throw new Error("hermes_service_credential_invalid");
  return token;
}

async function fetchJson(fetchImpl, url, options, onHttpStatus = null) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? MAX_EXCELNT_HTTP_TIMEOUT_MS) });
  if (typeof onHttpStatus === "function") onHttpStatus(response.status);
  let body;
  try { body = await response.json(); } catch {
    throw Object.assign(new Error(`hermes_api_invalid_json_${response.status}`), { httpStatus: response.status });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`hermes_api_http_${response.status}`), { httpStatus: response.status });
  }
  return body;
}

function safeDiagnosticValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) ? value : "unknown";
}

function safeErrorCode(value) {
  if (typeof value !== "string") return "unknown_error";
  const match = value.match(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]{2,79})(?=$|[:\s])/);
  return match ? match[1] : "unknown_error";
}

function safeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function upstreamHttpStatus(status) {
  for (const key of ["upstream_http_status", "upstream_status", "http_status"]) {
    const value = safeHttpStatus(status?.[key]);
    if (value !== null) return value;
  }
  const text = typeof status?.error === "string" ? status.error : "";
  const match = text.match(/\b(?:HTTP(?:\/[0-9.]+)?\s+|status(?:_code)?[=: ]+)([45][0-9]{2})\b/i);
  if (match) return Number(match[1]);
  const code = String(status?.error_code || status?.code || "");
  return /\bserver_overloaded\b/i.test(code) ? 503 : null;
}

function classifyUpstreamFailure(status) {
  const httpStatus = upstreamHttpStatus(status);
  if (httpStatus === null) return null;
  const evidence = [status?.error_code, status?.code, status?.error, status?.message]
    .filter((value) => typeof value === "string").join(" ");
  const overloaded = httpStatus === 503
    && /server[_ ]overloaded|high load|overload/i.test(evidence);
  return {
    httpStatus,
    code: overloaded ? EXCELNT_OVERLOAD_CODE : "max_excelnt_upstream_http_" + httpStatus,
  };
}

function errorWithCode(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function maxExcelntPublicFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === EXCELNT_OVERLOAD_CODE) return { code, message: EXCELNT_OVERLOAD_MESSAGE };
  if (/^max_excelnt_upstream_http_[45]\d\d$/.test(code)) {
    const status = Number(code.slice(code.lastIndexOf("_") + 1));
    return { code, message: "EXCELNT devolvió HTTP " + status + ". Inténtalo más tarde." };
  }
  if (code === EXCELNT_UNKNOWN_CODE) return { code, message: EXCELNT_UNKNOWN_MESSAGE };
  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runMaxExcelntTextOnly(request, selection, {
  fetchImpl = fetch, env = process.env, readFile = readFileSync,
  apiBase = env.HERMES_MAX_HQ_API_BASE_URL || PROFILE_BASE,
  timeoutMs = MAX_EXCELNT_HTTP_TIMEOUT_MS,
  pollIntervalMs = MAX_EXCELNT_POLL_INTERVAL_MS,
  maxWaitMs = MAX_EXCELNT_RUN_WAIT_MS,
  onDiagnostic = null,
} = {}) {
  if (!selection || selection.provider !== "excelnt" || selection.profile !== PROFILE_NAME || selection.mode !== "text_only") {
    throw new Error("max_excelnt_selection_invalid");
  }
  if (!request?.id || !/^[A-Za-z0-9._:-]{8,255}$/.test(String(request.id))) throw new Error("max_request_id_invalid");
  const base = new URL(apiBase);
  if (!( ["127.0.0.1", "::1", "localhost"].includes(base.hostname)) || !["http:", "https:"].includes(base.protocol)) {
    throw new Error("hermes_api_must_be_loopback");
  }
  let lastApiHttpStatus = null;
  let diagnosticReported = false;
  const requestJson = (url, options) => {
    lastApiHttpStatus = null;
    return fetchJson(fetchImpl, url, options, (status) => { lastApiHttpStatus = safeHttpStatus(status); });
  };
  const report = (finalStatus, status = {}, explicitErrorCode = null, effectiveRoute = null) => {
    diagnosticReported = true;
    if (typeof onDiagnostic !== "function") return;
    const runtime = status?.runtime && typeof status.runtime === "object" ? status.runtime : {};
    const diagnostic = Object.freeze({
      requestId: String(request.id),
      requestedProvider: "excelnt",
      requestedModel: selection.model,
      effectiveProvider: safeDiagnosticValue(effectiveRoute?.provider || runtime.provider),
      effectiveModel: safeDiagnosticValue(effectiveRoute?.model || runtime.model),
      apiHttpStatus: lastApiHttpStatus,
      upstreamHttpStatus: upstreamHttpStatus(status),
      errorCode: explicitErrorCode ? safeErrorCode(explicitErrorCode) : null,
      finalStatus,
    });
    try { onDiagnostic(diagnostic); } catch { /* diagnostics must not affect task execution */ }
  };
  try {
    const token = readMaxHermesCredential({ env, readFile });
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const apiBaseUrl = apiBase.replace(/\/$/, "");
    const catalog = await requestJson(`${apiBaseUrl}/api/model/options`, { method: "GET", headers, timeoutMs });
    const models = extractExcelntModels(catalog);
    if (!models.includes(selection.model)) throw new Error("max_excelnt_model_not_in_authenticated_catalog");

    let run;
    try {
      run = await requestJson(`${apiBaseUrl}/v1/runs`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": String(request.id) }, timeoutMs,
        body: JSON.stringify({
          input: String(request.prompt || request.title || ""),
          instructions: TEXT_ONLY_INSTRUCTIONS,
          provider: "excelnt",
          model: selection.model,
          model_options: { max_tokens: 512 },
        }),
      });
    } catch (error) {
      if (/^hermes_api_http_\d+$/.test(String(error?.message || ""))) {
        report("failed", {}, error.message);
        throw error;
      }
      report("unknown_after_send", {}, EXCELNT_UNKNOWN_CODE);
      throw errorWithCode(EXCELNT_UNKNOWN_CODE);
    }
    const runId = typeof run.run_id === "string" ? run.run_id : "";
    if (!runId) {
      report("unknown_after_send", {}, EXCELNT_UNKNOWN_CODE);
      throw errorWithCode(EXCELNT_UNKNOWN_CODE);
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      let status;
      try {
        status = await requestJson(`${apiBaseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
          method: "GET", headers, timeoutMs,
        });
      } catch {
        report("unknown_after_send", {}, EXCELNT_UNKNOWN_CODE);
        throw errorWithCode(EXCELNT_UNKNOWN_CODE);
      }
      if (status.status === "completed") {
        if (typeof status.output !== "string") {
          report("failed", status, "hermes_api_run_output_missing");
          throw new Error("hermes_api_run_output_missing");
        }
        report("completed", status);
        return status.output;
      }
      if (["failed", "cancelled", "interrupted", "rejected"].includes(status.status)) {
        const upstreamFailure = classifyUpstreamFailure(status);
        if (upstreamFailure) {
          report(status.status, status, upstreamFailure.code,
            { provider: "excelnt", model: selection.model });
          throw errorWithCode(upstreamFailure.code);
        }
        const errorCode = safeErrorCode(status.error_code || status.code || status.error || "hermes_api_run_" + status.status);
        report(status.status, status, errorCode);
        throw new Error("hermes_api_run_" + status.status + ":" + errorCode);
      }
      await delay(pollIntervalMs);
    }
    report("unknown_after_send", {}, EXCELNT_UNKNOWN_CODE);
    throw errorWithCode(EXCELNT_UNKNOWN_CODE);
  } catch (error) {
    if (!diagnosticReported) report("failed", {}, error?.message || "unknown_error");
    throw error;
  }
}
