import { createHash } from "node:crypto";

export const AGENT_IDS = Object.freeze(["max", "codex", "atlas", "aegis", "ledger", "milo", "pulse", "domus"]);

const TASK_TARGETS = Object.freeze({
  max: { label: "MAX", kind: "max.chief-of-staff", mandatoryApproval: false },
  codex: { label: "CODEX · mediante MAX", kind: "max.chief-of-staff", mandatoryApproval: false },
  atlas: { label: "ATLAS", kind: "atlas.research", mandatoryApproval: false },
  aegis: { label: "AEGIS", kind: "aegis.security", mandatoryApproval: true },
  ledger: { label: "LEDGER", kind: "ledger.operations", mandatoryApproval: true },
  milo: { label: "MILO", kind: "milo.email", mandatoryApproval: true },
  pulse: { label: "PULSE", kind: "pulse.social", mandatoryApproval: true },
  domus: { label: "DOMUS", kind: "domus.home", mandatoryApproval: true },
});

export function buildTaskRequest(agentId, title, prompt, requiresApproval = false, dependencies = []) {
  const target = TASK_TARGETS[agentId];
  const cleanTitle = String(title || "").trim().slice(0, 200);
  const cleanPrompt = String(prompt || "").trim().slice(0, 12000);
  const ids = [...new Set((Array.isArray(dependencies) ? dependencies : []).map((id) => String(id).trim()).filter(Boolean))];
  if (!target) throw new Error("Agente desconocido");
  if (!cleanTitle || !cleanPrompt) throw new Error("Indica un título y una descripción");
  if (ids.length > 10) throw new Error("Una tarea puede depender de hasta 10 tareas");
  if (ids.some((id) => id.length > 100)) throw new Error("ID de dependencia no válido");

  const codexPrompt = agentId === "codex"
    ? "Solicitud del usuario para CODEX. MAX debe evaluar y delegar solo si corresponde; el worker CODEX solo acepta una delegación justificada de MAX. No ejecutes acciones privilegiadas sin su aprobación aplicable.\n\n" + cleanPrompt
    : cleanPrompt;
  const titlePrefix = agentId === "codex" ? "CODEX → MAX" : target.label;
  return {
    origin: "web",
    kind: target.kind,
    title: (titlePrefix + " · " + cleanTitle).slice(0, 200),
    prompt: codexPrompt,
    sideEffecting: target.mandatoryApproval || Boolean(requiresApproval),
    status: target.mandatoryApproval || Boolean(requiresApproval) ? "awaiting_approval" : "queued",
    dependsOn: ids,
    requestedAgent: agentId,
  };
}

export function agentForKind(kind, origin = "") {
  const value = String(kind || "").toLowerCase();
  if (value.startsWith("codex.")) return "codex";
  if (value.startsWith("max.")) return origin === "codex" ? "codex" : "max";
  if (value.startsWith("atlas.")) return "atlas";
  if (value.startsWith("aegis.")) return "aegis";
  if (value.startsWith("ledger.")) return "ledger";
  if (value.startsWith("milo.")) return "milo";
  if (value.startsWith("pulse.") || value === "video.youtube.analyze") return "pulse";
  if (value.startsWith("domus.")) return "domus";
  return "max";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function approvalParameters(request) {
  const base = {
    requestId: String(request.id || ""),
    origin: String(request.origin || ""),
    kind: String(request.kind || ""),
    title: String(request.title || ""),
    prompt: request.prompt == null ? null : String(request.prompt),
    sideEffecting: Boolean(request.sideEffecting),
    action: request.action == null ? null : String(request.action),
    capability: request.capability == null ? null : String(request.capability),
    dependencies: [...new Set((request.dependsOn || request.dependencies || []).map(String))].sort(),
  };
  const contractVersion = Number(request.contractVersion || 1);
  if (contractVersion < 2) return base;
  return {
    ...base,
    contractVersion,
    executionMode: request.executionMode == null ? null : String(request.executionMode),
    scope: request.scope ?? null,
    privacyClass: request.privacyClass == null ? null : String(request.privacyClass),
    requestedBy: request.requestedBy == null ? null : String(request.requestedBy),
    authSource: request.authSource == null ? null : String(request.authSource),
    riskReasons: [...new Set((request.riskReasons || []).map(String))].sort(),
  };
}

export function approvalMatches(approval, request) {
  if (!approval || !request || !approval.parameters_snapshot) return false;
  const snapshotVersion = Number(approval.parameters_snapshot.contractVersion || 1);
  const requestVersion = Number(request.contractVersion || 1);
  if (snapshotVersion !== requestVersion) return false;
  return stableJson(approval.parameters_snapshot) === stableJson(approvalParameters(request));
}

export function approvalIsFresh(approval, now = Date.now()) {
  if (!approval || approval.status !== "pending") return false;
  const expiry = new Date(approval.expires_at || approval.expiresAt || 0).getTime();
  return Number.isFinite(expiry) && expiry > now;
}

export function approvalTransition(approval, decision, now = Date.now()) {
  if (!approval) return { ok: false, status: 404, error: "Solicitud de aprobación no encontrada" };
  const wanted = decision === "approve" ? "approved" : "rejected";
  if (approval.status === wanted) return { ok: true, status: wanted, duplicate: true };
  if (approval.status !== "pending") return { ok: false, status: 409, error: "La aprobación ya no está pendiente" };
  if (!approvalIsFresh(approval, now)) return { ok: false, status: 409, error: "La aprobación ha caducado", expired: true };
  return { ok: true, status: wanted, duplicate: false };
}

export function taskActionAllowed(action, status, sideEffecting, retryCount = 0) {
  if (action === "cancel") {
    return ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation"].includes(status);
  }
  if (action === "retry") {
    return status === "failed" && !sideEffecting && retryCount < 2;
  }
  if (action === "assign") {
    return status === "queued" && !sideEffecting;
  }
  return false;
}

export function dependenciesAreDone(dependencies, requestById) {
  return (dependencies || []).every((id) => requestById.get(String(id))?.status === "done");
}

export function incidentResolutionError(evidence, validation) {
  const observed = String(evidence || "").trim();
  const proof = String(validation || "").trim();
  if (observed.length < 30) return "Agrega al menos 30 caracteres de evidencia observable.";
  if (proof.length < 20) return "Describe la validación realizada antes de cerrar.";
  return null;
}

export function groupIncidentRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = String(row.fingerprint || ("sin-fingerprint:" + row.id));
    if (!groups.has(key)) groups.set(key, { fingerprint: key, incident: row.incident, latest: row, occurrences: 0, records: [] });
    const group = groups.get(key);
    group.occurrences += 1;
    group.records.push(row);
    if (new Date(row.updated_at || row.updatedAt || 0) > new Date(group.latest.updated_at || group.latest.updatedAt || 0)) {
      group.latest = row;
      group.incident = row.incident;
    }
  }
  return [...groups.values()].sort((a, b) => new Date(b.latest.updated_at || b.latest.updatedAt || 0) - new Date(a.latest.updated_at || a.latest.updatedAt || 0));
}

export function isAllowlistedActor(email, allowlist) {
  const normalized = String(email || "").trim().toLowerCase();
  const allowed = String(allowlist || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return Boolean(normalized && allowed.includes(normalized));
}

export function sameRequestPayload(existing, payload) {
  return stableJson({
    origin: existing.origin, kind: existing.kind, title: existing.title,
    prompt: existing.prompt, sideEffecting: existing.sideEffecting,
    action: existing.action ?? null, capability: existing.capability ?? null,
    dependsOn: existing.dependsOn || [],
    contractVersion: Number(existing.contractVersion || 1), executionMode: existing.executionMode ?? null,
    scope: existing.scope ?? null, privacyClass: existing.privacyClass ?? null,
    requestedBy: existing.requestedBy ?? null, authSource: existing.authSource ?? null,
    riskReasons: existing.riskReasons || [],
  }) === stableJson({
    origin: payload.origin, kind: payload.kind, title: payload.title,
    prompt: payload.prompt, sideEffecting: payload.sideEffecting,
    action: payload.action ?? null, capability: payload.capability ?? null,
    dependsOn: payload.dependsOn || [],
    contractVersion: Number(payload.contractVersion || 1), executionMode: payload.executionMode ?? null,
    scope: payload.scope ?? null, privacyClass: payload.privacyClass ?? null,
    requestedBy: payload.requestedBy ?? null, authSource: payload.authSource ?? null,
    riskReasons: payload.riskReasons || [],
  });
}

export function approvalDigest(request) {
  return createHash("sha256").update(stableJson(approvalParameters(request))).digest("hex");
}
