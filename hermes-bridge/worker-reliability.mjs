export const MAX_TRANSPORT_RETRY_MS = 60_000;

export function isTransportFailure(error) {
  return Boolean(
    error &&
    ((error.name === "TypeError" && String(error.message || "").toLowerCase() === "fetch failed") ||
      error.name === "TimeoutError" ||
      error.name === "AbortError")
  );
}

export function retryDelayMs(baseDelayMs, consecutiveFailures) {
  const base = Number.isFinite(Number(baseDelayMs)) ? Math.max(250, Number(baseDelayMs)) : 5_000;
  const attempt = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
  const exponent = Math.min(attempt - 1, 10);
  return Math.min(base * (2 ** exponent), MAX_TRANSPORT_RETRY_MS);
}

export function safeTransportCause(error) {
  const code = String(error && error.cause && error.cause.code || "");
  const causeName = String(error && error.cause && error.cause.name || "");
  const name = error && ["TypeError", "TimeoutError", "AbortError", "Error"].includes(error.name) ? error.name : "Error";
  const safeCode = /^[A-Z0-9_]{2,40}$/.test(code) ? code : "";
  const safeName = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(causeName) ? causeName : "";
  return name + " cause=" + (safeCode || safeName || "unknown");
}
