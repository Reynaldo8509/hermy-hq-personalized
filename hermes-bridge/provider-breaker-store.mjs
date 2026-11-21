import { randomUUID } from "node:crypto";
import { nextCircuitState, PROVIDER_BREAKER_STATES } from "./privacy-model-router.mjs";

export function initialProviderBreakerFailureState({ errorClass = null, httpStatus = null, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("provider breaker initialization requires a valid clock");
  const classification = typeof errorClass === "string" && errorClass.trim()
    ? errorClass.trim() : "transport_outcome_unknown";
  const initial = {
    state: PROVIDER_BREAKER_STATES.CLOSED, providerFailureCount: 0, consecutiveFailures: 0,
    lastFailureAt: null, openedAt: null, cooldownUntil: 0, disabled: false, reason: null,
    lastProviderFailureClass: null, lastVerifiedHttpStatus: null,
    probeLeaseToken: null, probeLeaseExpiresAt: 0,
  };
  const next = nextCircuitState(initial, classification, now);
  const status = Number(httpStatus);
  const verifiedStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return {
    ...initial, ...next,
    openedAt: next.state === PROVIDER_BREAKER_STATES.OPEN ? now : null,
    cooldownUntil: Number.isSafeInteger(Number(next.cooldownUntil)) ? Number(next.cooldownUntil) : 0,
    disabled: next.disabled === true,
    reason: classification,
    lastProviderFailureClass: classification,
    lastVerifiedHttpStatus: verifiedStatus,
    probeLeaseToken: null,
    probeLeaseExpiresAt: 0,
  };
}

export function buildProviderBreakerFailureUpsert({ key, errorClass, now, probeToken = null,
  httpStatus = null, initialData } = {}) {
  if (typeof key !== "string" || !key || typeof errorClass !== "string" || !errorClass
      || !Number.isSafeInteger(now) || now < 0 || (probeToken !== null && typeof probeToken !== "string")
      || !initialData || typeof initialData !== "object" || Array.isArray(initialData)) {
    throw new TypeError("provider breaker failure upsert input invalid");
  }
  const safeStatus = Number.isInteger(Number(httpStatus)) && Number(httpStatus) >= 100 && Number(httpStatus) <= 599
    ? Number(httpStatus) : null;
  const shouldOpen = `(stored.data->>'state'='OPEN' OR $4::text IS NOT NULL OR $2::text IN ('payment_required','rate_limited','auth_denied')
    OR ($2::text IN ('provider_5xx','provider_503') AND COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1>=2)
    OR ($2::text IN ('timeout','network_error') AND COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1>=2))`;
  const cooldown = `CASE
    WHEN $2::text='payment_required' THEN 9007199254740991
    WHEN $2::text='rate_limited' THEN $3::bigint+1800000
    WHEN $2::text='auth_denied' THEN $3::bigint+3600000
    WHEN $2::text IN ('provider_5xx','provider_503') AND COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1>=2 THEN $3::bigint+300000
    WHEN $2::text IN ('timeout','network_error') AND COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1>=2 THEN $3::bigint+120000
    WHEN $4::text IS NOT NULL THEN $3::bigint
    ELSE COALESCE((stored.data->>'cooldownUntil')::bigint,0) END`;
  const dataExpression = `stored.data || jsonb_build_object(
    'state',CASE WHEN ${shouldOpen} THEN 'OPEN' ELSE 'CLOSED' END,
    'providerFailureCount',COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1,
    'consecutiveFailures',COALESCE((stored.data->>'providerFailureCount')::int,(stored.data->>'consecutiveFailures')::int,0)+1,
    'lastFailureAt',$3::bigint,
    'openedAt',CASE WHEN ${shouldOpen} THEN $3::bigint ELSE COALESCE((stored.data->>'openedAt')::bigint,0) END,
    'cooldownUntil',${cooldown},
    'disabled',($2::text='payment_required'),
    'reason',$2::text,'lastProviderFailureClass',$2::text,
    'lastVerifiedHttpStatus',COALESCE($5::int,(stored.data->>'lastVerifiedHttpStatus')::int),
    'probeLeaseToken',null,'probeLeaseExpiresAt',0)`;
  const where = probeToken
    ? "stored.data->>'state'='HALF_OPEN' AND stored.data->>'probeLeaseToken'=$6"
    : "COALESCE(stored.data->>'state','CLOSED')<>'HALF_OPEN' AND $6::text IS NULL";
  return {
    text: `INSERT INTO "DataStore" AS stored (key,data,"updatedAt") VALUES ($1,$7::jsonb,now()) `
      + `ON CONFLICT (key) DO UPDATE SET data=${dataExpression},"updatedAt"=now() WHERE ${where}`,
    values: [key, errorClass, now, probeToken, safeStatus, probeToken, JSON.stringify(initialData)],
  };
}

export const CLAIM_HALF_OPEN_PROBE_SQL =
  'UPDATE "DataStore" SET data=data || jsonb_build_object(\'state\',\'HALF_OPEN\',\'probeLeaseToken\',$2::text,'
  + '\'probeLeaseExpiresAt\',$3::bigint,\'halfOpenSince\',$4::bigint),"updatedAt"=now() '
  + 'WHERE key=$1 AND (data->>\'state\'=\'OPEN\' OR '
  + '(data->>\'state\'=\'HALF_OPEN\' AND COALESCE((data->>\'probeLeaseExpiresAt\')::bigint,0)<=$4::bigint)) '
  + 'AND COALESCE((data->>\'cooldownUntil\')::bigint,0)<=$4::bigint '
  + 'AND COALESCE((data->>\'probeLeaseExpiresAt\')::bigint,0)<=$4::bigint RETURNING data';

export async function claimHalfOpenProbe(query, { key, now = Date.now(), leaseMs, token = randomUUID() } = {}) {
  if (typeof query !== "function") throw new TypeError("half-open probe requires an atomic query adapter");
  if (!key || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("half-open probe requires a key, clock, and positive lease");
  }
  const { rows = [] } = await query(CLAIM_HALF_OPEN_PROBE_SQL, [key, token, now + leaseMs, now]);
  return rows[0] ? { data: rows[0].data, token } : null;
}
