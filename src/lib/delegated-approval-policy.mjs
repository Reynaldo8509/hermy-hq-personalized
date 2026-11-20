import { createHash } from "node:crypto";

export const MAX_POLICY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DECISION_TTL_MS = 10 * 60 * 1000;

// Installation is inert unless the operator separately enables the exact
// server-side switch. Database policy activation alone cannot enable decisions.
export function autoApprovalEnabled(value = process.env.AUTOAPPROVAL_ENABLED) {
  return value === "true";
}

// This is a server-owned allowlist. A stored policy may select a subset and
// exact resources; it cannot add operations or widen these effect constraints.
export const RULES = Object.freeze({
  aegisPassiveV1: Object.freeze({
    id: "aegis.passive.v1",
    kind: "aegis.security",
    action: "audit",
    capability: "read_only",
    executionMode: "read_only",
    scopeId: "vps.passive-security.v1",
    privacyClass: "LOCAL_ONLY",
    requesterActor: "max",
    authSource: "hermy_hq_internal_secret",
    allowedOrigins: Object.freeze(["web"]),
    allowedResourceIds: Object.freeze(["vps:oracle-production"]),
    // This agent always enters the approval queue, even if a client omits its
    // approval flag. The delegated policy may resolve only these server-known
    // gate reasons; prompt side effects and unknown operations remain blocked.
    permittedRiskReasons: Object.freeze([
      "agent_requires_approval",
      "client_requested_approval",
      "effective_action_side_effecting",
    ]),
  }),
});

const SAFE_RESOURCE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const FORBIDDEN_EFFECTS = Object.freeze([
  "privilegeEscalation",
  "activeNetworkScan",
  "systemModification",
  "externalIO",
  "commercialInference",
  "irreversibleAction",
]);

function review(reason) {
  return Object.freeze({ decision: "manual_review", reason });
}

function epoch(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function delegatedPolicyHash(policy) {
  const ruleIds = Array.isArray(policy?.ruleIds) ? [...new Set(policy.ruleIds.map(String))].sort() : [];
  const expiresMs = epoch(policy?.expiresAt);
  const issuer = String(policy?.approvedBy ?? policy?.issuer ?? "").trim().toLowerCase();
  if (!ruleIds.length || !Number.isFinite(expiresMs) || !issuer) return null;
  const suppliedRuleIds = Object.keys(policy?.resourceIdsByRule || {}).sort();
  if (JSON.stringify(suppliedRuleIds) !== JSON.stringify(ruleIds)) return null;
  const rules = [];
  const resourceIdsByRule = {};
  for (const ruleId of ruleIds) {
    const rule = Object.values(RULES).find((candidate) => candidate.id === ruleId);
    const resources = policy?.resourceIdsByRule?.[ruleId];
    if (!rule || !Array.isArray(resources) || !resources.length
        || resources.some((resource) => typeof resource !== "string"
          || !rule.allowedResourceIds.includes(resource) || resource.includes("*"))) return null;
    rules.push({ ...rule, allowedOrigins: [...rule.allowedOrigins].sort(), allowedResourceIds: [...rule.allowedResourceIds].sort(), permittedRiskReasons: [...rule.permittedRiskReasons].sort() });
    resourceIdsByRule[ruleId] = [...new Set(resources.map(String))].sort();
  }
  return createHash("sha256").update(JSON.stringify(canonical({
    schemaVersion: 1,
    issuer,
    expiresAt: new Date(expiresMs).toISOString(),
    maxPolicyTtlMs: MAX_POLICY_TTL_MS,
    maxDecisionTtlMs: MAX_DECISION_TTL_MS,
    rules,
    resourceIdsByRule,
    forbiddenEffects: [...FORBIDDEN_EFFECTS].sort(),
  }))).digest("hex");
}

export function requestFingerprint(request) {
  const binding = {
    id: request?.id,
    origin: request?.origin,
    requestedBy: request?.requestedBy,
    authSource: request?.authSource,
    kind: request?.kind,
    action: request?.action,
    capability: request?.capability,
    executionMode: request?.executionMode,
    privacyClass: request?.privacyClass,
    scope: request?.scope,
    title: request?.title,
    prompt: request?.prompt,
    sideEffecting: request?.sideEffecting,
    contractVersion: Number(request?.contractVersion || 1),
    riskReasons: [...(request?.riskReasons ?? [])].map(String).sort(),
    dependencies: [...(request?.dependencies ?? request?.dependsOn ?? [])].map(String).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical(binding))).digest("hex");
}

/**
 * Pure fail-closed policy decision. The caller must pass fresh server-derived
 * DB rows and classification results; this function never trusts payload
 * claims or performs a database transition.
 */
export function evaluateDelegatedApproval({ policy, request, approval, context, now = Date.now() }) {
  if (!policy || policy.enabled !== true || policy.revokedAt != null) return review("policy_disabled_or_revoked");
  const issuedAt = epoch(policy.issuedAt);
  const policyExpiry = epoch(policy.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(policyExpiry) || issuedAt > now || policyExpiry <= now) {
    return review("policy_expired_or_invalid");
  }
  if (policyExpiry - issuedAt > MAX_POLICY_TTL_MS) return review("policy_ttl_exceeds_limit");
  if (typeof policy.policyHash !== "string" || policy.policyHash !== delegatedPolicyHash(policy)) {
    return review("policy_hash_mismatch");
  }
  if (typeof policy.id !== "string" || !policy.id || !Number.isInteger(policy.version) || policy.version < 1
      || typeof policy.approvedBy !== "string"
      || !policy.approvedBy.includes("@") || context?.policyIssuerAllowlisted !== true) {
    return review("policy_issuer_not_human_allowlisted");
  }
  if (context?.decisionAlreadyRecorded === true) return review("decision_replay");
  if (context?.authSource !== "hermy_hq_internal_secret") return review("request_provenance_unverified");
  if (!request || request.status !== "awaiting_approval" || request.sideEffecting !== true) return review("request_not_pending_approval");
  if (typeof request.id !== "string" || !request.id || request.requestedBy !== "max") return review("requester_not_authorized");
  const delegateActor = `system:delegated-approval-policy:${policy.id}`;
  if (delegateActor === request.requestedBy) {
    return review("delegated_actor_invalid_or_self_approval");
  }

  const rule = Object.values(RULES).find((candidate) =>
    candidate.kind === request.kind
    && candidate.action === request.action
    && candidate.capability === request.capability
    && candidate.executionMode === request.executionMode
    && candidate.scopeId === request.scope?.id
    && candidate.privacyClass === request.privacyClass);
  if (!rule || !Array.isArray(policy.ruleIds) || !policy.ruleIds.includes(rule.id)) return review("operation_not_allowlisted");
  if (rule.requesterActor !== request.requestedBy || rule.authSource !== request.authSource) return review("request_identity_mismatch");
  if (!rule.allowedOrigins.includes(request.origin)) return review("request_origin_not_allowlisted");

  const scopeKeys = request.scope && typeof request.scope === "object" ? Object.keys(request.scope).sort() : [];
  if (scopeKeys.join("|") !== ["effects", "id", "resourceIds"].sort().join("|")) return review("scope_schema_unknown");
  const resourceIds = request.scope?.resourceIds;
  if (!Array.isArray(resourceIds) || resourceIds.length === 0
      || resourceIds.some((id) => typeof id !== "string" || !SAFE_RESOURCE_ID.test(id) || id.includes("*"))) {
    return review("scope_resource_invalid");
  }
  const allowedResources = policy.resourceIdsByRule?.[rule.id];
  if (!Array.isArray(allowedResources) || allowedResources.length === 0
      || allowedResources.some((id) => !rule.allowedResourceIds.includes(id))
      || resourceIds.some((id) => !allowedResources.includes(id))) return review("scope_resource_not_allowlisted");

  const effects = request.scope?.effects;
  if (!effects || Object.keys(effects).sort().join("|") !== [...FORBIDDEN_EFFECTS].sort().join("|")
      || FORBIDDEN_EFFECTS.some((name) => effects[name] !== false)) return review("effect_profile_not_passive");
  const reasons = context?.riskReasons;
  if (!Array.isArray(reasons)
      || !reasons.includes("agent_requires_approval")
      || reasons.some((reason) => !rule.permittedRiskReasons.includes(reason))) return review("risk_classification_not_allowlisted");

  if (!approval || approval.requestId !== request.id || approval.action !== "execute"
      || approval.status !== "pending") return review("approval_not_pending_or_bound");
  const approvalExpiry = epoch(approval.expiresAt);
  if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now) {
    return review("approval_expired_or_invalid");
  }
  const digest = requestFingerprint(request);
  if (approval.requestFingerprint !== digest || context?.requestFingerprint !== digest) {
    return review("request_approval_fingerprint_mismatch");
  }
  return Object.freeze({
    decision: "approve",
    actor: delegateActor,
    policyId: policy.id,
    policyVersion: policy.version,
    ruleId: rule.id,
    requestId: request.id,
    requestFingerprint: digest,
    expiresAt: new Date(Math.min(approvalExpiry, now + MAX_DECISION_TTL_MS)).toISOString(),
  });
}
