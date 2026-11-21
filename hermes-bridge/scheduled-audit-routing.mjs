import { isScheduledLedgerAudit, isScheduledLedgerAuditShape } from "./ledger-audit.mjs";
import { isScheduledDomusAudit, isScheduledDomusAuditShape } from "./domus-audit.mjs";
import { isAuthorizedDeterministicAgentRead } from "./local-agent-reads.mjs";

export function scheduledReadOnlyAuditKind(request, schedulerProvenance = null) {
  if (isScheduledLedgerAudit(request, schedulerProvenance)) return "ledger";
  if (isScheduledDomusAudit(request, schedulerProvenance)) return "domus";
  return null;
}

export function routeFailureForRequest(request, modelRoute, schedulerProvenance = null) {
  const authenticatedKind = scheduledReadOnlyAuditKind(request, schedulerProvenance);
  if (authenticatedKind) return null;
  if (isAuthorizedDeterministicAgentRead(request)) return null;
  if (schedulerProvenance || request?.kind === "ledger.operations"
      || (request?.kind === "domus.home" && request?.origin === "system")
      || isScheduledLedgerAuditShape(request) || isScheduledDomusAuditShape(request)) {
    return schedulerProvenance ? "SCHEDULER_PROVENANCE_INVALID" : "SCHEDULER_PROVENANCE_REQUIRED";
  }
  if (modelRoute?.tier === "local_model_unavailable") return "LOCAL_MODEL_UNAVAILABLE";
  if (modelRoute?.tier === "remote_free_unavailable") return "REMOTE_FREE_ROUTE_UNAVAILABLE";
  return null;
}
