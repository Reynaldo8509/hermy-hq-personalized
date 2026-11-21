import { isRecoverableSchedulerProvenanceFailure } from "./scheduler-audit-provenance.mjs";

const ACTIVE_STATUSES = new Set(["queued", "approved", "running"]);
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function scheduledAuditPeriodKey(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("scheduled_audit_time_invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const field = (name) => parts.find((part) => part.type === name)?.value || "00";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

function requestIdPrefix(kind, periodKey) {
  if (!PERIOD_RE.test(periodKey)) throw new Error("scheduled_audit_period_invalid");
  const slug = String(kind || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("scheduled_audit_kind_invalid");
  return `scheduled-audit-${slug}-${periodKey}`;
}

export function scheduledAuditRequestId(kind, periodKey, attempt = 0) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("scheduled_audit_attempt_invalid");
  const prefix = requestIdPrefix(kind, periodKey);
  return attempt === 0 ? prefix : `${prefix}-r${attempt}`;
}

export async function insertScheduledAuditAndPersist(insertRequest, persistPeriod) {
  const result = await insertRequest();
  if (result?.rowCount !== 1) return { inserted: false, persisted: false, result };
  try {
    await persistPeriod();
    return { inserted: true, persisted: true, result };
  } catch (error) {
    return { inserted: true, persisted: false, result, error };
  }
}

function attemptFromRequestId(id, kind, periodKey) {
  const prefix = requestIdPrefix(kind, periodKey);
  if (id === prefix) return 0;
  const match = String(id || "").match(new RegExp(`^${prefix}-r([1-9][0-9]*)$`));
  return match ? Number(match[1]) : -1;
}

function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function planScheduledAuditEnqueue({
  nowMs,
  timezone,
  intervalMs,
  latestRequest = null,
  activeRows = [],
  expected,
  recoveryAttemptAtMs = 0,
  recoveryBackoffMs = 0,
  justRecoveredStale = false,
  paused = false,
}) {
  const periodKey = scheduledAuditPeriodKey(nowMs, timezone);
  const skip = (reason) => ({ enqueue: false, periodKey, reason });
  if (paused) return skip("paused");
  if (Array.isArray(activeRows) && activeRows.some((row) => ACTIVE_STATUSES.has(row?.status))) {
    return skip("active_request");
  }

  const latestCreatedAt = epochMs(latestRequest?.createdAt);
  const latestPeriod = latestCreatedAt ? scheduledAuditPeriodKey(latestCreatedAt, timezone) : null;
  if (ACTIVE_STATUSES.has(latestRequest?.status)) return skip("active_request");
  if (latestRequest && latestPeriod === periodKey) {
    const recoverable = isRecoverableSchedulerProvenanceFailure(latestRequest, expected);
    if (!recoverable) {
      return skip(latestRequest.status === "done" ? "period_succeeded" : "period_attempted");
    }
    if (!justRecoveredStale && recoveryAttemptAtMs > 0
        && nowMs - recoveryAttemptAtMs < recoveryBackoffMs) {
      return skip("recovery_backoff");
    }
    const previousAttempt = attemptFromRequestId(latestRequest.id, expected.kind, periodKey);
    return {
      enqueue: true,
      periodKey,
      attempt: Math.max(1, previousAttempt + 1),
      recovery: true,
      reason: "bridge_provenance_failure",
    };
  }

  if (latestCreatedAt && nowMs - latestCreatedAt < intervalMs) return skip("interval_not_elapsed");
  return { enqueue: true, periodKey, attempt: 0, recovery: false, reason: "period_due" };
}
