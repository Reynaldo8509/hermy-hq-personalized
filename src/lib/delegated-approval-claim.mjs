import { randomUUID } from "node:crypto";
import { delegatedPolicyHash, requestFingerprint } from "./delegated-approval-policy.mjs";
import { approvalMatches } from "./phase2-domain.mjs";

const POLICY_ACTOR_PREFIX = "system:delegated-approval-policy:";
const CLAIM_AUDIT_ACTOR = "system:delegated-approval-claim";

function normalizeRequest(row) {
  // Preserve the legacy row shape during the Bridge-first rollout: properties
  // absent before the HQ migration must remain absent for fingerprinting.
  const optional = (name) => row[name] === undefined ? undefined : row[name] ?? null;
  return {
    id: String(row.id), origin: String(row.origin || ""), kind: String(row.kind || ""),
    requestedBy: optional("requestedBy"), authSource: optional("authSource"),
    action: row.action ?? null, capability: row.capability ?? null,
    executionMode: optional("executionMode"), privacyClass: optional("privacyClass"),
    scope: optional("scope"), title: String(row.title || ""), prompt: row.prompt ?? null,
    sideEffecting: row.sideEffecting === true, contractVersion: Number(row.contractVersion || 1),
    riskReasons: Array.isArray(row.riskReasons) ? row.riskReasons : [],
    dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.map(String) : [],
    status: String(row.status || ""),
  };
}

async function makeHumanReviewable(client, { request, decision, approvalId, reason }) {
  const expired = Boolean(decision?.expires_at && decision?.db_now
    && new Date(decision.expires_at).getTime() <= new Date(decision.db_now).getTime());
  const nextStatus = decision?.status === "consumed" ? "invalidated" : expired ? "expired" : "revoked";
  if (decision?.id && decision.status === "issued") {
    await client.query(`UPDATE "DelegatedApprovalDecision" SET status=$2 WHERE id=$1 AND status='issued'`, [decision.id, nextStatus]);
  }
  if (approvalId) {
    await client.query(`UPDATE "ActionApproval"
      SET status='pending',decision=NULL,approved_by=NULL,rejected_by=NULL,resolved_by=NULL,
          result=$2,resolved_at=NULL
      WHERE id=$1 AND status='approved' AND resolved_by LIKE $3`,
      [approvalId, `Delegated decision blocked (${reason}); human review required`, `${POLICY_ACTOR_PREFIX}%`]);
  }
  await client.query(`UPDATE "AgentRequest" SET status='awaiting_approval',error=NULL,"decidedAt"=NULL,"updatedAt"=clock_timestamp()
    WHERE id=$1 AND status='approved'`, [request.id]);
  await client.query(`INSERT INTO "DelegatedApprovalAudit"
    (id,actor,event,policy_id,request_id,approval_id,policy_hash,request_fingerprint,detail)
    VALUES ($1,$2,'decision_blocked_before_claim',$3,$4,$5,$6,$7,$8::jsonb)`,
    [randomUUID(), CLAIM_AUDIT_ACTOR, decision?.policy_id ?? null, request.id, approvalId ?? null,
      decision?.policy_hash ?? null, requestFingerprint(request), JSON.stringify({ reason, decisionStatus: decision?.status ?? "missing" })]);
}

/**
 * Atomically revalidates and consumes a delegated decision at Bridge claim.
 * A pool client is held for the entire transaction so row locks and database
 * time remain on one PostgreSQL connection. Human approvals keep their
 * existing actor and snapshot path; this function never creates approvals.
 */
export async function claimAgentRequest(pool, queuedRequest) {
  const expectedFingerprint = requestFingerprint(queuedRequest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentRows = await client.query(`SELECT * FROM "AgentRequest" WHERE id=$1 FOR UPDATE`, [queuedRequest.id]);
    const rawRequest = currentRows.rows[0];
    if (!rawRequest || !["queued", "approved"].includes(String(rawRequest.status))) {
      await client.query("COMMIT");
      return { claimed: false, reason: "request_not_claimable" };
    }
    const request = normalizeRequest(rawRequest);
    if (requestFingerprint(request) !== expectedFingerprint) {
      await client.query("COMMIT");
      return { claimed: false, reason: "request_changed_before_claim" };
    }

    // The Bridge is promoted before the independent HQ migration. Keep the
    // legacy human-approval path operational while both delegated tables are
    // absent; a partial migration is an integrity error and fails closed.
    const schema = await client.query(`SELECT
      to_regclass('"DelegatedApprovalDecision"') IS NOT NULL AS decision_table,
      to_regclass('"DelegatedApprovalPolicy"') IS NOT NULL AS policy_table`);
    const hasDecisionTable = schema.rows[0]?.decision_table === true;
    const hasPolicyTable = schema.rows[0]?.policy_table === true;
    if (hasDecisionTable !== hasPolicyTable) throw new Error("delegated_approval_schema_incomplete");
    const delegatedRows = hasDecisionTable ? await client.query(`
      SELECT d.id,d.request_id,d.approval_id,d.policy_id,d.policy_version,d.rule_id,d.request_fingerprint,
             d.delegated_actor,d.status,d.issued_at,d.expires_at,d.consumed_at,
             d.policy_hash AS issued_policy_hash,p.policy_hash,p.version AS active_policy_version,
             p.issuer,p.rule_ids,p.resource_ids_by_rule,p.enabled,p.revoked_at,p.expires_at AS policy_expires_at,
             clock_timestamp() AS db_now
      FROM "DelegatedApprovalDecision" d
      JOIN "DelegatedApprovalPolicy" p ON p.id=d.policy_id
      WHERE d.request_id=$1 FOR UPDATE OF d,p
    `, [request.id]) : { rows: [] };
    const delegated = delegatedRows.rows[0] ?? null;

    if (request.sideEffecting && request.status === "approved") {
      const approvals = await client.query(`SELECT id,request_id AS "requestId",action,status,requested_by,approved_by,rejected_by,
          resolved_by,created_at,resolved_at,expires_at AS "expiresAt",parameters_snapshot
        FROM "ActionApproval" WHERE request_id=$1 AND action IN ('execute','execute_agent_request')
          AND status='approved' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [request.id]);
      const approval = approvals.rows[0] ?? null;

      if (delegated) {
        const now = new Date(delegated.db_now).getTime();
        const exactActor = delegated.delegated_actor === `${POLICY_ACTOR_PREFIX}${delegated.policy_id}`;
        const valid = delegated.status === "issued"
          && delegated.expires_at && new Date(delegated.expires_at).getTime() > now
          && delegated.enabled === true && delegated.revoked_at == null
          && delegated.policy_expires_at && new Date(delegated.policy_expires_at).getTime() > now
          && Number(delegated.active_policy_version) === Number(delegated.policy_version)
          && delegated.issued_policy_hash === delegated.policy_hash
          && delegated.policy_hash === delegatedPolicyHash({ ruleIds: delegated.rule_ids,
            resourceIdsByRule: delegated.resource_ids_by_rule, expiresAt: delegated.policy_expires_at,
            approvedBy: delegated.issuer })
          && delegated.request_fingerprint === requestFingerprint(request)
          && exactActor && approval?.id === delegated.approval_id
          && approval.status === "approved" && approval.resolved_by === delegated.delegated_actor
          && approvalMatches(approval, request);
        if (!valid) {
          const reason = !exactActor ? "delegated_actor_mismatch"
            : delegated.status !== "issued" ? "decision_replayed_or_consumed"
            : delegated.enabled !== true || delegated.revoked_at != null ? "policy_revoked"
            : delegated.issued_policy_hash !== delegated.policy_hash ? "policy_hash_changed"
            : delegated.request_fingerprint !== requestFingerprint(request) || !approvalMatches(approval, request)
              ? "request_or_approval_changed" : "decision_or_policy_expired";
          await makeHumanReviewable(client, { request, decision: delegated, approvalId: delegated.approval_id, reason });
          await client.query("COMMIT");
          return { claimed: false, reason: "delegated_decision_invalidated" };
        }
        const consumed = await client.query(`UPDATE "DelegatedApprovalDecision"
          SET status='consumed',consumed_at=clock_timestamp()
          WHERE id=$1 AND status='issued' AND expires_at > clock_timestamp() RETURNING id`, [delegated.id]);
        if (consumed.rowCount !== 1) {
          await makeHumanReviewable(client, { request, decision: delegated, approvalId: delegated.approval_id, reason: "decision_replay_or_expired" });
          await client.query("COMMIT");
          return { claimed: false, reason: "delegated_decision_replay_or_expired" };
        }
        const changed = await client.query(`UPDATE "AgentRequest" SET status='running',"startedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
          WHERE id=$1 AND status='approved' RETURNING id`, [request.id]);
        if (changed.rowCount !== 1) throw new Error("request_claim_transition_conflict");
        await client.query(`INSERT INTO "DelegatedApprovalAudit"
          (id,actor,event,policy_id,request_id,approval_id,policy_hash,request_fingerprint,detail)
          VALUES ($1,$2,'decision_consumed',$3,$4,$5,$6,$7,$8::jsonb)`,
          [randomUUID(), CLAIM_AUDIT_ACTOR, delegated.policy_id, request.id, delegated.approval_id,
            delegated.policy_hash, delegated.request_fingerprint, JSON.stringify({ policyVersion: delegated.policy_version })]);
        await client.query("COMMIT");
        return { claimed: true, request: rawRequest, delegated: true };
      }

      // A delegated actor without its one-use ledger is not a human approval.
      if (String(approval?.resolved_by || "").startsWith(POLICY_ACTOR_PREFIX)) {
        await makeHumanReviewable(client, { request, decision: null, approvalId: approval.id, reason: "delegated_ledger_missing" });
        await client.query("COMMIT");
        return { claimed: false, reason: "delegated_ledger_missing" };
      }
      if (!approval || !approvalMatches(approval, request)) {
        await client.query("COMMIT");
        return { claimed: false, reason: "approved_request_without_valid_approval" };
      }
    }

    const changed = await client.query(`UPDATE "AgentRequest" SET status='running',"startedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
      WHERE id=$1 AND status IN ('queued','approved') RETURNING id`, [request.id]);
    await client.query("COMMIT");
    return changed.rowCount === 1
      ? { claimed: true, request: rawRequest, delegated: false }
      : { claimed: false, reason: "request_claim_transition_conflict" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
