export const INFRA_HISTORY_MAX_SAMPLES = 336; // 7 days at 30-minute intervals

export function peerAvailability(peer) {
  if (!peer) {
    return { status: "no-data", powerState: "unknown", lastSeenAt: null, hostname: null, os: null };
  }
  const online = peer.Online === true;
  const lastSeenAt = peer.LastSeen && !String(peer.LastSeen).startsWith("0001-01-01")
    ? new Date(peer.LastSeen).toISOString()
    : null;
  return {
    status: online ? "online" : peer.Online === false ? "offline" : "no-data",
    // Tailscale does not say whether a disconnected laptop is asleep or powered off.
    powerState: "not-reported",
    lastSeenAt,
    hostname: String(peer.HostName || "").slice(0, 100) || null,
    os: String(peer.OS || "").slice(0, 40) || null,
  };
}

export function endpointAvailability(peerOnline, statusCode, errorCode = null) {
  if (!peerOnline) return { status: "offline", errorClass: null };
  if (statusCode === 401 || statusCode === 403) return { status: "authentication-error", errorClass: "authorization" };
  if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300) return { status: "online", errorClass: null };
  if (errorCode === "ETIMEDOUT" || errorCode === "ABORT_ERR" || errorCode === "TimeoutError") {
    return { status: "service-unavailable", errorClass: "timeout" };
  }
  if (statusCode === 404) return { status: "service-unavailable", errorClass: "not-found" };
  return { status: "service-unavailable", errorClass: statusCode ? "http-error" : "network-error" };
}

export function optionalGpuMetricsStatus(modelApiStatus) {
  // Keep the existing input contract, but never derive an unqueried GPU
  // endpoint's status from the separate Qwen model API result.
  void modelApiStatus;
  return "not-queried";
}

export function normalizeLegacyQwenMetrics(nodes) {
  const source = nodes && typeof nodes === "object" && !Array.isArray(nodes) ? nodes : {};
  const dell = source["dell-g15"];
  const qwen = dell?.qwen;
  if (qwen?.metricsStatus !== "authentication-error") return source;
  return {
    ...source,
    "dell-g15": {
      ...dell,
      qwen: { ...qwen, metricsStatus: "not-queried" },
    },
  };
}

export function classifyInferenceError(reason) {
  const value = String(reason || "");
  if (!value) return null;
  if (/\b429\b|rate.?limit|too many requests/i.test(value)) return "429";
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}key/i.test(value)) return "401";
  if (/timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(value)) return "timeout";
  return "other";
}

export function appendTelemetrySample(history, sample, now = Date.now(), maxSamples = INFRA_HISTORY_MAX_SAMPLES) {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const prior = Array.isArray(history) ? history : [];
  const valid = prior.filter((item) => item && Number.isFinite(Date.parse(item.collectedAt))
    && Date.parse(item.collectedAt) >= cutoff);
  valid.push(sample);
  return valid.sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt)).slice(-maxSamples);
}

export function summarizeFallback(attempts) {
  const requests = new Map();
  for (const attempt of attempts || []) {
    if (!attempt.request_id) continue;
    const value = requests.get(attempt.request_id) || { attempts: 0, fallback: false };
    value.attempts += 1;
    value.fallback ||= Number(attempt.attempt_no) > 1;
    requests.set(attempt.request_id, value);
  }
  const totalRequests = requests.size;
  const fallbackRequests = [...requests.values()].filter((item) => item.fallback).length;
  return {
    totalRequests,
    fallbackRequests,
    fallbackRate: totalRequests ? fallbackRequests / totalRequests : null,
  };
}

function normalizedHostname(value) {
  return String(value || "").split(".")[0].trim().toLocaleLowerCase("en");
}

export function tailnetObservationMaxAgeMs(sampleIntervalSeconds) {
  const seconds = Number(sampleIntervalSeconds);
  const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  const oneCycleWithGrace = intervalMs + 5 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(15 * 60 * 1000, oneCycleWithGrace));
}

export function resolveFreshRemoteStatus(reportedStatus, metricsFresh) {
  if (!metricsFresh) return "no-data";
  const allowed = new Set(["online", "offline", "sleeping", "service-unavailable", "authentication-error", "no-data", "unknown"]);
  return typeof reportedStatus === "string" && allowed.has(reportedStatus) ? reportedStatus : "unknown";
}

export function resolveTailnetReachability({
  expectedAliases = [], peers = [], observedAt, now = Date.now(), maxAgeMs = 15 * 60 * 1000,
}) {
  const observedMs = Date.parse(String(observedAt || ""));
  if (!Number.isFinite(observedMs) || now - observedMs > maxAgeMs || observedMs - now > 5 * 60 * 1000) return null;

  const byHostname = new Map();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const hostname = normalizedHostname(peer?.hostname ?? peer?.hostName ?? peer?.HostName ?? peer?.name);
    if (hostname && typeof peer?.online === "boolean") byHostname.set(hostname, peer);
  }

  const configuredAliases = (Array.isArray(expectedAliases) ? expectedAliases : [])
    .map(normalizedHostname).filter(Boolean);
  const configuredMatch = configuredAliases.find((hostname) => byHostname.has(hostname));
  // A configured identity prevents a mutable snapshot hostname from rebinding a
  // node to another peer. Keep aliases in deployment configuration, not source.
  const matchedHostname = configuredAliases.length ? configuredMatch : null;
  if (!matchedHostname) return null;

  const peer = byHostname.get(matchedHostname);
  const hostname = String(peer.hostname ?? peer.hostName ?? peer.HostName ?? peer.name ?? matchedHostname).split(".")[0];
  const lastSeenAt = typeof peer.lastSeenAt === "string" && Number.isFinite(Date.parse(peer.lastSeenAt))
    ? new Date(peer.lastSeenAt).toISOString()
    : null;
  const identityMatched = configuredAliases.includes(matchedHostname);

  return {
    status: peer.online ? "online" : "offline",
    source: "tailscale",
    checkedAt: new Date(observedMs).toISOString(),
    hostname,
    lastSeenAt,
    identityMatched,
  };
}
