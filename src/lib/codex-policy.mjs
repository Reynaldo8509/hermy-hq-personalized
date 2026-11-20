import { createHash } from "node:crypto";
import { codexTaskPolicy } from "../../hermes-bridge/codex-task-contract.mjs";
export const CODEX_POLICY_STORE_KEY = "codex-delegation-policy";
export const CODEX_LOCAL_TIME_QUOTA_ENABLED = false;
export const CODEX_POLICY_LIMITS = Object.freeze({ maxRunsPerFiveHours: 1, maxRunsPerSevenDays: 3 }); // legacy telemetry only
export const DEFAULT_CODEX_POLICY = Object.freeze({ minimumPriority: "critical", requireApprovalForSideEffects: true, localTimeQuotaEnabled: false, ...CODEX_POLICY_LIMITS });
const PRIORITY_RANK = Object.freeze({ important: 1, critical: 2 });
const AUTO_TASK_CLASSES = new Set(["complex_engineering", "complex_debug", "critical_incident", "complex_deployment", "complex_migration", "architecture_change", "advanced_repair"]);
const ROUTINE_TASK_CLASSES = new Set(["summary", "simple_classification", "uptime", "status", "monitoring", "routine_health", "normal_research", "formatting", "simple_json", "simple_tool_call", "scheduled_routine", "chat", "trivial_planning"]);

export function normalizeCodexPolicy(value) {
  const minimumPriority = ["important", "critical", "paused"].includes(value?.minimumPriority) ? value.minimumPriority : DEFAULT_CODEX_POLICY.minimumPriority;
  return { minimumPriority, requireApprovalForSideEffects: true, localTimeQuotaEnabled: false, ...CODEX_POLICY_LIMITS };
}

export function codexAdmission({ requestedBy = "agent", requestedExecutor = "codex", priority, taskClass, codexRequiredReason, lowerRouteFailed = false, exclusiveCapability = false, requiredCapability, policyValue } = {}) {
  const explicitOwnerRequest = requestedBy === "owner" && requestedExecutor === "codex";
  const fallbackClass = ["analysis_only", "code_generation", "structured_tools", "restricted_execution", "privileged_execution"].includes(taskClass) ? taskClass : "analysis_only";
  const base = { priority: priority || null, task_class: taskClass || null, explicit_owner_request: explicitOwnerRequest, requested_executor: requestedExecutor || null, required_capability: requiredCapability || fallbackClass, codex_required_reason: codexRequiredReason || null, fallback_class: fallbackClass };
  if (requestedExecutor !== "codex") return { admitted: false, reason: "executor_not_codex", ...base };
  if (explicitOwnerRequest) return { admitted: true, reason: "authenticated_owner_explicit_executor", ...base };
  if (!codexRequiredReason || !AUTO_TASK_CLASSES.has(taskClass) || ROUTINE_TASK_CLASSES.has(taskClass)) return { admitted: false, reason: "task_class_or_required_reason_missing", ...base };
  if (priority === "critical") return { admitted: true, reason: "critical_engineering_capability", ...base };
  if (priority === "important" && (lowerRouteFailed === true || exclusiveCapability === true)) return { admitted: true, reason: lowerRouteFailed ? "lower_route_failed" : "exclusive_capability_required", ...base };
  const policy = normalizeCodexPolicy(policyValue);
  return { admitted: false, reason: policy.minimumPriority === "paused" ? "policy_paused" : "priority_or_capability_gate", ...base };
}

export function isCodexPriorityAllowed(priority, policyValue) {
  return priority === "critical" && normalizeCodexPolicy(policyValue).minimumPriority !== "paused";
}

export function normalizeCodexAssignment(value) {
  if (!value || typeof value !== "object") return null;
  const priority = String(value.priority || "").trim().toLowerCase();
  if (!Object.hasOwn(PRIORITY_RANK, priority)) return null;
  const target = String(value.target || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const expectedOutcome = String(value.expectedOutcome || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const rationale = String(value.rationale || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const taskClass = String(value.taskClass || value.task_class || "").trim().toLowerCase().slice(0, 60);
  const codexRequiredReason = String(value.codexRequiredReason || value.codex_required_reason || rationale).replace(/\s+/g, " ").trim().slice(0, 300);
  const lowerRouteFailed = value.lowerRouteFailed === true || value.lower_route_failed === true;
  const exclusiveCapability = value.exclusiveCapability === true || value.exclusive_capability === true || value.requiresCodexCapability === true || value.requires_codex_capability === true;
  const requestedBy = value.requestedBy === "owner" || value.requested_by === "owner" ? "owner" : "agent";
  const requestedExecutor = String(value.requestedExecutor || value.requested_executor || "codex").trim().toLowerCase();
  const requiredCapability = String(value.requiredCapability || value.required_capability || "codex_worker_readonly").trim().slice(0, 80);
  const parentRequestId = String(value.parentRequestId || value.parent_request_id || "").trim().slice(0, 80);
  const normalizedIntent = String(value.normalizedIntent || value.normalized_intent || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (target.length < 8 || expectedOutcome.length < 12 || rationale.length < 24 || !taskClass || !codexRequiredReason) return null;
  return { priority, target, expectedOutcome, rationale, taskClass, codexRequiredReason, lowerRouteFailed, exclusiveCapability, requestedBy, requestedExecutor, requiredCapability, parentRequestId, normalizedIntent };
}

export function codexAssignmentFromPrompt(prompt) {
  const firstLine = String(prompt || "").split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^\[\[CODEX_ASSIGNMENT_V1:(\{.*\})\]\]$/);
  if (!match) return null;
  try { return normalizeCodexAssignment(JSON.parse(match[1])); } catch { return null; }
}

export function codexAssignmentAllowed(prompt, policyValue, status, task = null) {
  const assignment = codexAssignmentFromPrompt(prompt);
  if (!assignment) return false;
  if (!task) return status === "approved" && codexAdmission({ ...assignment, requestedBy: "agent", policyValue }).admitted;
  const explicitOwner = task.origin === "web" && task.manualOverrideAuthorized === true;
  const parentMarker = String(prompt || "").match(/^\[\[CODEX_PARENT_V1:([a-zA-Z0-9_-]+)\]\]$/m)?.[1];
  if (!explicitOwner && assignment.parentRequestId && assignment.parentRequestId !== parentMarker) return false;
  const admission = codexAdmission({ ...assignment, requestedBy: explicitOwner ? "owner" : assignment.requestedBy, requestedExecutor: assignment.requestedExecutor, requiredCapability: assignment.requiredCapability, policyValue });
  if (!admission.admitted) return false;
  if (explicitOwner) return codexTaskPolicy({ ...task, prompt, status }, status, true).eligible;
  return codexTaskPolicy({ ...task, prompt, status }, status).eligible;
}

export function codexParentRequestId(task) {
  const prompt = String(task?.prompt || "");
  const assignment = codexAssignmentFromPrompt(prompt) || {};
  return prompt.match(/^\[\[CODEX_PARENT_V1:([a-zA-Z0-9_-]+)\]\]$/m)?.[1]
    || assignment.parentRequestId
    || task?.parentRequestId
    || null;
}

export function codexParentAttemptAllowed(task, siblings = []) {
  if (task?.origin !== "max") return true;
  const parent = codexParentRequestId(task);
  if (!parent) return true;
  const taskTime = new Date(task.createdAt || 0).getTime();
  return !siblings.some((sibling) => {
    if (!sibling || sibling.id === task.id || sibling.origin && sibling.origin !== "max") return false;
    if (codexParentRequestId(sibling) !== parent) return false;
    const siblingTime = new Date(sibling.createdAt || 0).getTime();
    if (Number.isFinite(taskTime) && Number.isFinite(siblingTime) && siblingTime !== taskTime) return siblingTime < taskTime;
    return String(sibling.id || "") < String(task.id || "");
  });
}

export function codexTaskFingerprint(task) {
  const prompt = String(task?.prompt || "");
  const assignment = codexAssignmentFromPrompt(prompt) || {};
  const parent = codexParentRequestId(task) || "unscoped";
  const payload = (prompt.split("[Tarea solicitada]").at(-1) || prompt).toLowerCase().replace(/\s+/g, " ").trim();
  const normalized = [parent, assignment.normalizedIntent || payload, String(assignment.target || "").toLowerCase().replace(/\s+/g, " ").trim(), assignment.taskClass || task?.kind || ""].join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}
