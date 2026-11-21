const SCHEDULED_AUDIT_KINDS = new Map([
  ["ledger.operations", "ledger"],
  ["domus.home", "domus"],
]);
const BOUND_FIELDS = Object.freeze([
  "id", "kind", "origin", "sideEffecting", "title", "prompt", "action", "capability",
]);

function snapshot(request) {
  if (!request || typeof request !== "object") return null;
  return Object.fromEntries(BOUND_FIELDS.map(field => [field, request[field] ?? null]));
}

function validSchedulerRequest(request, id, requestKind) {
  return request.id === id && request.kind === requestKind
    && request.origin === "system" && request.sideEffecting === false
    && typeof request.title === "string" && typeof request.prompt === "string";
}

// Capabilities live only in Bridge memory and bind the exact persisted request fields.
// Request fields, titles, payload keys, DB rows, and DataStore markers cannot create one.
// A restarted Bridge deliberately has no proof for an older queued row and fails closed.
export function createSchedulerAuditProvenance() {
  const issued = new Map();
  const inFlight = new Set();

  return Object.freeze({
    issue(requestId, requestKind, expectedRequest) {
      const id = String(requestId || "");
      const auditKind = SCHEDULED_AUDIT_KINDS.get(requestKind);
      const expected = snapshot(expectedRequest);
      if (!id || !auditKind || issued.has(id) || inFlight.has(id) || !expected
          || !validSchedulerRequest(expected, id, requestKind)) {
        throw new Error("invalid_scheduler_audit_provenance_issue");
      }
      issued.set(id, { requestKind, auditKind, expected });
    },
    resolve(request) {
      const id = String(request?.id || "");
      const entry = issued.get(id);
      if (!entry) return null;
      issued.delete(id);
      inFlight.add(id);
      let actual;
      try { actual = snapshot(request); } catch { return "invalid"; }
      if (!actual || BOUND_FIELDS.some(field => !Object.is(actual[field], entry.expected[field]))) return "invalid";
      return entry.auditKind;
    },
    pendingIds() {
      return [...issued.keys()];
    },
    inFlightIds() {
      return [...inFlight];
    },
    revoke(requestId) {
      const id = String(requestId || "");
      issued.delete(id);
      inFlight.delete(id);
    },
  });
}



const ACTIVE_SCHEDULED_AUDIT_STATUSES = new Set(["queued", "approved", "running"]);

function matchesScheduledAuditRequest(row, expected) {
  const id = String(row?.id || "");
  const actual = snapshot(row);
  const canonical = snapshot({ ...expected, id });
  if (!id || !actual || !canonical || !validSchedulerRequest(canonical, id, expected.kind)) return false;
  return BOUND_FIELDS.every(field => Object.is(actual[field], canonical[field]));
}

// Old rows never regain their old authority. A scheduler may replace only an exact
// canonical row with a fresh ID; current in-process work and noncanonical requests are untouched.
export function planScheduledAuditRecovery(rows, expected, { liveAuthorityIds = [], activeRequestId = null } = {}) {
  const liveIds = new Set((liveAuthorityIds || []).map(String));
  const result = { staleIds: [], currentIds: [], blockedIds: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "");
    if (!id || !ACTIVE_SCHEDULED_AUDIT_STATUSES.has(row?.status)) {
      result.blockedIds.push(id);
    } else if (liveIds.has(id) || id === String(activeRequestId || "")) {
      result.currentIds.push(id);
    } else if (matchesScheduledAuditRequest(row, expected)) {
      result.staleIds.push(id);
    } else {
      result.blockedIds.push(id);
    }
  }
  return result;
}

export function isRecoverableSchedulerProvenanceFailure(row, expected) {
  const error = String(row?.error || "");
  return row?.status === "failed"
    && (error.includes("SCHEDULER_PROVENANCE_REQUIRED")
      || error.includes("SCHEDULER_CAPABILITY_EXPIRED_BRIDGE_PROCESS"))
    && matchesScheduledAuditRequest(row, expected);
}

// Fail closed when an issued request is cancelled, terminal, missing, or DB state cannot be read.
export async function pruneInactiveSchedulerAuditProvenance(authority, findActiveIds, onFailure = () => {}) {
  const trackedIds = [
    ...authority.pendingIds(),
    ...(typeof authority.inFlightIds === "function" ? authority.inFlightIds() : []),
  ];
  if (!trackedIds.length) return { revoked: 0, failClosed: false };
  try {
    const activeIds = new Set((await findActiveIds(trackedIds)).map(String));
    let revoked = 0;
    for (const id of trackedIds) {
      if (!activeIds.has(id)) {
        authority.revoke(id);
        revoked += 1;
      }
    }
    return { revoked, failClosed: false };
  } catch (error) {
    for (const id of trackedIds) authority.revoke(id);
    try { onFailure(error); } catch {}
    return { revoked: trackedIds.length, failClosed: true };
  }
}
