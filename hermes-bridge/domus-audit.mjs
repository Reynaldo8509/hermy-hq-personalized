const DOMUS_TITLE = "Domus · auditoría de hogar e integraciones";
const DOMUS_PROMPT_PREFIX = "Auditoría periódica de solo lectura y baja verbosidad.";
const AUTOMATION_TEMPLATE = `{% set ns = namespace(total=0, unavailable=0, unknown=0) %}
{% for entity in states.automation %}
  {% set ns.total = ns.total + 1 %}
  {% if entity.state == 'unavailable' %}{% set ns.unavailable = ns.unavailable + 1 %}{% endif %}
  {% if entity.state == 'unknown' %}{% set ns.unknown = ns.unknown + 1 %}{% endif %}
{% endfor %}
{{ {'total': ns.total, 'unavailable': ns.unavailable, 'unknown': ns.unknown} | to_json }}`;

export function isScheduledDomusAuditShape(request) {
  return request?.kind === "domus.home"
    && request?.origin === "system"
    && request?.sideEffecting === false
    && request?.title === DOMUS_TITLE
    && String(request?.prompt || "").startsWith(DOMUS_PROMPT_PREFIX);
}

export function isScheduledDomusAudit(request, schedulerProvenance = null) {
  return schedulerProvenance === "domus" && isScheduledDomusAuditShape(request);
}

function parseJsonObject(text, maxBytes = 128 * 1024) {
  if (Buffer.byteLength(text) > maxBytes) throw new Error("response_too_large");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json_shape");
  return value;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

async function request(fetchImpl, url, token, method = "GET", body, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
}

function failureCode(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  if (error?.code && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  return "request_failed";
}

export async function runScheduledDomusAudit({
  fetchImpl = globalThis.fetch,
  baseUrl = process.env.HASS_URL,
  token = process.env.HASS_TOKEN,
  timeoutMs = 4000,
} = {}) {
  const url = safeBaseUrl(String(baseUrl || ""));
  if (!url || !token || typeof fetchImpl !== "function") {
    return "DOMUS_AUDIT=NO_VERIFICADO\nCAUSA=Home Assistant no tiene una URL válida, una credencial disponible en el proceso o fetch compatible.";
  }
  try {
    const api = await request(fetchImpl, `${url}/api/`, token, "GET", undefined, timeoutMs);
    if (!api.ok) return `DOMUS_AUDIT=NO_VERIFICADO\nHOME_ASSISTANT_API=HTTP_${api.status}`;

    const configResponse = await request(fetchImpl, `${url}/api/config`, token, "GET", undefined, timeoutMs);
    if (!configResponse.ok) return `DOMUS_AUDIT=NO_VERIFICADO\nHOME_ASSISTANT_CONFIG=HTTP_${configResponse.status}`;
    const configText = await configResponse.text();
    const config = parseJsonObject(configText);
    if (!Array.isArray(config.components)) return "DOMUS_AUDIT=NO_VERIFICADO\nHOME_ASSISTANT_COMPONENTS=unavailable";
    const components = new Set(config.components.filter(value => typeof value === "string"));
    const alexaComponents = ["alexa", "alexa_media", "alexa_devices"].filter(name => components.has(name));

    const automationResponse = await request(fetchImpl, `${url}/api/template`, token, "POST", { template: AUTOMATION_TEMPLATE }, timeoutMs);
    if (!automationResponse.ok) return `DOMUS_AUDIT=NO_VERIFICADO\nAUTOMATION_SNAPSHOT=HTTP_${automationResponse.status}`;
    const automationText = await automationResponse.text();
    if (Buffer.byteLength(automationText) > 4096) throw new Error("automation_response_too_large");
    const automation = JSON.parse(automationText);
    for (const key of ["total", "unavailable", "unknown"]) {
      if (!Number.isSafeInteger(automation?.[key]) || automation[key] < 0) throw new Error("invalid_automation_snapshot");
    }

    const issues = automation.unavailable + automation.unknown;
    const alexaStatus = alexaComponents.length ? `present(${alexaComponents.join(",")})` : "not_detected";
    return [
      `DOMUS_AUDIT=${issues ? "ATENCION" : "SNAPSHOT_ONLY"}`,
      "HOME_ASSISTANT_API=PASS",
      `ALEXA_COMPONENTS=${alexaStatus}`,
      `AUTOMATIONS_TOTAL=${automation.total}`,
      `AUTOMATIONS_UNAVAILABLE=${automation.unavailable}`,
      `AUTOMATIONS_UNKNOWN=${automation.unknown}`,
      "AUTOMATIONS_OFF=not_classified_as_error",
      "CHANGE_COMPARISON=NO_BASELINE",
      "LIMITES=No se enumeraron entidades de luz ni se ejecutaron servicios. La presencia de un componente Alexa no demuestra su sesión externa; sin baseline no se puede afirmar SIN_NOVEDADES.",
    ].join("\n");
  } catch (error) {
    return `DOMUS_AUDIT=NO_VERIFICADO\nCAUSA=${failureCode(error)}`;
  }
}
