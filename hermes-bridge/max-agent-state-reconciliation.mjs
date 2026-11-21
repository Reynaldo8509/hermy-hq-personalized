export const MAX_STALE_WORK_GRACE_MS = 2 * 60 * 1000;

export const RECONCILE_STALE_MAX_WORK_SQL = `
UPDATE "AgentState" AS state
SET status='online', "currentTask"=NULL, "updatedAt"=now()
WHERE state.id='max'
  AND state.status='working'
  AND COALESCE(state."lastActive", state."updatedAt") < $1::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM "AgentRequest" AS request
    WHERE request.kind LIKE 'max.%'
      AND request.origin <> 'codex'
      AND request.status='running'
  )
RETURNING state.id`;

/**
 * Clear only an abandoned MAX work marker. The single conditional UPDATE is a CAS:
 * concurrent work refreshes lastActive/status before this row can be cleared, and an
 * AgentRequest still marked running always keeps the status intact.
 */
export async function reconcileStaleMaxWorkState(query, now = Date.now()) {
  const cutoff = new Date(now - MAX_STALE_WORK_GRACE_MS);
  const result = await query(RECONCILE_STALE_MAX_WORK_SQL, [cutoff]);
  const reconciled = Array.isArray(result?.rows) && result.rows.some((row) => row?.id === "max");
  return { reconciled };
}
