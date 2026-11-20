export type TrustedOperatorIdentity = Readonly<{
  operatorId: string;
  enabled: true;
  publicKeyPem: string;
  fingerprintSha256: string;
  enrolledAt: string | null;
  scopes: string[];
}>;

export type OperatorSignatureResult =
  | { ok: false; reason: string }
  | { ok: true; operatorId: string; fingerprint: string; scopes: string[] };

export type OperatorTaskValidation =
  | { ok: false; status: number; reason: string }
  | {
      ok: true;
      operatorId: string;
      normalized: Record<string, any>;
      operation: Record<string, string>;
      capability: string;
      executionMode: string;
      scope: Record<string, any>;
      fingerprint: string;
    };

export const CODEX_DELL_OPERATOR_ID: string;
export const TRUSTED_OPERATOR_AUTH_SOURCE: string;
export const TRUSTED_OPERATOR_APPROVAL_METHOD: string;
export const TRUSTED_OPERATOR_KIND: string;
export const MAX_OPERATOR_BODY_BYTES: number;
export const MAX_OPERATOR_CLOCK_SKEW_MS: number;
export const ALLOWED_OPERATOR_SERVICES: readonly string[];
export function isCodexDellOperatorPath(method: string, pathname: string): boolean;
export function canonicalOperatorMessage(value: Record<string, unknown>): Buffer;
export function operatorFingerprint(publicKeyPem: string | Buffer): string;
export function verifyOperatorSignature(input: {
  headers: Headers | Record<string, string>;
  method: string;
  pathAndQuery: string;
  rawBody: string;
  identity: TrustedOperatorIdentity | null;
  nowMs?: number;
}): OperatorSignatureResult;
export function loadTrustedOperatorIdentity(options?: Record<string, unknown>): TrustedOperatorIdentity | null;
export function operatorTaskFingerprint(payload: Record<string, unknown>): string;
export function validateOperatorTask(payload: Record<string, unknown>, options?: Record<string, unknown>): OperatorTaskValidation;
export function reconstructOperatorPayload(request: Record<string, unknown>): Record<string, unknown> | null;
export function operatorTaskStatusTransition(currentStatus: string, action: string):
  | { ok: true; status: string }
  | { ok: false; reason: string };
export function readBoundedRequestBody(request: Request, maxBytes?: number):
  Promise<{ ok: true; rawBody: string } | { ok: false; reason: string }>;
export function verifyPackageTree(root: string, tree: Record<string, unknown>, manifest: Record<string, unknown>, options?: Record<string, unknown>): boolean;
