import { randomUUID } from "node:crypto";
import { approvalMatches, isAllowlistedActor } from "./phase2-domain.mjs";
import { autoApprovalEnabled, delegatedPolicyHash, evaluateDelegatedApproval, requestFingerprint, RULES } from "./delegated-approval-policy.mjs";

const PASSIVE_EFFECTS = Object.freeze({
  privilegeEscalation: false,
  activeNetworkScan: false,
  systemModification: false,
  externalIO: false,
  commercialInference: false,
  irreversibleAction: false,
});
const DELEGATED_ACTOR_PREFIX = "system:delegated-approval-policy:";

/** Server derives structured scope; caller-provided scope is never consumed. */
export function buildStructuredRequestContract(input: {
  origin: string; kind: string; action: string | null; capability: string | null;
  executionMode: string | null; actor: string; authSource: string; riskReasons: string[];
}) {
  const exactPassiveAegis = input.origin === "web"
    && input.kind === RULES.aegisPassiveV1.kind
    && input.action === RULES.aegisPassiveV1.action
    && input.capability === RULES.aegisPassiveV1.capability
    && input.executionMode === RULES.aegisPassiveV1.executionMode
    && input.actor === RULES.aegisPassiveV1.requesterActor
    && input.authSource === RULES.aegisPassiveV1.authSource;
  return {
    contractVersion: 2,
    executionMode: input.executionMode,
    scope: exactPassiveAegis ? {
      id: RULES.aegisPassiveV1.scopeId,
      resourceIds: [...RULES.aegisPassiveV1.allowedResourceIds],
      effects: { ...PASSIVE_EFFECTS },
    } : null,
    privacyClass: input.kind === "aegis.security" ? "LOCAL_ONLY" : null,
    requestedBy: input.actor,
    authSource: input.authSource,
    riskReasons: [...new Set(input.riskReasons.map(String))].sort(),
  };
}

function activePolicy(row: any) {
  return {
    id: String(row.id), version: Number(row.version), policyHash: String(row.policy_hash),
    approvedBy: String(row.issuer), issuedAt: row.issued_at, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, enabled: row.enabled === true,
    ruleIds: row.rule_ids, resourceIdsByRule: row.resource_ids_by_rule,
  };
}

/**
 * Called only inside the authenticated queue-creation transaction, after the
 * server has created its ordinary pending ActionApproval. Any mismatch leaves
 * that human approval pending. No HTTP caller can submit a delegated decision.
 */
export async function maybeIssueDelegatedDecision(tx: any, request: any, approvalId: string, allowlist: string) {
  if (request.status !== "awaiting_approval" || request.sideEffecting !== true) return { decision: "not_applicable" as const };
  if (!autoApprovalEnabled()) return { decision: "manual_review" as const, reason: "delegated_approval_disabled" };
  const policies = await tx.$queryRawUnsafe(`
    SELECT id,version,policy_hash,issuer,rule_ids,resource_ids_by_rule,enabled,issued_at,expires_at,revoked_at,
           clock_timestamp() AS db_now
    FROM "DelegatedApprovalPolicy"
    WHERE enabled=true AND revoked_at IS NULL AND issued_at <= clock_timestamp() AND expires_at > clock_timestamp()
    ORDER BY issued_at DESC LIMIT 1 FOR UPDATE
  `);
  const row = policies[0];
  if (!row) return { decision: "manual_review" as const, reason: "no_active_policy" };

  const approvals = await tx.$queryRawUnsafe(`
    SELECT id,request_id AS "requestId",action,status,
           expires_at AT TIME ZONE 'UTC' AS "expiresAt",parameters_snapshot
    FROM "ActionApproval" WHERE id=$1 AND request_id=$2 FOR UPDATE
  `, approvalId, request.id);
  const approvalRow = approvals[0];
  if (!approvalRow || !approvalMatches(approvalRow, request)) {
    return { decision: "manual_review" as const, reason: "approval_snapshot_mismatch" };
  }
  const prior = await tx.$queryRawUnsafe(`
    SELECT id FROM "DelegatedApprovalDecision" WHERE request_id=$1 OR approval_id=$2 LIMIT 1
  `, request.id, approvalId);
  if (prior.length) return { decision: "manual_review" as const, reason: "decision_already_exists" };

  const policy = activePolicy(row);
  const fingerprint = requestFingerprint(request);
  const evaluation = evaluateDelegatedApproval({
    policy,
    request,
    approval: {
      requestId: approvalRow.requestId,
      action: approvalRow.action,
      status: approvalRow.status,
      expiresAt: approvalRow.expiresAt,
      requestFingerprint: fingerprint,
    },
    context: {
      authSource: request.authSource,
      policyIssuerAllowlisted: isAllowlistedActor(policy.approvedBy, allowlist),
      riskReasons: Array.isArray(request.riskReasons) ? request.riskReasons : [],
      requestFingerprint: fingerprint,
      decisionAlreadyRecorded: false,
    },
    now: new Date(row.db_now).getTime(),
  });
  if (evaluation.decision !== "approve" || policy.policyHash !== delegatedPolicyHash(policy)) return evaluation;

  const decisionId = randomUUID();
  const inserted = await tx.$executeRawUnsafe(`
    INSERT INTO "DelegatedApprovalDecision"
      (id,request_id,approval_id,policy_id,policy_version,policy_hash,rule_id,request_fingerprint,delegated_actor,status,issued_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',clock_timestamp(),$10)
  `, decisionId, request.id, approvalId, policy.id, policy.version, policy.policyHash,
  evaluation.ruleId, fingerprint, evaluation.actor, evaluation.expiresAt);
  if (inserted !== 1) throw new Error("delegated_decision_insert_conflict");

  const changedApproval = await tx.$executeRawUnsafe(`
    UPDATE "ActionApproval"
    SET status='approved',decision='approved',approved_by=NULL,rejected_by=NULL,resolved_by=$1,
        result='approved by exact delegated policy; one-use claim required',resolved_at=clock_timestamp()
    WHERE id=$2 AND request_id=$3 AND status='pending'
  `, evaluation.actor, approvalId, request.id);
  const changedRequest = await tx.$executeRawUnsafe(`
    UPDATE "AgentRequest" SET status='approved',"decidedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    WHERE id=$1 AND status='awaiting_approval' AND "sideEffecting"=true
  `, request.id);
  if (changedApproval !== 1 || changedRequest !== 1) throw new Error("delegated_decision_transition_conflict");

  await tx.$executeRawUnsafe(`
    INSERT INTO "DelegatedApprovalAudit"
      (id,actor,event,policy_id,request_id,approval_id,policy_hash,request_fingerprint,detail)
    VALUES ($1,$2,'decision_issued',$3,$4,$5,$6,$7,$8::jsonb)
  `, randomUUID(), evaluation.actor, policy.id, request.id, approvalId, policy.policyHash,
  fingerprint, JSON.stringify({ ruleId: evaluation.ruleId, policyVersion: policy.version,
    expiresAt: evaluation.expiresAt, action: "execute", mode: request.executionMode }));
  await tx.agentEvent.create({ data: {
    kind: "approval", title: "Aprobación delegada emitida por política acotada",
    detail: "Actor delegado: " + evaluation.actor,
    agent: "aegis", level: "info",
    meta: { requestId: request.id, approvalId, policyId: policy.id, ruleId: evaluation.ruleId,
      policyHash: policy.policyHash, delegatedActor: evaluation.actor, decisionId },
  } });
  return { decision: "approve" as const, id: decisionId, actor: evaluation.actor,
    requestFingerprint: fingerprint, expiresAt: evaluation.expiresAt };
}

export function delegatedActorPrefix() {
  return DELEGATED_ACTOR_PREFIX;
}
