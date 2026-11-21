export const INFRA_HISTORY_MAX_SAMPLES: number;
export function peerAvailability(peer: Record<string, unknown> | null | undefined): {
  status: "online" | "offline" | "no-data";
  powerState: "not-reported" | "unknown";
  lastSeenAt: string | null;
  hostname: string | null;
  os: string | null;
};
export function endpointAvailability(peerOnline: boolean, statusCode: number | null, errorCode?: string | null): {
  status: "online" | "offline" | "authentication-error" | "service-unavailable";
  errorClass: string | null;
};
export function classifyInferenceError(reason: string | null | undefined): "429" | "401" | "timeout" | "other" | null;
export function appendTelemetrySample(history: unknown[], sample: Record<string, unknown>, now?: number, maxSamples?: number): Array<Record<string, unknown>>;
export function summarizeFallback(attempts: Array<{ request_id?: string | null; attempt_no?: number | string | null }>): {
  totalRequests: number;
  fallbackRequests: number;
  fallbackRate: number | null;
};

export function optionalGpuMetricsStatus(modelApiStatus: string | null | undefined): string;
export function normalizeLegacyQwenMetrics(nodes: Record<string, any>): Record<string, any>;

export function tailnetObservationMaxAgeMs(sampleIntervalSeconds: number | null | undefined): number;
export function resolveFreshRemoteStatus(reportedStatus: string | null | undefined, metricsFresh: boolean): "online" | "offline" | "sleeping" | "service-unavailable" | "authentication-error" | "no-data" | "unknown";
export function resolveTailnetReachability(input: {
  expectedAliases?: Array<string | null | undefined>;
  peers?: Array<Record<string, unknown>>;
  observedAt: string | null;
  now?: number;
  maxAgeMs?: number;
}): {
  status: "online" | "offline";
  source: "tailscale";
  checkedAt: string;
  hostname: string;
  lastSeenAt: string | null;
  identityMatched: boolean;
} | null;
