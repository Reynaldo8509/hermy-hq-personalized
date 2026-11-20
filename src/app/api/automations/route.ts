import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { createQueueRequest, readIdempotencyKey } from "@/lib/queue-request";
import { SYSTEMD_AUTOMATIONS, systemdActionAllowed } from "@/lib/phase4-domain.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const ACTIVE_REQUEST_STATES = ["awaiting_approval", "approved", "queued", "running"];
const TIMER_PROPS = ["Id", "Description", "ActiveState", "SubState", "UnitFileState", "Triggers", "LastTriggerUSec", "NextElapseUSecRealtime", "TimersCalendar", "TimersMonotonic"];
const SERVICE_PROPS = ["Id", "ActiveState", "SubState", "Result", "ExecMainStatus", "ExecMainStartTimestamp", "ExecMainExitTimestamp", "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic"];
let cache: { at: number; timers: Record<string, unknown>[] } | null = null;

function parseProperties(output: string) {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
  }
  return values;
}

async function show(unit: string, properties: string[]) {
  const args = ["show", unit, ...properties.flatMap((property) => ["-p", property]), "--no-pager"];
  const result = await execFileP("systemctl", args, { timeout: 4000, maxBuffer: 16 * 1024 });
  return parseProperties(String(result.stdout || ""));
}

function parseTimers(output: string) {
  const result = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/([^\s]+\.timer)\s+([^\s]+\.service)\s*$/);
    if (match) result.set(match[1], match[2]);
  }
  return result;
}

async function readInventory() {
  if (cache && Date.now() - cache.at < 30_000) return cache.timers;
  const [listedTimers, unitFiles] = await Promise.all([
    execFileP("systemctl", ["list-timers", "--all", "--no-legend", "--no-pager"], { timeout: 5000, maxBuffer: 128 * 1024 }),
    execFileP("systemctl", ["list-unit-files", "--type=timer", "--no-legend", "--no-pager"], { timeout: 5000, maxBuffer: 128 * 1024 }),
  ]);
  const activatedServices = parseTimers(String(listedTimers.stdout || ""));
  const states = new Map<string, string>();
  for (const line of String(unitFiles.stdout || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0]?.endsWith(".timer")) states.set(parts[0], parts[1] || "unknown");
  }
  for (const timer of activatedServices.keys()) if (!states.has(timer)) states.set(timer, "unknown");
  const rows = await Promise.all([...states.keys()].sort().map(async (unit) => {
    const timer: Record<string, string> = await show(unit, TIMER_PROPS).catch(() => ({} as Record<string, string>));
    const configured = SYSTEMD_AUTOMATIONS[unit as keyof typeof SYSTEMD_AUTOMATIONS];
    const actualTriggers = String(timer.Triggers || activatedServices.get(unit) || "").split(/\s+/).filter((name) => /^[A-Za-z0-9_.@:-]+\.service$/.test(name));
    const service = configured?.service || actualTriggers[0] || null;
    const serviceState: Record<string, string> = service ? await show(service, SERVICE_PROPS).catch(() => ({} as Record<string, string>)) : {};
    const startMono = Number(serviceState.ExecMainStartTimestampMonotonic || 0);
    const exitMono = Number(serviceState.ExecMainExitTimestampMonotonic || 0);
    const durationMs = startMono > 0 && exitMono >= startMono ? Math.round((exitMono - startMono) / 1000) : null;
    return {
      unit, label: configured?.label || String(timer.Description || unit), objective: configured?.objective || null,
      schedule: [timer.TimersCalendar, timer.TimersMonotonic].filter(Boolean).join("; ") || null,
      nextRun: timer.NextElapseUSecRealtime || null,
      lastRun: [serviceState.ExecMainStartTimestamp, timer.LastTriggerUSec].find((value) => value && value !== "n/a" && !Number.isNaN(Date.parse(value))) || null,
      lastResult: serviceState.Result || null,
      lastExitStatus: serviceState.ExecMainStatus || null,
      durationMs,
      activeState: timer.ActiveState || "unknown", subState: timer.SubState || "unknown",
      unitFileState: states.get(unit) || timer.UnitFileState || "unknown",
      service, serviceActiveState: serviceState.ActiveState || "unknown",
      serviceSubState: serviceState.SubState || "unknown",
      managed: Boolean(configured),
      allowedActions: configured ? ["enable", "disable", "run"] : [],
      source: /^(hermes|hermy|milo)-/.test(unit) ? "hermy" : "systemd",
    };
  }));
  cache = { at: Date.now(), timers: rows };
  return rows;
}

function scrubLogLine(line: string) {
  return line
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|\d{7,}:[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .slice(0, 360);
}

export async function GET(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const url = new URL(req.url);
  const logsFor = (url.searchParams.get("logsFor") || "").trim();
  if (logsFor) {
    const configured = SYSTEMD_AUTOMATIONS[logsFor as keyof typeof SYSTEMD_AUTOMATIONS];
    if (!configured) return NextResponse.json({ error: "Unidad fuera de la lista autorizada" }, { status: 403 });
    try {
      const result = await execFileP("journalctl", ["-u", configured.service, "-n", "40", "--no-pager", "-o", "short-iso"], { timeout: 5000, maxBuffer: 32 * 1024 });
      const lines = String(result.stdout || "").split("\n").filter((line) => /error|failed|warning|finished|started|result|success|exit code/i.test(line)).slice(-20).map(scrubLogLine);
      return NextResponse.json({ unit: logsFor, logs: lines, collectedAt: new Date().toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return NextResponse.json({ unit: logsFor, logs: [], error: "No se pudo leer el journal de esta automatización" }, { status: 503 });
    }
  }
  try {
    return NextResponse.json({ generatedAt: new Date().toISOString(), timers: await readInventory() }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch {
    return NextResponse.json({ error: "No se pudo consultar el inventario systemd" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const timer = String(body.timer || "").trim();
  const action = String(body.action || "").trim();
  if (!systemdActionAllowed(timer, action)) return NextResponse.json({ error: "Automatización o acción fuera de la lista autorizada" }, { status: 403 });
  const key = readIdempotencyKey(req, body);
  const prompt = JSON.stringify({ timer, action });
  try {
    const inFlight = await prisma.agentRequest.findFirst({
      where: { kind: "automation.systemd", prompt, status: { in: ACTIVE_REQUEST_STATES } },
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, title: true, status: true, createdAt: true },
    });
    if (inFlight) return NextResponse.json({ request: inFlight, duplicate: true }, { status: 200 });
    const configured = SYSTEMD_AUTOMATIONS[timer as keyof typeof SYSTEMD_AUTOMATIONS];
    const queued = await createQueueRequest({
      key, actor: auth.actor, origin: "web", kind: "automation.systemd",
      title: `Automatización ${action}: ${configured.label}`.slice(0, 200), prompt,
      sideEffecting: true, action: `timer.${action}`, capability: "systemd.timer.mutate",
      status: "awaiting_approval", dependsOn: [],
    });
    return NextResponse.json({ request: queued.request, duplicate: queued.duplicate }, { status: queued.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Error && "status" in error) return NextResponse.json({ error: error.message }, { status: Number((error as Error & { status: number }).status) });
    return NextResponse.json({ error: "No se pudo crear la solicitud de automatización" }, { status: 500 });
  }
}
