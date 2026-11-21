const TASK_PAYLOAD_MARKER = "\n\n[Tarea solicitada]\n";

export function codexIntentMarker(prompt) {
  return String(prompt || "").match(/^\[\[CODEX_INTENT_V1:(read_only|write)\]\]$/m)?.[1] || null;
}

export function codexTaskPayload(prompt) {
  const value = String(prompt || "");
  const offset = value.indexOf(TASK_PAYLOAD_MARKER);
  return offset < 0 ? null : value.slice(offset + TASK_PAYLOAD_MARKER.length).trim();
}

function positiveWriteDirective(payload) {
  const patterns = [
    /\b(?:create|write|edit|modify|change|update|delete|remove|install|deploy|restart|execute|run|fix|repair|patch|refactor|commit|push)\b[\s\S]{0,80}\b(?:file|files|code|source|config|configuration|database|db|service|system|repository|repo|workspace|filesystem|disk)\b/gi,
    /\b(?:crear|escribe?|modifica(?:r|do)?|edita(?:r|do)?|cambia(?:r|do)?|actualiza(?:r|do)?|borra(?:r|do)?|elimina(?:r|do)?|instala(?:r|do)?|despliega(?:r|do)?|reinicia(?:r|do)?|ejecuta(?:r|do)?|arregla(?:r|do)?|repara(?:r|do)?|parcha(?:r|do)?|refactoriza(?:r|do)?|aplica(?:r|do)?|sube|commit)\b[\s\S]{0,80}\b(?:archivo|archivos|c[oó]digo|fuente|config|configuraci[oó]n|base de datos|bd|servicio|sistema|repositorio|workspace|disco|firewall)\b/gi,
  ];
  return patterns.some((pattern) => {
    for (const match of payload.matchAll(pattern)) {
      const before = payload.slice(Math.max(0, match.index - 28), match.index);
      if (!/\b(?:do\s+not|don't|never|no|sin)\s*$/i.test(before)) return true;
    }
    return false;
  });
}

export function codexTaskPolicy(task, status = task?.status, manualOverrideAuthorized = false) {
  const manualOrigin = manualOverrideAuthorized === true && ["web", "max"].includes(task?.origin);
  if (!task || (task.origin !== "max" && !manualOrigin)) return { eligible: false, reason: "origin_not_max_or_manual" };
  const intent = codexIntentMarker(task.prompt);
  const payload = codexTaskPayload(task.prompt);
  if (!payload) return { eligible: false, reason: "task_payload_missing" };
  if (task.kind === "codex.audit") {
    if (!["queued", "approved"].includes(status)) return { eligible: false, reason: "audit_not_queueable" };
    if (task.sideEffecting !== false) return { eligible: false, reason: "audit_marked_side_effecting" };
    if (task.action !== "audit" || task.capability !== "read_only") return { eligible: false, reason: "audit_capability_not_allowlisted" };
    if (intent !== "read_only") return { eligible: false, reason: "audit_intent_missing" };
    if (positiveWriteDirective(payload)) return { eligible: false, reason: "read_only_intent_conflicts_with_payload" };
    return { eligible: true, intent: "read_only", reason: null };
  }
  if (task.kind === "codex.change") {
    if (status !== "approved") return { eligible: false, reason: "change_requires_approval" };
    if (task.sideEffecting !== true) return { eligible: false, reason: "change_not_marked_side_effecting" };
    if (task.action !== "engineering_change" || task.capability !== "privileged") return { eligible: false, reason: "change_capability_not_allowlisted" };
    if (intent !== "write") return { eligible: false, reason: "change_intent_missing" };
    return { eligible: true, intent: "write", reason: null };
  }
  return { eligible: false, reason: "task_kind_not_allowlisted" };
}
