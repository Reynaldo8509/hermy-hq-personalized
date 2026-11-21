const SAFE_DIAGNOSTICS = [
  ["rate-limited", /\b429\b|too many requests/i],
  ["unauthorized", /\b401\b|unauthorized|invalid token/i],
  ["forbidden", /\b403\b|forbidden|blocked by user/i],
  ["target-not-found", /chat not found|peer_id_invalid|target not found/i],
  ["dns-failure", /\b(?:EAI_AGAIN|ENOTFOUND)\b/i],
  ["connection-refused", /\bECONNREFUSED\b/i],
  ["network-unreachable", /\b(?:ENETUNREACH|EHOSTUNREACH|ECONNRESET)\b/i],
  ["timeout", /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|timed? out|timeout)\b/i],
  ["tls-failure", /\b(?:TLS|SSL|CERT_HAS_EXPIRED|ERR_TLS)\b/i],
  ["remote-error", /\b(?:500|502|503|504)\b/],
];

export function telegramFailureSummary(error) {
  const code = error && error.code;
  const outcome = Number.isInteger(code) ? "exit " + code
    : error && error.signal ? "signal " + String(error.signal).replace(/[^A-Z0-9_-]/gi, "").slice(0, 24)
    : typeof code === "string" && /^[A-Z0-9_-]{2,32}$/i.test(code) ? code
    : error && error.killed ? "terminated" : "command error";
  const evidence = [error && error.stderr, error && error.stdout].filter(Boolean).join("\n");
  const match = SAFE_DIAGNOSTICS.find(([, pattern]) => pattern.test(evidence));
  return outcome + ": " + (match ? match[0] : "cause not captured");
}
