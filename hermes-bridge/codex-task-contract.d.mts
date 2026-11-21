export type CodexIntent = "read_only" | "write";
export type CodexTaskContract = {
  origin: string;
  kind: string;
  status: string;
  sideEffecting: boolean;
  action: string | null;
  capability: string | null;
  prompt: string | null;
};
export function codexIntentMarker(prompt: unknown): CodexIntent | null;
export function codexTaskPayload(prompt: unknown): string | null;
export function codexTaskPolicy(task: CodexTaskContract, status?: string, manualOverrideAuthorized?: boolean): { eligible: boolean; intent?: CodexIntent; reason: string | null };
