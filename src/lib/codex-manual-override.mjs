export const CODEX_MANUAL_OVERRIDE_PREFIX = "codex-manual-override:";

export function codexManualOverrideKey(requestId) {
  return CODEX_MANUAL_OVERRIDE_PREFIX + String(requestId || "");
}

export function codexManualOverrideRecord(task, actor, authorizedVia, now = new Date()) {
  return {
    version: 1,
    requestId: String(task?.id || ""),
    kind: String(task?.kind || ""),
    actor: String(actor || "").trim().toLowerCase(),
    authorizedVia: String(authorizedVia || ""),
    scope: "hermy_hq_priority_and_frequency_only",
    createdAt: now.toISOString(),
  };
}

export function isCodexManualOverride(value, task) {
  if (!value || typeof value !== "object" || !task || !["codex.audit", "codex.change"].includes(task.kind)) return false;
  const row = value;
  const timestamp = Date.parse(String(row.createdAt || ""));
  return row.version === 1
    && row.requestId === task.id
    && row.kind === task.kind
    && typeof row.actor === "string" && row.actor.includes("@")
    && ["owner_dispatch", "human_approval"].includes(row.authorizedVia)
    && row.scope === "hermy_hq_priority_and_frequency_only"
    && Number.isFinite(timestamp);
}
