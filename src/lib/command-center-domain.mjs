const HEALTH_FRESH_MS = 5 * 60 * 1000;
const INFRASTRUCTURE_FRESH_MS = 45 * 60 * 1000;
const SAFE_DISPATCH_OPERATIONS = new Map([
  ["max.chief-of-staff", new Set(["coordinate:read_only"])],
  ["aegis.security", new Set(["audit:read_only"])],
  ["atlas.research", new Set(["research:read_only"])],
  ["pulse.social", new Set(["strategy:read_only"])],
  ["ledger.operations", new Set(["audit:read_only"])],
  ["domus.home", new Set(["review:read_only"])],
  ["milo.email", new Set(["triage:read_only"])],
  ["codex.audit", new Set(["audit:read_only"])],
  ["video.youtube.analyze", new Set(["analyze_video:read_only"])],
]);
const APPROVAL_REQUIRED_KINDS = new Set(["aegis.security"]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, limit = 120) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

export function readingFreshness(timestamp, now = Date.now(), maxAgeMs = INFRASTRUCTURE_FRESH_MS) {
  if (typeof timestamp !== "string" || !timestamp.trim()) return "unknown";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed > now + 60_000) return "unknown";
  return now - parsed <= maxAgeMs ? "fresh" : "stale";
}

export function normalizeOperationalSnapshot({ health, infrastructure, now = Date.now() }) {
  const healthData = objectValue(health);
  const infrastructureData = objectValue(infrastructure);
  const healthAt = text(healthData.lastSeen, 80);
  const healthFreshness = readingFreshness(healthAt, now, HEALTH_FRESH_MS);
  const hermesStatus = healthFreshness === "stale"
    ? "stale"
    : healthFreshness === "unknown"
      ? "unknown"
      : healthData.online === true ? "online" : "offline";

  const collectedAt = text(infrastructureData.collectedAt, 80);
  const infrastructureFreshness = readingFreshness(collectedAt, now);
  const nodes = objectValue(infrastructureData.nodes);
  const vps = objectValue(nodes.vps);
  const dell = objectValue(nodes["dell-g15"]);
  const services = Array.isArray(vps.services) ? vps.services.slice(0, 40).map((service) => {
    const value = objectValue(service);
    return { unit: text(value.unit, 120) || "Servicio sin nombre", state: text(value.state, 40) || "unknown" };
  }) : [];
  const qwen = objectValue(dell.qwen);
  const qwenAt = text(qwen.checkedAt || qwen.lastKnownModelReadAt || collectedAt, 80);
  const qwenFreshness = readingFreshness(qwenAt, now);
  const modelIds = Array.isArray(qwen.modelIds) && qwen.modelIds.length
    ? qwen.modelIds
    : Array.isArray(qwen.lastKnownModelIds) ? qwen.lastKnownModelIds : [];

  return {
    hermes: {
      status: hermesStatus,
      gateway: text(healthData.gateway, 80) || "unknown",
      lastSeen: healthAt,
      freshness: healthFreshness,
    },
    infrastructure: {
      collectedAt,
      freshness: infrastructureFreshness,
      services,
      failingServices: infrastructureFreshness === "fresh" && services.length ? services.filter((service) => service.state !== "active").length : null,
      qwen: {
        status: qwenFreshness === "fresh" ? text(qwen.status, 40) || "unknown" : qwenFreshness,
        freshness: qwenFreshness,
        checkedAt: qwenAt,
        latencyMs: qwen.latencyMs !== null && qwen.latencyMs !== undefined && Number.isFinite(Number(qwen.latencyMs)) ? Number(qwen.latencyMs) : null,
        modelIds: modelIds.map((model) => text(model, 120)).filter(Boolean).slice(0, 5),
      },
    },
  };
}

export function summarizeRequestCounts(rows) {
  return Object.fromEntries((rows || []).map((row) => [String(row.status), Number(row.count) || 0]));
}

export function commandRequiresApproval(prompt) {
  return /\b(post|tweet|send|dm|message|reply|email|buy|purchase|order|pay|transfer|withdraw|deposit|trade|delete|remove|publish|schedule|book|cancel|unsubscribe|restart|reboot|shutdown|start|stop|enable|disable|deploy|install|uninstall|modify|change|update|upgrade|write|edit|execute|run|kill|sudo|root|fix|repair|restore|recover|patch|commit|push|enviar|mandar|publicar|responder|comprar|pagar|transferir|retirar|depositar|operar|borrar|eliminar|programar|reservar|cancelar|dar de baja|reiniciar|reinicia|reinicie|apagar|apaga|detener|parar|iniciar|inicia|arrancar|habilitar|deshabilitar|desplegar|instalar|desinstalar|configurar|modificar|modifica|cambiar|cambia|actualizar|actualiza|escribir|editar|ejecutar|ejecuta|matar|arreglar|reparar|restaurar|recuperar|parchear|confirmar|aplicar|elimina|borra)\b/i.test(String(prompt || ""));
}

export function safeReadOnlyOperation(kind) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const operation = SAFE_DISPATCH_OPERATIONS.get(normalizedKind)?.values().next().value;
  if (!operation) return null;
  const separator = operation.indexOf(":");
  return { action: operation.slice(0, separator), capability: operation.slice(separator + 1) };
}

function hasDirectSideEffectCommand(prompt) {
  const clauses = String(prompt || "").split(/[\n.!?;]+/);
  const directCommand = /^(?:(?:please|por favor|could you|can you|would you|need to|have to|podrias|podrías|podria|podría)\s+)*(?:restart|reboot|deploy|delete|remove|write|edit|modify|change|update|upgrade|configure|fix|repair|restore|recover|patch|commit|push|install|uninstall|cancel|send|publish|execute|run|kill|shutdown|enable|disable|start|stop|reinicia|reiniciar|reinicie|reinicien|despliega|desplegar|edita|editar|modifica|modificar|configura|configurar|arregla|arreglar|repara|reparar|restaura|restaurar|actualiza|actualizar|cambia|cambiar|habilita|habilitar|deshabilita|deshabilitar|inicia|iniciar|deten|detener|apaga|apagar|borra|borrar|elimina|eliminar|escribe|escribir|cancela|cancelar|envia|envía|publica|publicar|ejecuta|ejecutar|aplica|aplicar)\b/i;
  return clauses.some((clause) => {
    const value = clause.trim().replace(/^[¿¡]+\s*/, "");
    if (!value) return false;
    if (/^(?:no|please do not|do not|don't|never|must not)\b/i.test(value)) {
      const contrast = value.match(/\b(?:but|however|except|instead|then|rather|pero|excepto|sino)\b/i);
      return contrast ? directCommand.test(value.slice(contrast.index + contrast[0].length).trim()) : false;
    }
    return directCommand.test(value);
  });
}

export function classifyDispatchRequestRisk(options) {
  const { kind, action, capability, clientFlag, prompt, executionMode, actionSideEffecting } = options;
  const omitted = (value) => value === undefined || value === null || value === "";
  // The Hermes dispatch API historically documented kind/title/prompt only.
  // Infer a capability only for an exact registered read-only kind; explicit
  // partial or mismatched capabilities remain fail-closed.
  const inferred = omitted(action) && omitted(capability) ? safeReadOnlyOperation(kind) : null;
  return classifyDispatchRisk({
    kind,
    action: omitted(action) ? inferred?.action : action,
    capability: omitted(capability) ? inferred?.capability : capability,
    clientFlag,
    prompt,
    executionMode,
    actionSideEffecting,
  });
}

export function classifyDispatchRisk(options) {
  const { kind, action, capability, clientFlag, prompt, executionMode, actionSideEffecting } = options;
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedCapability = String(capability || "").trim().toLowerCase();
  const allowed = SAFE_DISPATCH_OPERATIONS.get(normalizedKind);
  const structuredReadOnly = Boolean(allowed?.has(`${normalizedAction}:${normalizedCapability}`));
  const reasons = [];
  if (APPROVAL_REQUIRED_KINDS.has(normalizedKind)) reasons.push("agent_requires_approval");
  const modeProvided = executionMode !== undefined && executionMode !== null && executionMode !== "";
  const normalizedMode = modeProvided ? String(executionMode).trim().toLowerCase() : null;
  if (normalizedKind === "max.chief-of-staff" && !modeProvided) reasons.push("missing_execution_mode");
  if (modeProvided && !["read_only", "side_effecting"].includes(normalizedMode || "")) reasons.push("unknown_execution_mode");
  if (normalizedMode === "side_effecting") reasons.push("explicit_side_effecting_mode");
  if (clientFlag === true) reasons.push("client_requested_approval");
  if (actionSideEffecting === true) reasons.push("effective_action_side_effecting");
  const promptHasSideEffect = normalizedMode === "read_only"
    ? hasDirectSideEffectCommand(prompt)
    : commandRequiresApproval(prompt);
  if (promptHasSideEffect) reasons.push("prompt_requests_side_effect");
  if (!structuredReadOnly) reasons.push("unknown_or_unapproved_operation");
  return {
    requiresApproval: reasons.length > 0,
    reasons,
    kind: normalizedKind,
    action: normalizedAction || null,
    capability: normalizedCapability || null,
  };
}

export function classifyQueueRequestRisk(options) {
  const {
    clientRequestedApproval = false,
    sideEffecting,
    actionSideEffecting,
    ...riskOptions
  } = options;
  return classifyDispatchRisk({
    ...riskOptions,
    clientFlag: clientRequestedApproval === true,
    actionSideEffecting: actionSideEffecting ?? sideEffecting,
  });
}

export function effectiveSideEffecting(clientFlag, prompt) {
  return clientFlag === true || commandRequiresApproval(prompt);
}

export function dispatchConfirmation(httpStatus, payload) {
  const value = objectValue(payload);
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(text(value.error, 240) || `Hermy HQ respondió HTTP ${httpStatus}`);
  }
  const request = objectValue(value.request);
  const id = text(request.id, 120);
  const status = text(request.status, 64);
  if (!id || !status) throw new Error("Hermy HQ no confirmó el estado de la solicitud");
  return { request: { id, status }, duplicate: value.duplicate === true };
}

/** @returns {{ state: "approval" | "running" | "completed" | "failed" | "queued", message: string, href: string }} */
export function dispatchPresentation(request) {
  const status = String(request?.status || "");
  if (status === "awaiting_approval") return { state: "approval", message: "Solicitud registrada y pendiente de aprobación.", href: "/action-center" };
  if (status === "running") return { state: "running", message: "Hermy HQ confirmó que la solicitud está en ejecución.", href: "/tasks" };
  if (status === "done") return { state: "completed", message: "La tarea terminó. Revisa y valida el resultado antes de darla por resuelta.", href: "/tasks" };
  if (["failed", "rejected", "cancelled"].includes(status)) return { state: "failed", message: `La solicitud terminó con estado ${status}. Abre el historial para revisar el resultado.`, href: "/tasks" };
  return { state: "queued", message: `Hermy HQ confirmó el estado ${status || "en cola"}.`, href: status === "approved" ? "/tasks" : "/action-center" };
}
