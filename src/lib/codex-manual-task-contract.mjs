export function codexManualTaskPayload({ mode, title, prompt }) {
  if (mode !== "audit" && mode !== "change") {
    throw new TypeError("Codex manual mode must be audit or change");
  }
  const sideEffecting = mode === "change";
  const intent = sideEffecting ? "write" : "read_only";
  const action = sideEffecting ? "engineering_change" : "audit";
  const capability = sideEffecting ? "privileged" : "read_only";
  return {
    origin: "web",
    kind: sideEffecting ? "codex.change" : "codex.audit",
    title,
    prompt: "Solicitud manual del propietario desde Hermy HQ. El worker debe cumplir la capacidad " + capability
      + ".\n[[CODEX_INTENT_V1:" + intent + "]]\n\n[Tarea solicitada]\n" + prompt,
    sideEffecting,
    action,
    capability,
    status: sideEffecting ? "awaiting_approval" : "queued",
  };
}
