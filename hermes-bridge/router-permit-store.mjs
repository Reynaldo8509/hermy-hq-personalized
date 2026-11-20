import {
  isTrustedRouterE2EPermit,
  ROUTER_E2E_PERMIT_SOURCE,
} from "./privacy-model-router.mjs";

function permitKey(request, permit) {
  return "routing-e2e-authorization:" + String(request?.id || "") + ":" + String(permit?.permitId || "");
}

export async function persistIssuedRouterE2EPermit(query, request, permit, binding, now = Date.now()) {
  if (typeof query !== "function") throw new TypeError("router permit persistence requires a query adapter");
  if (!isTrustedRouterE2EPermit(permit, request, now, binding)) {
    throw new Error("router_e2e_permit_binding_invalid");
  }
  const key = permitKey(request, permit);
  const result = await query(
    'INSERT INTO "DataStore" (key,data,"updatedAt") VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO NOTHING RETURNING key',
    [key, JSON.stringify(permit)],
  );
  if (result.rowCount !== 1) throw new Error("router_e2e_permit_already_issued");
  return key;
}

export async function consumeRouterE2EPermit(query, request, permit, binding, now = Date.now()) {
  if (typeof query !== "function") throw new TypeError("router permit persistence requires a query adapter");
  if (!isTrustedRouterE2EPermit(permit, request, now, binding)) return false;
  const sql = [
    'UPDATE "DataStore"',
    "SET data=jsonb_set(jsonb_set(data,'{status}','\"CONSUMED\"'::jsonb,true),'{consumedAt}',to_jsonb($2::text),true), \"updatedAt\"=now()",
    "WHERE key=$1 AND data->>'source'=$12 AND data->>'permitId'=$3",
    "AND data->>'requestFingerprint'=$4 AND data->>'payloadHash'=$5",
    "AND data->>'provider'=$6 AND data->>'requestedModel'=$7 AND data->>'effectiveModel'=$8",
    "AND data->>'privacyClass'=$9 AND data->>'policyVersion'=$10 AND data->>'routeTier'=$13",
    "AND data->>'nonce'=$14 AND data->>'issuedAt'=$15 AND data->>'expiresAt'=$16",
    "AND data->>'requestId'=$17",
    "AND data->>'qwenAvailable' IS NOT DISTINCT FROM $18",
    "AND data->>'status'='ISSUED' AND data->>'consumedAt' IS NULL",
    "AND COALESCE(data->>'expiresAt','') ~ '^[0-9]+$' AND (data->>'expiresAt')::bigint > $11",
    "RETURNING key",
  ].join(" ");
  const result = await query(sql, [
    permitKey(request, permit), new Date(now).toISOString(), permit.permitId,
    permit.requestFingerprint, permit.payloadHash, permit.provider,
    permit.requestedModel, permit.effectiveModel, permit.privacyClass,
    permit.policyVersion, Number(now), ROUTER_E2E_PERMIT_SOURCE, permit.routeTier,
    permit.nonce, String(permit.issuedAt), String(permit.expiresAt), permit.requestId,
    permit.qwenAvailable === null ? null : String(permit.qwenAvailable),
  ]);
  return result.rowCount === 1;
}
