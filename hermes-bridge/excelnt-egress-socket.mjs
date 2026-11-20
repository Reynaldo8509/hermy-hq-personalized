import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const SOCKET_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 65_536;
const ROUTE_ALIASES = new Set([
  "excelnt-code-fast", "excelnt-code-balanced", "excelnt-code-reasoning",
]);
const MAX_KINDS = new Set(["max.chief-of-staff", "max.deep-analysis"]);
const MAX_PRIVACY_CLASSES = new Set(["PUBLIC", "SANITIZED", "REMOTE_FREE_ALLOWED", "PREFER_LOCAL"]);
const MAX_COMPLEXITY_CLASSES = new Set(["COMPLEX", "CRITICAL"]);

function denied(code) {
  return Object.assign(new Error(code), { code, outcome: "REJECTED_PRE_SEND" });
}

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw denied("egress_unicode_invalid");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw denied("egress_unicode_invalid");
    }
  }
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw denied("egress_number_invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    for (const key of keys) assertUnicodeScalarString(key);
    keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw denied("egress_payload_invalid");
}

function sendSocketOperation({ socketPath, connectImpl, timeoutMs }, operation, fields) {
  if (!socketPath || typeof socketPath !== "string" || !socketPath.startsWith("/")) {
    return Promise.reject(denied("egress_socket_unconfigured"));
  }
  let payload;
  try {
    payload = Buffer.from(canonicalJson({ protocol_version: SOCKET_PROTOCOL_VERSION, operation, ...fields }), "utf8");
  } catch (error) {
    return Promise.reject(error);
  }
  if (payload.length > MAX_FRAME_BYTES) return Promise.reject(denied("request_too_large"));
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);

  return new Promise((resolve, reject) => {
    let socket;
    let sent = false;
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      fn(value);
    };
    const fail = (code, outcome = sent ? "UNKNOWN_AFTER_SEND" : "FAILED_PROVEN_NOT_SENT") => {
      finish(reject, Object.assign(new Error(code), { code, outcome }));
    };
    const timer = setTimeout(() => fail("egress_socket_timeout"), timeoutMs);
    timer.unref?.();
    try {
      socket = connectImpl({ path: socketPath });
    } catch {
      fail("egress_socket_unavailable", "FAILED_PROVEN_NOT_SENT");
      return;
    }
    socket.once("connect", () => {
      sent = true;
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES + 4) return fail("egress_response_too_large");
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 2 || length > MAX_RESPONSE_BYTES) return fail("egress_response_invalid");
      if (buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")); }
      catch { return fail("egress_response_invalid"); }
      if (!message || typeof message !== "object" || Array.isArray(message)
          || message.protocol_version !== SOCKET_PROTOCOL_VERSION) {
        return fail("egress_protocol_version_unsupported");
      }
      if (message.ok === true && message.result && typeof message.result === "object") {
        finish(resolve, message.result);
        return;
      }
      const error = message?.error && typeof message.error === "object" ? message.error : {};
      finish(reject, Object.assign(new Error(String(error.code || "egress_request_denied")), {
        code: String(error.code || "egress_request_denied"),
        outcome: String(error.outcome || "UNKNOWN_AFTER_SEND"),
        providerClass: String(error.provider_class || ""),
        statusCode: Number.isInteger(error.status_code) ? error.status_code : null,
      }));
    });
    socket.once("error", () => fail("egress_socket_unavailable"));
    socket.once("close", () => {
      if (!settled) fail("egress_response_incomplete");
    });
  });
}

function socketConfig({ socketPath, connectImpl = createConnection, timeoutMs = 90_000 } = {}) {
  return { socketPath, connectImpl, timeoutMs };
}

export function createBridgeEgressAuthorizationProbe(options = {}) {
  const client = socketConfig({ ...options, timeoutMs: options.timeoutMs ?? 2_500 });
  const onDiagnosticId = typeof options.onDiagnosticId === "function"
    ? options.onDiagnosticId : null;
  return async function authorizeBridgeEgress() {
    const diagnosticId = randomUUID();
    onDiagnosticId?.(diagnosticId);
    const result = await sendSocketOperation(client, "authorize_only", {
      diagnostic_id: diagnosticId,
    });
    const expectedKeys = [
      "budget_reserved", "diagnostic_id", "identity_scope", "ledger_written",
      "peer_authenticated", "provider_contacted", "task_authorized", "task_created",
    ].sort();
    if (Object.keys(result).sort().join("\0") !== expectedKeys.join("\0")
        || result.diagnostic_id !== diagnosticId
        || result.identity_scope !== "bridge_service"
        || result.peer_authenticated !== true
        || result.task_authorized !== false
        || result.task_created !== false
        || result.ledger_written !== false
        || result.budget_reserved !== false
        || result.provider_contacted !== false) {
      throw Object.assign(new Error("egress_authorization_response_invalid"), {
        code: "egress_authorization_response_invalid",
        outcome: "UNKNOWN_AFTER_SEND",
      });
    }
    return {
      status: "AUTHORIZED",
      identityScope: "bridge_service",
      diagnosticId,
      taskAuthorized: false,
    };
  };
}

export function isMaxExcelntCandidate({ request, complexityClass, privacyClass,
  securityDisabled }) {
  return Boolean(request
    && MAX_KINDS.has(request.kind)
    // Only the HQ MAX chat route writes origin=max. Generic dispatch can choose
    // a MAX kind, so the queue kind alone is not an authenticated MAX identity.
    && request.origin === "max"
    && MAX_COMPLEXITY_CLASSES.has(complexityClass)
    && request.capability === "read_only"
    && request.sideEffecting === false
    && !(Array.isArray(request.attachments) && request.attachments.length > 0)
    && securityDisabled === false
    && MAX_PRIVACY_CLASSES.has(privacyClass));
}

export function createMaxRuntimeContextResolver(readRuntimeContext) {
  if (typeof readRuntimeContext !== "function") throw new TypeError("max_runtime_resolver_invalid");
  return function resolveTrustedMaxContext(request) {
    const runtime = readRuntimeContext();
    const routing = runtime?.routingContext;
    if (!request || !MAX_KINDS.has(request.kind) || request.origin !== "max"
        || runtime?.activeAgentId !== "max"
        || routing?.request !== request || routing.maxExcelntCandidate !== true) return null;
    return {
      agentIdentity: "max", taskId: runtime.activeRequestId, requestId: runtime.activeRequestId,
      complexity: routing.complexityClass, privacyClass: routing.privacyClass,
    };
  };
}

export function createMaxExcelntTaskRegistrar(options = {}) {
  const client = socketConfig(options);
  const resolveTrustedContext = options.resolveTrustedContext;
  return async function registerMaxExcelntTask(request) {
    if (!request || !MAX_KINDS.has(request.kind)) throw denied("max_identity_required");
    const context = typeof resolveTrustedContext === "function"
      ? resolveTrustedContext(request) : null;
    if (!context || context.agentIdentity !== "max") throw denied("max_identity_required");
    const rowId = typeof request.id === "string" ? request.id : "";
    const taskId = context.taskId;
    const requestId = context.requestId;
    const complexity = context.complexity;
    const privacyClass = context.privacyClass;
    if (!rowId || taskId !== rowId || requestId !== rowId) {
      throw denied("max_task_request_binding_mismatch");
    }
    if (!MAX_COMPLEXITY_CLASSES.has(complexity) || !MAX_PRIVACY_CLASSES.has(privacyClass)) {
      throw denied("max_task_registration_denied");
    }
    const result = await sendSocketOperation(client, "register_max_task", {
      task_id: taskId, request_id: requestId, complexity, privacy_class: privacyClass,
    });
    const expiresAt = Date.parse(result.expires_at);
    const now = Date.now();
    if (typeof result.capability !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(result.capability)
        || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 610_000
        || !Number.isInteger(result.max_calls) || result.max_calls < 1 || result.max_calls > 2
        || !Array.isArray(result.eligible_route_aliases) || result.eligible_route_aliases.length === 0
        || result.eligible_route_aliases.some((alias) => !ROUTE_ALIASES.has(alias))) {
      throw denied("max_grant_response_invalid");
    }
    return result;
  };
}


/** Execute one server-authorized MAX completion directly through the egress daemon.
 * No Hermes/Qwen planner is involved; the daemon still authenticates this Bridge
 * process and enforces the signed task grant, model, billing and budget policy.
 */
export function createMaxExcelntTaskExecutor(options = {}) {
  const client = socketConfig(options);
  return async function executeMaxExcelntTask({ capability, routeAlias, taskPacket,
    maxOutputTokens = 256, escalationReason = "COMPLEXITY_ESCALATION" } = {}) {
    if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(capability)) {
      throw denied("max_task_capability_invalid");
    }
    if (!ROUTE_ALIASES.has(routeAlias)) throw denied("socket_route_denied");
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256) {
      throw denied("max_output_tokens_budget_denied");
    }
    if (escalationReason !== "COMPLEXITY_ESCALATION") {
      throw denied("max_escalation_reason_denied");
    }
    if (!taskPacket || typeof taskPacket !== "object" || Array.isArray(taskPacket)) {
      throw denied("task_packet_invalid");
    }
    const result = await sendSocketOperation(client, "execute_max_task", {
      capability, route_alias: routeAlias, task_packet: taskPacket,
      max_output_tokens: maxOutputTokens, escalation_reason: escalationReason,
    });
    const usage = result?.usage;
    if (result?.outcome !== "COMPLETE" || result?.provider !== "excelnt"
        || result?.model !== "gpt-6-luna" || result?.actual_model !== "gpt-6-luna"
        || typeof result?.text !== "string" || !result.text.trim()
        || result?.usage_status !== "PRESENT"
        || !usage || usage.status !== "PRESENT"
        || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0
        || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0
        || typeof result?.budget_reservation_id !== "string" || !result.budget_reservation_id
        || typeof result?.estimated_max_cost_usd !== "string"
        || typeof result?.budget_charged_usd !== "string") {
      throw Object.assign(new Error("max_completion_accounting_unverified"), {
        code: "max_completion_accounting_unverified", outcome: "UNKNOWN_AFTER_SEND",
      });
    }
    return result;
  };
}
