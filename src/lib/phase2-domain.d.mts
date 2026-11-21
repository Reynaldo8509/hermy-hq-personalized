export type AgentId = "max" | "codex" | "atlas" | "aegis" | "ledger" | "milo" | "pulse" | "domus";
export interface TaskRequestSpec {
  origin: string; kind: string; title: string; prompt: string;
  sideEffecting: boolean; status: string; dependsOn: string[]; requestedAgent: AgentId;
}
export function buildTaskRequest(agentId: string, title: string, prompt: string, requiresApproval?: boolean, dependencies?: string[]): TaskRequestSpec;
export function agentForKind(kind: string, origin?: string): AgentId;
export function stableJson(value: unknown): string;
export function approvalParameters(request: any): Record<string, unknown>;
export function approvalMatches(approval: any, request: any): boolean;
export function approvalIsFresh(approval: any, now?: number): boolean;
export type ApprovalTransition = { ok: true; status: "approved" | "rejected"; duplicate: boolean } | { ok: false; status: number; error: string; expired?: boolean };
export function approvalTransition(approval: any, decision: "approve" | "reject", now?: number): ApprovalTransition;
export function taskActionAllowed(action: string, status: string, sideEffecting: boolean, retryCount?: number): boolean;
export function dependenciesAreDone(dependencies: string[], requestById: Map<string, any>): boolean;
export function incidentResolutionError(evidence: string, validation: string): string | null;
export function groupIncidentRows(rows: any[]): any[];
export function isAllowlistedActor(email: string, allowlist: string): boolean;
export function sameRequestPayload(existing: any, payload: any): boolean;
export function approvalDigest(request: any): string;
