import { createHash } from "node:crypto";

export const MCP_RESTART_PRINCIPAL = "mcp-restart-request";
export const MCP_RESTART_UNIT = "rey-infrastructure-mcp-admin.service";
export const MCP_RESTART_ORIGIN = "mcp-service-control";
export const MCP_RESTART_KIND = "mcp.service_restart";
export const MCP_RESTART_TITLE = `MCP requests one-time restart of ${MCP_RESTART_UNIT}`;
export const MCP_RESTART_TTL_MS = 30 * 60 * 1000;
export const MCP_RESTART_MAX_REQUESTS_PER_HOUR = 3;
export const MCP_RESTART_APPROVAL_ACTION = "mcp_service_restart";
export const MCP_RESTART_MAX_BODY_BYTES = 2048;

const APPROVAL_SNAPSHOT_KEYS = Object.freeze([
  "contract", "requestId", "origin", "kind", "title", "operation", "unit",
  "requester", "nonceSha256", "nonce",
]);

export async function readBoundedJson(request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return { error: "content_type_must_be_application_json" };
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return { error: "content_encoding_not_supported" };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MCP_RESTART_MAX_BODY_BYTES)) {
    return { error: "request_body_too_large" };
  }
  if (!request.body) return { error: "request_body_required" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MCP_RESTART_MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: "request_body_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "request_body_unreadable" };
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { error: "invalid_json" };
  }
}

export function validateMcpRestartBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === "operation" && keys[1] === "unit" &&
    body.operation === "restart" && body.unit === MCP_RESTART_UNIT;
}

export function mcpRestartApprovalSnapshot({ requestId, nonce }) {
  if (!/^[a-f0-9]{40}$/.test(requestId) || !/^[A-Za-z0-9_-]{43,128}$/.test(nonce)) {
    throw new TypeError("Invalid server-side restart approval material");
  }
  const nonceSha256 = createHash("sha256").update(nonce, "utf8").digest("hex");
  return {
    contract: "mcp_restart_v2",
    requestId,
    origin: MCP_RESTART_ORIGIN,
    kind: MCP_RESTART_KIND,
    title: MCP_RESTART_TITLE,
    operation: "restart",
    unit: MCP_RESTART_UNIT,
    requester: MCP_RESTART_PRINCIPAL,
    nonceSha256,
    // Retained only in the root-protected ActionApproval row so an uncertain POST
    // can be safely retried and deduplicated. Human-facing APIs remove this field.
    nonce,
  };
}

export function mcpRestartApprovalMatches(approval, requestId, nonce) {
  const snapshot = approval?.parameters_snapshot;
  if (!approval || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  try {
    const expected = mcpRestartApprovalSnapshot({ requestId, nonce });
    return approval.id === requestId && approval.request_id === requestId &&
      approval.action === MCP_RESTART_APPROVAL_ACTION && approval.requested_by === MCP_RESTART_PRINCIPAL &&
      Object.keys(snapshot).length === APPROVAL_SNAPSHOT_KEYS.length &&
      APPROVAL_SNAPSHOT_KEYS.every((key) => snapshot[key] === expected[key]);
  } catch {
    return false;
  }
}

export async function createMcpRestartApproval({ store, requestId, nonce }) {
  if (!store || typeof store.lock !== "function" || typeof store.findPending !== "function" ||
      typeof store.countRecent !== "function" || typeof store.createApproval !== "function" ||
      typeof store.writeAudit !== "function") {
    throw new TypeError("Restart approval store is incomplete");
  }
  const snapshot = mcpRestartApprovalSnapshot({ requestId, nonce });
  await store.lock();
  const existing = await store.findPending(MCP_RESTART_UNIT);
  if (existing) {
    const priorNonce = existing.parameters_snapshot?.nonce;
    if (typeof priorNonce !== "string" || !mcpRestartApprovalMatches(existing, existing.request_id, priorNonce) ||
        existing.status !== "pending" || !(existing.expires_at instanceof Date) ||
        existing.expires_at <= new Date() || !(existing.created_at instanceof Date) ||
        existing.expires_at.getTime() > existing.created_at.getTime() + MCP_RESTART_TTL_MS) {
      throw new Error("pending_approval_contract_invalid");
    }
    return { duplicate: true, requestId: existing.request_id, nonce: priorNonce, expiresAt: existing.expires_at };
  }
  if (await store.countRecent(MCP_RESTART_PRINCIPAL) >= MCP_RESTART_MAX_REQUESTS_PER_HOUR) {
    return { rateLimited: true };
  }
  const expiresAt = await store.createApproval({
    requestId,
    snapshot,
    action: MCP_RESTART_APPROVAL_ACTION,
    requester: MCP_RESTART_PRINCIPAL,
  });
  await store.writeAudit({ requestId, expiresAt });
  return { duplicate: false, requestId, nonce, expiresAt };
}

export function publicMcpRestartStatus(approval, now = new Date()) {
  if (!approval || approval.action !== MCP_RESTART_APPROVAL_ACTION ||
      approval.requested_by !== MCP_RESTART_PRINCIPAL || approval.id !== approval.request_id) return null;
  const snapshot = approval.parameters_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      Object.keys(snapshot).length !== APPROVAL_SNAPSHOT_KEYS.length ||
      !APPROVAL_SNAPSHOT_KEYS.every((key) => Object.hasOwn(snapshot, key)) ||
      snapshot.contract !== "mcp_restart_v2" || snapshot.requestId !== approval.request_id ||
      snapshot.origin !== MCP_RESTART_ORIGIN || snapshot.kind !== MCP_RESTART_KIND ||
      snapshot.title !== MCP_RESTART_TITLE || snapshot.operation !== "restart" ||
      snapshot.unit !== MCP_RESTART_UNIT || snapshot.requester !== MCP_RESTART_PRINCIPAL ||
      !/^[a-f0-9]{64}$/.test(snapshot.nonceSha256 || "") ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(snapshot.nonce || "") ||
      createHash("sha256").update(snapshot.nonce, "utf8").digest("hex") !== snapshot.nonceSha256) return null;
  const expiry = approval.expires_at instanceof Date ? approval.expires_at : null;
  const created = approval.created_at instanceof Date ? approval.created_at : null;
  const safeExpiry = Boolean(expiry && created && expiry.getTime() > created.getTime() &&
    expiry.getTime() <= created.getTime() + MCP_RESTART_TTL_MS);
  const humanApproved = typeof approval.approved_by === "string" && approval.approved_by.length > 0 &&
    approval.approved_by !== MCP_RESTART_PRINCIPAL && !approval.approved_by.startsWith("system:");
  let status = "UNKNOWN";
  if (approval.status === "pending") status = !safeExpiry ? "UNKNOWN" : expiry.getTime() <= now.getTime() ? "EXPIRED" : "PENDING";
  else if (approval.status === "approved") status = humanApproved && safeExpiry && expiry.getTime() > now.getTime() ? "APPROVED" : "EXPIRED";
  else if (approval.status === "rejected") status = "REJECTED";
  else if (approval.status === "expired") status = "EXPIRED";
  else if (approval.status === "cancelled") status = "CANCELLED";
  return { requestId: approval.request_id, unit: MCP_RESTART_UNIT, operation: "restart", status,
    expiresAt: safeExpiry ? expiry.toISOString() : null };
}

export function humanFacingMcpApprovalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  if (snapshot.contract !== "mcp_restart_v2") return snapshot;
  const { nonce: _nonce, ...visible } = snapshot;
  return visible;
}

export function humanFacingMcpApproval(approval) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return approval;
  const snapshot = approval.parameters_snapshot;
  const fallbackTitle = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) &&
    typeof snapshot.title === "string" ? snapshot.title : null;
  return {
    ...approval,
    parameters_snapshot: humanFacingMcpApprovalSnapshot(snapshot),
    title: approval.title ?? fallbackTitle,
  };
}
