/**
 * Narrow authorization contract for MAX informational notices to the two owner DMs.
 *
 * This remains an external side effect: AgentRequest.sideEffecting is true. The
 * policy authorizes only this exact operation through the existing PROACTIVE_SHARED
 * recipient resolver. It never authorizes commands, arbitrary recipients, or other
 * side-effecting dispatch kinds.
 */
export const MAX_OWNER_NOTIFICATION_KIND = "max.owner_notification";
export const MAX_OWNER_NOTIFICATION_ACTION = "notify_owner";
export const MAX_OWNER_NOTIFICATION_CAPABILITY = "proactive_shared";
export const MAX_OWNER_NOTIFICATION_EXECUTION_MODE = "side_effecting";
export const MAX_OWNER_NOTIFICATION_POLICY_ID = "max-owner-notification-v1";
export const MAX_OWNER_NOTIFICATION_RECIPIENT_POLICY = "PROACTIVE_SHARED";
export const MAX_OWNER_NOTIFICATION_MAX_CHARS = 1000;
export const MAX_OWNER_NOTIFICATION_POLICY_APPROVER = `policy:${MAX_OWNER_NOTIFICATION_POLICY_ID}`;

const MAX_OWNER_NOTIFICATION_OVERRIDE_MARKERS = [
  "recipient", "chat", "telegram", "destination", "channel", "audience", "sendto", "userid", "userids", "sender",
  "model", "provider", "actor", "identity", "role", "requestedby",
  "auth", "origin", "source", "policy", "scope", "route", "routing",
  "approval", "approve", "inference", "token", "bearer", "header",
];
const MAX_OWNER_NOTIFICATION_OVERRIDE_NAMES = new Set(["to", "target"]);

export function hasMaxOwnerNotificationOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const visit = (current, depth) => {
    if (!current || typeof current !== "object" || depth > 6) return false;
    return Object.entries(current).some(([name, child]) => {
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (MAX_OWNER_NOTIFICATION_OVERRIDE_NAMES.has(normalized)
          || MAX_OWNER_NOTIFICATION_OVERRIDE_MARKERS.some((marker) => normalized.includes(marker))) return true;
      return child && typeof child === "object" && visit(child, depth + 1);
    });
  };
  return visit(value, 0);
}

export function ownerNotificationMessageAllowed(message) {
  if (typeof message !== "string" || message.trim().length === 0
      || message.length > MAX_OWNER_NOTIFICATION_MAX_CHARS) return false;
  return !Array.from(message).some((char) => {
    const code = char.codePointAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });
}
function ownerNotificationScope() {
  return {
    id: MAX_OWNER_NOTIFICATION_POLICY_ID,
    audience: "owner_admins",
    recipientPolicy: MAX_OWNER_NOTIFICATION_RECIPIENT_POLICY,
    effects: {
      externalIO: true,
      commandExecution: false,
      systemModification: false,
      commercialInference: false,
      irreversibleAction: false,
    },
  };
}

export function evaluateMaxOwnerNotificationPolicy(input = {}) {
  const applies = input.origin === "web"
    && input.kind === MAX_OWNER_NOTIFICATION_KIND
    && input.action === MAX_OWNER_NOTIFICATION_ACTION
    && input.capability === MAX_OWNER_NOTIFICATION_CAPABILITY
    && input.executionMode === MAX_OWNER_NOTIFICATION_EXECUTION_MODE
    && input.actor === "max"
    && input.authSource === "hermy_hq_internal_secret"
    && input.hasOverrides === false
    && ownerNotificationMessageAllowed(input.prompt);

  return {
    applies,
    autoAuthorized: applies,
    policyId: applies ? MAX_OWNER_NOTIFICATION_POLICY_ID : null,
    scope: applies ? ownerNotificationScope() : null,
  };
}

/** Revalidate the persisted server-generated contract before Bridge publishes it. */
export function isAuthorizedMaxOwnerNotificationRequest(request = {}) {
  const { origin: _origin, requestedBy: _requestedBy, authSource: _authSource, scope: _scope, ...payload } = request;
  if (hasMaxOwnerNotificationOverrides(payload)) return false;
  const scope = request.scope && typeof request.scope === "object" && !Array.isArray(request.scope)
    ? request.scope : {};
  const effects = scope.effects && typeof scope.effects === "object" && !Array.isArray(scope.effects)
    ? scope.effects : {};
  return ["queued", "approved"].includes(request.status)
    && request.idempotencyKey !== null && request.idempotencyKey !== undefined
    && String(request.idempotencyKey).trim().length > 0
    && request.origin === "web"
    && request.kind === MAX_OWNER_NOTIFICATION_KIND
    && request.action === MAX_OWNER_NOTIFICATION_ACTION
    && request.capability === MAX_OWNER_NOTIFICATION_CAPABILITY
    && request.executionMode === MAX_OWNER_NOTIFICATION_EXECUTION_MODE
    && request.contractVersion === 2
    && request.sideEffecting === true
    && request.requestedBy === "max"
    && request.authSource === "hermy_hq_internal_secret"
    && scope.id === MAX_OWNER_NOTIFICATION_POLICY_ID
    && scope.audience === "owner_admins"
    && scope.recipientPolicy === MAX_OWNER_NOTIFICATION_RECIPIENT_POLICY
    && effects.externalIO === true
    && effects.commandExecution === false
    && effects.systemModification === false
    && effects.commercialInference === false
    && effects.irreversibleAction === false
    && ownerNotificationMessageAllowed(request.prompt);
}

/**
 * PostgreSQL's existing side-effect trigger creates a pending ActionApproval and
 * holds every sideEffecting insert. Reuse that same record for this exact
 * server-authorized policy, then return its request to the ordinary queue.
 */
export function isMaxOwnerNotificationPolicyApprovalEligible(request = {}, policyDecision = {}) {
  return policyDecision.autoAuthorized === true
    && ["awaiting_approval", "queued"].includes(request.status)
    && isAuthorizedMaxOwnerNotificationRequest({ ...request, status: "queued" });
}

export async function issueMaxOwnerNotificationPolicyApproval(tx, request, policyDecision) {
  if (!isMaxOwnerNotificationPolicyApprovalEligible(request, policyDecision)) {
    throw new Error("max_owner_notification_policy_contract_invalid");
  }

  const reason = `Server policy ${MAX_OWNER_NOTIFICATION_POLICY_ID} authorized this exact authenticated owner notice.`;
  const approvalId = `approval-${request.id}`;
  const approvalRows = await tx.$executeRawUnsafe(`
    UPDATE "ActionApproval"
    SET status='approved', approved_by=$1, resolved_by=$1,
        decision='server_policy_authorized', reason=$2, resolved_at=now()
    WHERE id=$3 AND request_id=$4 AND action='execute' AND status='pending'
  `, MAX_OWNER_NOTIFICATION_POLICY_APPROVER, reason, approvalId, request.id);
  if (Number(approvalRows) !== 1) {
    throw new Error("max_owner_notification_policy_approval_unavailable");
  }

  const requestRows = await tx.$executeRawUnsafe(`
    UPDATE "AgentRequest"
    SET status='queued', "decidedAt"=now()
    WHERE id=$1 AND status IN ('awaiting_approval','queued')
      AND origin='web' AND kind=$2 AND action=$3 AND capability=$4
      AND "executionMode"=$5 AND "contractVersion"=2 AND "sideEffecting"=TRUE
      AND "requestedBy"='max' AND "authSource"='hermy_hq_internal_secret'
      AND "idempotencyKey"=$6 AND scope=$7::jsonb AND prompt=$8
  `, request.id, MAX_OWNER_NOTIFICATION_KIND, MAX_OWNER_NOTIFICATION_ACTION,
  MAX_OWNER_NOTIFICATION_CAPABILITY, MAX_OWNER_NOTIFICATION_EXECUTION_MODE,
  request.idempotencyKey, JSON.stringify(request.scope), request.prompt);
  if (Number(requestRows) !== 1) {
    throw new Error("max_owner_notification_policy_request_unavailable");
  }

  return tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
}
