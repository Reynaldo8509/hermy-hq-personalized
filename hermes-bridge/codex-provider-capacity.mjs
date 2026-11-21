import { spawn as nodeSpawn } from "node:child_process";

export const CODEX_CAPACITY_SOURCE = "codex_app_server_account_rate_limits_read";
export const CODEX_CAPACITY_TTL_MS = 60_000;

function findValue(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function normalizeCodexCapacity(result, checkedAt = new Date().toISOString()) {
  const rateLimitReachedType = findValue(result, "rateLimitReachedType");
  const spendControlReached = findValue(result, "spendControlReached");
  const primary = findValue(result, "primary");
  const secondary = findValue(result, "secondary");
  const primaryUsed = primary?.usedPercent ?? findValue(result, "usedPercent");
  const weeklyUsed = secondary?.usedPercent ?? findValue(result, "weeklyUsedPercent") ?? findValue(result, "secondaryUsedPercent");
  const resetAt = primary?.resetsAt ?? primary?.resetAt ?? findValue(result, "resetAt") ?? null;
  const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const used = numberOrNull(primaryUsed);
  const weekly = numberOrNull(weeklyUsed);
  const exhausted = (rateLimitReachedType !== undefined && rateLimitReachedType !== null && rateLimitReachedType !== "") || spendControlReached === true;
  const interpretable = (rateLimitReachedType === null || rateLimitReachedType === undefined || rateLimitReachedType === "") && spendControlReached === false;
  return {
    provider: "openai", surface: "codex", state: exhausted ? "exhausted" : interpretable ? "available" : "unknown",
    primary_used_percent: used, weekly_used_percent: weekly, remaining_percent: used === null ? null : Math.max(0, 100 - used),
    reset_at: typeof resetAt === "string" ? resetAt : null, checked_at: checkedAt, source: CODEX_CAPACITY_SOURCE,
    reason: exhausted ? String(rateLimitReachedType || "spend_control_reached") : interpretable ? null : "capacity_response_uninterpretable",
  };
}

export function readCodexRateLimits(binary = process.env.CODEX_BIN || "/usr/local/bin/codex", spawn = nodeSpawn, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
    const waiters = new Map();
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("capacity_rpc_timeout")), timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      try { child.kill("SIGTERM"); } catch {}
      error ? reject(error) : resolve(result);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && waiters.has(message.id)) {
          const waiter = waiters.get(message.id); waiters.delete(message.id);
          if (message.error) waiter.reject(new Error("capacity_rpc_error")); else waiter.resolve(message.result);
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("error", () => finish(new Error("capacity_app_server_unavailable")));
    const ask = (id, method, params) => new Promise((res, rej) => { waiters.set(id, { resolve: res, reject: rej }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    (async () => {
      try {
        await ask(1, "initialize", { clientInfo: { name: "hermy-hq-codex-worker", version: "1" }, capabilities: {} });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
        const result = await ask(2, "account/rateLimits/read", {});
        finish(null, result);
      } catch (error) { finish(error); }
    })();
  });
}

export function createCodexCapacityReader({ read = readCodexRateLimits, now = () => Date.now(), ttlMs = CODEX_CAPACITY_TTL_MS } = {}) {
  let cached = null;
  return async ({ force = false, providerLimitReason = null } = {}) => {
    if (providerLimitReason) { cached = { provider: "openai", surface: "codex", state: "exhausted", primary_used_percent: null, weekly_used_percent: null, remaining_percent: null, reset_at: null, checked_at: new Date(now()).toISOString(), source: "openai_runtime_response", reason: String(providerLimitReason).slice(0, 120) }; return cached; }
    if (!force && cached && now() - Date.parse(cached.checked_at) < ttlMs) return cached;
    try { cached = normalizeCodexCapacity(await read(), new Date(now()).toISOString()); }
    catch (error) { cached = { provider: "openai", surface: "codex", state: "unknown", primary_used_percent: null, weekly_used_percent: null, remaining_percent: null, reset_at: null, checked_at: new Date(now()).toISOString(), source: CODEX_CAPACITY_SOURCE, reason: String(error?.message || "capacity_read_failed").slice(0, 120) }; }
    return cached;
  };
}
