export const DOMUS_READ_ENTITY_OPERATION = "domus.read_entity_state";
export const DOMUS_READ_ENTITY_ALLOWLIST = Object.freeze(new Set(["device_tracker.x1"]));
const VISIBLE_STATES = new Set(["home", "not_home", "unknown", "unavailable"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const ALLOWED_FAILURES = new Set([
  "DOMUS_OPERATION_UNAUTHORIZED", "DOMUS_PRIVACY_NOT_LOCAL_ONLY", "DOMUS_ENTITY_NOT_ALLOWED",
  "DOMUS_CREDENTIALS_UNAVAILABLE", "DOMUS_HA_URL_INVALID",
  "DOMUS_HA_UNAUTHORIZED", "DOMUS_ENTITY_NOT_FOUND", "DOMUS_HA_HTTP_ERROR",
  "DOMUS_HA_TIMEOUT", "DOMUS_HA_NETWORK_ERROR", "DOMUS_HA_RESPONSE_INVALID",
  "DOMUS_HA_RESPONSE_TOO_LARGE",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function hasDomusReadEntityMarker(request) {
  return request?.kind === "domus.home"
    && String(request.prompt || "").includes(DOMUS_READ_ENTITY_OPERATION);
}

export function buildDomusExecutionTelemetry({ requestId, privacyClass, state, category = null, durationMs = 0 } = {}) {
  return {
    requestId: String(requestId || "").slice(0, 128),
    operation: DOMUS_READ_ENTITY_OPERATION,
    executor: "bridge.home_assistant.read_only",
    privacyClass: String(privacyClass || "unknown").slice(0, 32),
    privacyDecision: "local_only_direct_read",
    taskId: null,
    subprocessStarted: false,
    exitCode: null,
    signal: null,
    category: category && ALLOWED_FAILURES.has(category) ? category : null,
    state: ["running", "done", "failed"].includes(state) ? state : "unknown",
    durationMs: Math.max(0, Math.min(Number(durationMs) || 0, 300_000)),
  };
}

export function isAuthorizedDomusReadEntityRequest(request, privacyClass) {
  try {
    parseOperation(request, privacyClass);
    return true;
  } catch {
    return false;
  }
}

function parseOperation(request, privacyClass) {
  if (privacyClass !== "LOCAL_ONLY") throw fail("DOMUS_PRIVACY_NOT_LOCAL_ONLY");
  if (request?.kind !== "domus.home"
      || request.origin !== "web"
      || request.action !== "review"
      || request.capability !== "read_only"
      || request.sideEffecting !== false
      || (Array.isArray(request.attachments) && request.attachments.length > 0)) {
    throw fail("DOMUS_OPERATION_UNAUTHORIZED");
  }
  let input;
  try { input = JSON.parse(String(request.prompt || "")); }
  catch { throw fail("DOMUS_OPERATION_UNAUTHORIZED"); }
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).sort().join(",") !== "entity_id,operation"
      || input.operation !== DOMUS_READ_ENTITY_OPERATION
      || typeof input.entity_id !== "string") {
    throw fail("DOMUS_OPERATION_UNAUTHORIZED");
  }
  if (!DOMUS_READ_ENTITY_ALLOWLIST.has(input.entity_id)) throw fail("DOMUS_ENTITY_NOT_ALLOWED");
  return input.entity_id;
}

function buildStateUrl(baseUrl, entityId) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw fail("DOMUS_HA_URL_INVALID"); }
  if (!new Set(["http:", "https:"]).has(base.protocol)
      || base.username || base.password || base.search || base.hash) {
    throw fail("DOMUS_HA_URL_INVALID");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${prefix}/api/states/${encodeURIComponent(entityId)}`, base.origin);
  if (url.search || url.hash) throw fail("DOMUS_HA_URL_INVALID");
  return url;
}

async function readBoundedText(response) {
  if (!response.body?.getReader) throw fail("DOMUS_HA_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail("DOMUS_HA_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code?.startsWith("DOMUS_")) throw error;
    throw fail("DOMUS_HA_RESPONSE_INVALID");
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function readDomusEntityState({
  request,
  privacyClass,
  baseUrl = process.env.HASS_URL,
  token = process.env.HASS_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const entityId = parseOperation(request, privacyClass);
  if (typeof baseUrl !== "string" || !baseUrl.trim() || typeof token !== "string" || !token.trim()) {
    throw fail("DOMUS_CREDENTIALS_UNAVAILABLE");
  }
  const url = buildStateUrl(baseUrl, entityId);
  if (typeof fetchImpl !== "function") throw fail("DOMUS_HA_NETWORK_ERROR");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 15_000)));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw fail("DOMUS_HA_UNAUTHORIZED");
    if (response.status === 404) throw fail("DOMUS_ENTITY_NOT_FOUND");
    if (!response.ok) throw fail("DOMUS_HA_HTTP_ERROR");
    const text = await readBoundedText(response);
    let body;
    try { body = JSON.parse(text); }
    catch { throw fail("DOMUS_HA_RESPONSE_INVALID"); }
    if (!body || body.entity_id !== entityId || typeof body.state !== "string" || !body.state.trim()) {
      throw fail("DOMUS_HA_RESPONSE_INVALID");
    }
    const normalized = body.state.trim().toLowerCase();
    return {
      operation: DOMUS_READ_ENTITY_OPERATION,
      entity_id: entityId,
      state: VISIBLE_STATES.has(normalized) ? normalized : "other",
      source: "Home Assistant",
      observed_at: new Date(now()).toISOString(),
    };
  } catch (error) {
    if (error?.code?.startsWith("DOMUS_")) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") throw fail("DOMUS_HA_TIMEOUT");
    throw fail("DOMUS_HA_NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}
