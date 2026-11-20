export function codexReadinessMarkerPresent(value) {
  return String(value || "").split(/\r?\n/).some((line) =>
    /^VALIDACION:\s*CODEX_WORKER_READY_OK\s*$/.test(line.trim()));
}

export function codexReadinessTaskVerified(task, inferenceAttempt) {
  return Boolean(task
    && task.id
    && task.kind === "codex.audit"
    && task.origin === "max"
    && task.status === "done"
    && task.sideEffecting === false
    && task.action === "audit"
    && task.capability === "read_only"
    && codexReadinessMarkerPresent(task.result)
    && inferenceAttempt
    && inferenceAttempt.request_id === task.id
    && inferenceAttempt.status === "success"
    && inferenceAttempt.provider === "openai"
    && inferenceAttempt.model === "codex");
}
