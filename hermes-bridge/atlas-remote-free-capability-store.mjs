import {
  atlasRemoteFreeApprovalId, atlasRemoteFreePolicyApprovalId,
  ATLAS_REMOTE_FREE_CAPABILITY_SOURCE, ATLAS_REMOTE_FREE_POLICY_ACTION,
  ATLAS_REMOTE_FREE_POLICY_SOURCE, validateAtlasRemoteFreeCapability,
} from "./atlas-remote-free-capability.mjs";

function snapshotObject(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export async function loadAtlasRemoteFreeCapability(query, request, now = Date.now()) {
  if (typeof query !== "function" || !request?.id) return { present: false, valid: false };
  const ids = [atlasRemoteFreeApprovalId(request.id), atlasRemoteFreePolicyApprovalId(request.id)];
  const result = await query(
    'SELECT id,request_id,action,status,requested_by,approved_by,decision,'
      + "(extract(epoch FROM (created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS created_at_utc_ms,"
      + "(extract(epoch FROM (resolved_at AT TIME ZONE 'UTC')) * 1000)::bigint AS resolved_at_utc_ms,"
      + "(extract(epoch FROM (expires_at AT TIME ZONE 'UTC')) * 1000)::bigint AS expires_at_utc_ms,"
      + 'parameters_snapshot FROM "ActionApproval" WHERE id = ANY($1::text[]) AND request_id=$2 '
      + "ORDER BY CASE WHEN action='atlas_remote_free_consent' THEN 0 ELSE 1 END LIMIT 2",
    [ids, String(request.id)],
  );
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!rows.length) return { present: false, valid: false };
  const candidates = rows.map((approval) => ({
    approval,
    capability: snapshotObject(approval.parameters_snapshot),
  }));
  const valid = candidates.filter(({ capability, approval }) =>
    validateAtlasRemoteFreeCapability(capability, request, approval, now));
  // Explicit human consent takes precedence when present; otherwise normal server
  // policy authorization remains sufficient. Both paths are request-bound and CAS-consumed.
  const selected = valid.find(({ capability }) => capability.source === ATLAS_REMOTE_FREE_CAPABILITY_SOURCE)
    || valid.find(({ capability }) => capability.source === ATLAS_REMOTE_FREE_POLICY_SOURCE);
  if (!selected) return { present: true, valid: false };
  return { present: true, valid: true, ...selected };
}

export async function consumeAtlasRemoteFreeCapability(query, request, capability, approval, now = Date.now()) {
  if (typeof query !== "function"
      || !validateAtlasRemoteFreeCapability(capability, request, approval, now)) return false;
  const policy = capability.source === ATLAS_REMOTE_FREE_POLICY_SOURCE;
  const action = policy ? ATLAS_REMOTE_FREE_POLICY_ACTION : "atlas_remote_free_consent";
  const issuedStatus = policy ? "issued" : "approved";
  const result = await query(
    "WITH candidate AS MATERIALIZED ("
      + 'SELECT id FROM "ActionApproval" WHERE id=$1 AND request_id=$2 AND action=$3 AND status=$4 AND requested_by=$5 '
      + "AND (($6::boolean = true AND approved_by IS NULL) OR ($6::boolean = false AND approved_by=$5)) "
      + "AND parameters_snapshot=$7::jsonb FOR UPDATE"
      + "), utc_clock AS MATERIALIZED ("
      + "SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now_utc FROM candidate"
      + "), consumed AS ("
      + 'UPDATE "ActionApproval" AS approval SET status=\'consumed\', resolved_at=utc_clock.now_utc '
      + "FROM candidate, utc_clock WHERE approval.id=candidate.id AND approval.status=$4 "
      + "AND approval.expires_at > utc_clock.now_utc RETURNING approval.id"
      + ") SELECT id FROM consumed",
    [capability.approvalId, capability.requestId, action, issuedStatus, capability.actor,
      policy, JSON.stringify(capability)],
  );
  return result.rowCount === 1;
}
