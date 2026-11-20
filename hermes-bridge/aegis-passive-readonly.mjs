import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const SERVICE_UNITS = Object.freeze([
  "hermy-hq-bridge-vps.service",
  "hermy-hq-vps.service",
  "hermes-gateway-vps.service",
  "hermes-excelnt-egress.service",
  "tailscaled.service",
  "ufw.service",
  "nftables.service",
  "firewalld.service",
]);
const JOURNAL_UNITS = Object.freeze(SERVICE_UNITS.slice(0, 5));
const MAX_LISTENER_LINES = 256;
const MAX_JOURNAL_LINES = 100;

function failureClass(error) {
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission_denied";
  if (error?.code === "ENOENT") return "command_unavailable";
  return "command_failed";
}

async function invoke(run, file, args, timeout = 3000) {
  try {
    const result = await run(file, args, { timeout, maxBuffer: 256 * 1024 });
    return { ok: true, stdout: String(result?.stdout ?? "") };
  } catch (error) {
    return { ok: false, reason: failureClass(error) };
  }
}

function parseProperties(stdout) {
  return Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf("=");
    return split < 0 ? ["", ""] : [line.slice(0, split), line.slice(split + 1)];
  }).filter(([key]) => key));
}

function parseListenerSummary(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bounded = lines.slice(0, MAX_LISTENER_LINES);
  const ports = new Set();
  for (const line of bounded) {
    const fields = line.split(/\s+/);
    const local = fields[3] || "";
    const match = local.match(/:(\d+|\*)$/);
    if (match) ports.add(match[1]);
  }
  return {
    status: "available",
    socketCount: lines.length,
    ports: [...ports].sort((a, b) => a === "*" ? 1 : b === "*" ? -1 : Number(a) - Number(b)),
    truncated: lines.length > bounded.length,
  };
}

async function readSystemdUnit(run, unit) {
  const result = await invoke(run, "systemctl", [
    "show", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", unit,
  ]);
  if (!result.ok) return { unit, status: "unavailable", reason: result.reason };
  const properties = parseProperties(result.stdout);
  return {
    unit,
    status: properties.LoadState === "not-found" ? "not-installed" : "available",
    loadState: properties.LoadState || "unknown",
    activeState: properties.ActiveState || "unknown",
    subState: properties.SubState || "unknown",
  };
}

async function readFirewallStatus(run) {
  const result = await invoke(run, "ufw", ["status"]);
  if (!result.ok) return { status: "unavailable", reason: result.reason };
  const match = result.stdout.match(/^\s*Status:\s*(active|inactive)\s*$/im);
  return match ? { status: "available", ufw: match[1].toLowerCase() } : { status: "unavailable", reason: "unrecognized_status" };
}

async function readTailscaleStatus(run) {
  const result = await invoke(run, "tailscale", ["status", "--json"]);
  if (!result.ok) return { status: "unavailable", reason: result.reason };
  try {
    const data = JSON.parse(result.stdout);
    return {
      status: "available",
      backendState: typeof data.BackendState === "string" ? data.BackendState : "unknown",
      selfOnline: typeof data.Self?.Online === "boolean" ? data.Self.Online : null,
    };
  } catch {
    return { status: "unavailable", reason: "invalid_status_payload" };
  }
}

async function readEventSummary(run) {
  const args = ["--quiet", "--no-pager", "--output=json", "--since=-1 hour", `--lines=${MAX_JOURNAL_LINES}`];
  for (const unit of JOURNAL_UNITS) args.push("--unit", unit);
  const result = await invoke(run, "journalctl", args, 5000);
  if (!result.ok) return { status: "unavailable", reason: result.reason };

  const countsByPriority = {};
  let eventCount = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_JOURNAL_LINES)) {
    try {
      const entry = JSON.parse(line);
      const priority = String(entry.PRIORITY ?? "unknown");
      countsByPriority[priority] = (countsByPriority[priority] || 0) + 1;
      eventCount += 1;
    } catch {
      // Ignore malformed journal rows; never return raw messages.
    }
  }
  return { status: "available", window: "1h", eventCount, countsByPriority };
}

export async function collectAegisPassiveSnapshot(run = execFileP) {
  const [services, tcp, udp, firewall, tailscale, events] = await Promise.all([
    Promise.all(SERVICE_UNITS.map((unit) => readSystemdUnit(run, unit))),
    invoke(run, "ss", ["-H", "-lnt"]),
    invoke(run, "ss", ["-H", "-lun"]),
    readFirewallStatus(run),
    readTailscaleStatus(run),
    readEventSummary(run),
  ]);

  const listenerSummary = (result) => result.ok
    ? parseListenerSummary(result.stdout)
    : { status: "unavailable", reason: result.reason };
  const checks = {
    services,
    listeners: { tcp: listenerSummary(tcp), udp: listenerSummary(udp) },
    firewall,
    tailscale,
    events,
  };
  const unavailable = [
    ...services.filter((item) => item.status === "unavailable"),
    checks.listeners.tcp,
    checks.listeners.udp,
    firewall,
    tailscale,
    events,
  ].filter((item) => item.status === "unavailable").length;

  return {
    schema: "aegis.passive.v1",
    status: unavailable === 0 ? "ok" : "partial",
    checkedAt: new Date().toISOString(),
    execution: { privilegeEscalationAttempted: false, activeNetworkScan: false, externalRequests: 0, sideEffects: false },
    checks,
  };
}
