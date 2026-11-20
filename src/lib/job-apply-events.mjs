import { isDeepStrictEqual } from "node:util";

const STATES = new Set([
  "DISCOVERED", "SKIPPED", "READY", "APPLYING", "SUBMITTING", "SUBMITTED",
  "UNCERTAIN", "RETRY", "BLOCKED",
]);
const EVENT_TYPES = new Set(["job_decision", "application_state", "application_followup"]);
const PORTALS = new Set([
  "linkedin", "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday.com",
  "icims.com", "smartrecruiters.com", "workable.com", "jobvite.com", "oraclecloud.com", "email",
]);
const FOLLOWUP_LABELS = Object.freeze({
  followup_application_update: "Application update",
  followup_assessment: "Assessment invitation",
  followup_interview: "Interview invitation",
  followup_offer: "Offer received",
  followup_rejection: "Rejection received",
});
// Reasons are fixed adapter codes. Free text from job pages, mail, CVs or applicants is never stored.
const REASONS = new Set([
  "integration_validation", "campaign_company_exclusion", "campaign_family_exclusion",
  "campaign_remote_only", "campaign_work_mode_unknown", "campaign_location_unknown",
  "campaign_location_exclusion", "campaign_salary_unknown_or_currency_ambiguous",
  "campaign_salary_unparseable", "campaign_salary_below_minimum", "campaign_salary_outside_range",
  "compatibility_threshold_invalid", "job_title_missing", "profile_exclusion_match",
  "onsite_location_unknown", "onsite_location_incompatible", "deterministic_role_skill_match",
  "ambiguous_relevant_match_requires_review", "below_compatibility_threshold",
  "linkedin_session_or_challenge", "captcha_detected", "portal_route_not_supported",
  "unexpected_portal_redirect", "portal_job_details_incomplete", "selected_cv_catalog_mismatch",
  "portal_already_applied", "linkedin_easy_apply_started", "portal_final_submit_precommit",
  "portal_confirmation_verified", "submit_clicked_without_confirmation",
  "required_answer_or_form_unsupported", "linkedin_daily_limit",
  "upstream_failed_after_submit_precommit", "upstream_apply_error",
  "submission_limit_state_ambiguous", "submission_limit_reached",
  "process_error_after_submit_precommit", "browser_or_process_error",
  "recovered_interrupted_before_submit", "recovered_interrupted_during_submit",
  "reconciled_confirmed", "reconciled_absent", "cv_or_language_match_missing",
  "owner_configuration_updated",
  "followup_application_update", "followup_assessment", "followup_interview",
  "followup_offer", "followup_rejection",
]);

export function normalizeJobApplyEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventId = value.event_id;
  const jobRef = value.job_ref == null ? null : value.job_ref;
  const state = value.state;
  const eventType = value.event_type;
  const portal = value.portal;
  const reason = value.reason == null ? "" : value.reason;
  if (!Number.isSafeInteger(eventId) || eventId < 1) return null;
  if (jobRef !== null && (!Number.isSafeInteger(jobRef) || jobRef < 1)) return null;
  if (typeof state !== "string" || !STATES.has(state)) return null;
  if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) return null;
  if (typeof portal !== "string" || !PORTALS.has(portal)) return null;
  if (typeof reason !== "string" || (reason && !REASONS.has(reason))) return null;
  if (eventType === "application_followup") {
    if (state !== "SUBMITTED" || !Object.hasOwn(FOLLOWUP_LABELS, reason)) return null;
  } else if (Object.hasOwn(FOLLOWUP_LABELS, reason)) return null;
  return Object.freeze({ eventId, jobRef, state, eventType, portal, reason });
}

export function normalizeJobApplyBatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return null;
  const events = body.events.map(jobApplyActivityData);
  return events.some((event) => event === null) ? null : events;
}

export function jobApplyActivityData(value) {
  const normalized = normalizeJobApplyEvent(value);
  if (!normalized) return null;
  const level = normalized.eventType === "application_followup"
    ? normalized.reason === "followup_rejection" ? "warn" : "info"
    : normalized.state === "SUBMITTED" ? "up"
      : ["BLOCKED", "UNCERTAIN", "RETRY"].includes(normalized.state) ? "warn" : "info";
  const portalLabel = normalized.portal === "linkedin" ? "LinkedIn"
    : normalized.portal === "email" ? "Email" : normalized.portal;
  return {
    id: `jobapply_evt_${normalized.eventId}`,
    kind: "activity",
    title: normalized.eventType === "application_followup"
      ? `Job application follow-up: ${FOLLOWUP_LABELS[normalized.reason]}`
      : `Job application: ${normalized.state}`,
    detail: `${portalLabel}${normalized.eventType === "application_followup" ? "" : normalized.reason ? ` · ${normalized.reason}` : ""}`,
    agent: "job-apply",
    level,
    meta: {
      source: "job-apply",
      eventId: normalized.eventId,
      jobRef: normalized.jobRef,
      state: normalized.state,
      eventType: normalized.eventType,
      portal: normalized.portal,
    },
  };
}

function persistedEventMatches(existing, expected) {
  return existing !== null && existing !== undefined
    && existing.id === expected.id
    && existing.kind === expected.kind
    && existing.title === expected.title
    && existing.detail === expected.detail
    && existing.agent === expected.agent
    && existing.level === expected.level
    && isDeepStrictEqual(existing.meta, expected.meta);
}

export async function persistJobApplyBatch(prisma, events) {
  let accepted = 0;
  let duplicate = 0;
  for (const event of events) {
    try {
      const saved = await prisma.agentEvent.create({ data: event });
      if (!persistedEventMatches(saved, event)) return { status: 503, accepted, duplicate };
      accepted += 1;
    } catch {
      let existing;
      try {
        existing = await prisma.agentEvent.findUnique({
          where: { id: event.id },
          select: { id: true, kind: true, title: true, detail: true, agent: true, level: true, meta: true },
        });
      } catch {
        return { status: 503, accepted, duplicate };
      }
      if (!existing) return { status: 503, accepted, duplicate };
      if (!persistedEventMatches(existing, event)) return { status: 409, accepted, duplicate };
      duplicate += 1;
    }
  }
  return { status: 200, accepted, duplicate };
}

export async function readBoundedJson(request, maximumBytes = 32 * 1024) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { status: 400 };
    if (Number(declared) > maximumBytes) return { status: 413 };
  }
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        return { status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400 };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: 200, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}
