#!/usr/bin/env node
/** Periodic evidence-driven error supervisor for Hermes/Hermy HQ. */
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";

const execFileP = promisify(execFile);
const dbUrl = process.env.DATABASE_URL;
const dryRun = process.argv.includes("--dry-run");
if (!dbUrl) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: dbUrl, max: 1, ssl: /@(localhost|127\.0\.0\.1)/.test(dbUrl) ? undefined : { rejectUnauthorized: false } });
const units = ["hermes-gateway-vps.service", "hermes-vps.service", "hermy-hq-vps.service", "hermy-hq-bridge-vps.service", "codex-hermy-vps.service"];
const q = (text, values = []) => pool.query(text, values);

function compact(value, limit = 700) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }
function successfulSetupEvent(line) {
  try {
    const event = JSON.parse(line);
    return event?.jsonrpc === "2.0" && event.method === "event" &&
      event.params?.type === "setup.ready" &&
      event.params.payload?.provider_configured === true &&
      event.params.payload?.error === "";
  } catch { return false; }
}
function category(value) {
  const text = String(value).toLowerCase();
  if (/telegram|413|payload too large/.test(text)) return "telegram";
  if (/qwen|llm|provider|model|429/.test(text)) return "llm";
  if (/home assistant|alexa|adb|fire tv/.test(text)) return "home-automation";
  if (/database|postgres|sqlite|state\.db/.test(text)) return "database";
  if (/backup|rclone|onedrive|github/.test(text)) return "backup";
  if (/ssh|tailscale|samba|network|timeout|connection/.test(text)) return "connectivity";
  return "service";
}
function isKnownNonActionableJournal(line) {
  const text = String(line || "");
  // Keep these messages in the journal, but do not turn a working fallback or
  // auxiliary title failure into an autonomous Max/Ledger task.
  return /Auxiliary title generation failed: HTTP 400:.*Unsupported reasoning effort: none/i.test(text)
    || /Model fallback: qwen3-8b-local via custom unavailable \(authentication failed\); using .* via custom:cerebras-cloud/i.test(text)
    || /Domus cloud analysis unavailable; falling back to local Qwen/i.test(text)
    || /telegram alert failed/i.test(text)
    || /error: groq no devolvió contenido/i.test(text);
}
function isTelegramReconnectNoise(line) {
  const text = String(line || "");
  return /Sticky Telegram path .* failed; re-walking IPv4 literals/i.test(text)
    || /IPv4 Telegram API IP .* failed/i.test(text)
    || /Telegram network error(?:, scheduling reconnect|\s+\(attempt\s+\d+\/\d+\))/i.test(text)
    || /Connect attempt \d+\/\d+ failed:.*retrying in/i.test(text);
}
function fingerprint(incident) {
  const stable = compact(incident.detail, 240).toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, "<time>")
    .replace(/pid[= :]\d+/gi, "pid=<n>")
    .replace(/\[\d+\]/g, "[pid]")
    .replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${incident.source}|${category(incident.detail)}|${stable}`).digest("hex").slice(0, 24);
}

async function command(file, args) {
  try { return (await execFileP(file, args, { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) { return `${error.stdout || ""}\n${error.stderr || error.message || ""}`; }
}

async function privileged(file, args) {
  return command("sudo", ["-n", file, ...args]);
}

async function collect() {
  const incidents = [];
  const failed = compact(await privileged("systemctl", ["--failed", "--no-legend", "--no-pager"]));
  if (failed) incidents.push({ source: "systemd-failed", detail: failed });
  const unitStates = new Map();
  for (const unit of units) {
    const state = compact(await privileged("systemctl", ["is-active", unit]));
    unitStates.set(unit, state);
    if (state !== "active") incidents.push({ source: unit, detail: `service state=${state}` });
  }
  const quiesceStamp = Date.parse(compact(await privileged("cat", ["/var/lib/hermes-backup/last-quiesce"])));
  const recentBackupQuiesce = Number.isFinite(quiesceStamp) && Date.now() >= quiesceStamp && Date.now() - quiesceStamp < 20 * 60 * 1000;
  const journal = await privileged("journalctl", ["--since", "-20 min", "--no-pager", "-o", "cat", "-u", "hermes-gateway-vps.service", "-u", "hermes-vps.service", "-u", "hermy-hq-bridge-vps.service", "-u", "codex-hermy-vps.service"]);
  const journalLines = journal.split("\n");
  let telegramRetryCount = 0;
  let telegramRecovered = false;
  for (const line of journalLines) {
    if (/Connected to Telegram \(polling mode\)/i.test(line)) telegramRecovered = true;
    else if (isTelegramReconnectNoise(line)) { telegramRetryCount += 1; telegramRecovered = false; }
  }
  const relevant = journalLines.filter((line) => !successfulSetupEvent(line)).filter((line) => !isTelegramReconnectNoise(line))
    .filter((line) => !(recentBackupQuiesce && units.some((unit) => unitStates.get(unit) === "active" && line.startsWith(`${unit}: Failed with result `))))
    .filter((line) => !/Homeassistant.*Reconnection failed: Cannot connect to host 127\.0\.0\.1:8123/i.test(line))
    .filter((line) => /\b(error|failed|exception|traceback|stalled|413|429|no reply|http [45]\d\d)\b/i.test(line)).filter((line) => !/discovering telegram|connecting to telegram/i.test(line))
    .filter((line) => !/^(?:.*\s)?(?:telegram alert failed:|No se pudo enviar aviso de )/i.test(line))
    .filter((line) => !/transient failure; retrying once/i.test(line))
    .filter((line) => !isKnownNonActionableJournal(line))
    // Bridge request failures already have durable AgentRequest records below. Re-queuing their journal copy feeds the same failure back to Max.
    .filter((line) => !/\brequest failed:\s*[0-9a-f-]{36}\b/i.test(line)).slice(-12);
  for (const line of relevant) incidents.push({ source: "journal", detail: compact(line) });
  if (telegramRetryCount >= 3 && !telegramRecovered) incidents.push({
    source: "journal-telegram-connectivity",
    detail: "Telegram reconnection has repeated failures with no successful reconnect in the last 20 minutes"
  });
  // Planned runtime restarts retain failed task records, but need no repair.
  const { rows } = await q(`SELECT kind, title, error FROM "AgentRequest" WHERE status='failed' AND "updatedAt" > now() - interval '20 minutes' AND origin <> 'audit-validation'
    AND origin <> 'system'
    AND kind NOT LIKE 'max.%'
    AND kind NOT IN ('domus.home', 'ledger.operations')
    AND (error IS NULL OR error NOT IN (
      'Cancelled by operator; task execution stopped for full Hermes/Hermy HQ restart',
      'Cancelled by operator; assigned agent task stopped during full runtime restart'
    )) ORDER BY "updatedAt" DESC LIMIT 12`);
  for (const row of rows) incidents.push({ source: `agent:${row.kind}`, detail: compact(`${row.title}: ${row.error}`) });
  const unique = new Map();
  for (const incident of incidents) unique.set(fingerprint(incident), incident);
  return [...unique.entries()].map(([id, incident]) => ({ ...incident, id, category: category(incident.detail) }));
}

async function enqueue(incident) {
  const gate = (await q(`SELECT data FROM "DataStore" WHERE key='agent-emergency-gate'`)).rows[0]?.data;
  if (gate?.active === true && Number(gate.expiresAt || 0) > Date.now()) return "emergency-reset-active";
  const key = `error-supervisor:${incident.id}`;
  const legacyId = createHash("sha256").update(`${incident.source}|${category(incident.detail)}`).digest("hex").slice(0, 24);
  const legacyKey = `error-supervisor:${legacyId}`;
  const previous = (await q('SELECT data FROM "DataStore" WHERE key=$1 OR key=$2 ORDER BY "updatedAt" DESC LIMIT 1', [key, legacyKey])).rows[0]?.data;
  // Require the same normalized journal fingerprint in two supervisor cycles
  // before autonomous escalation. A single transient line is evidence, not a
  // confirmed incident.
  if (incident.source.startsWith("journal")) {
    const observationKey = `error-supervisor-observation:${incident.id}`;
    const observation = (await q('SELECT data FROM "DataStore" WHERE key=$1', [observationKey])).rows[0]?.data || {};
    const count = Number(observation.count || 0) + 1;
    if (!observation.confirmed && count < 2) {
      if (!dryRun) await q(`INSERT INTO "DataStore" (key,data,"updatedAt") VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data,"updatedAt"=now()`, [observationKey, JSON.stringify({ count, firstSeenAt: observation.firstSeenAt || new Date().toISOString(), lastSeenAt: new Date().toISOString() })]);
      return "awaiting-confirmation";
    }
    if (!dryRun && !observation.confirmed) await q(`INSERT INTO "DataStore" (key,data,"updatedAt") VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data,"updatedAt"=now()`, [observationKey, JSON.stringify({ ...observation, count, confirmed: true, confirmedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })]);
  }
  const now = Date.now();
  const episodeWindowMs = 30 * 60 * 1000;
  const legacyMigrationWindowMs = 2 * 60 * 60 * 1000;
  // Keep one Max task per active incident episode. The supervisor runs every 15m;
  // refreshing lastSeen prevents a persistent journal line from reopening work.
  const lastSeen = previous?.lastSeenAt || previous?.at;
  const window = previous?.lastSeenAt ? episodeWindowMs : legacyMigrationWindowMs;
  // Circuit breaker: one automatic Max request per incident episode.
  const titleKey = `Max · incidente ${incident.category}: ${incident.source}`.slice(0, 200);
  const active = (await q(`SELECT id, status FROM "AgentRequest" WHERE origin='error-supervisor' AND kind='max.chief-of-staff' AND title=$1 AND (status IN ('queued','approved','running','failed') OR (status='cancelled' AND "updatedAt" > now()-interval '24 hours')) ORDER BY "updatedAt" DESC LIMIT 1`, [titleKey])).rows[0];
  if (active && (active.status !== 'failed' || (lastSeen && now - new Date(lastSeen).getTime() < 24 * 60 * 60 * 1000))) {
    if (!dryRun) await q(`INSERT INTO "DataStore" (key, data, "updatedAt") VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, "updatedAt"=now()`, [key, JSON.stringify({ ...(previous || {}), lastSeenAt: new Date(now).toISOString(), requestId: active.id, circuit: 'open' })]);
    return 'circuit-open';
  }
  if (lastSeen && now - new Date(lastSeen).getTime() < window) {
    if (!dryRun) await q(`INSERT INTO "DataStore" (key, data, "updatedAt") VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, "updatedAt"=now()`, [key, JSON.stringify({ ...(previous || {}), lastSeenAt: new Date(now).toISOString() })]);
    return "episode-active";
  }
  const title = `Max · incidente ${incident.category}: ${incident.source}`.slice(0, 200);
  const prompt = (`AUTONOMOUS_REPAIR_REVIEW\nAUTONOMOUS_REPAIR_AUTHORIZED\nIDENTIDAD_COMPARTIDA: hermes-operator-constructor-v1\n` +
    `El supervisor detectó un incidente importante con evidencia actual. Max debe elegir y delegar una reparación autónoma al dueño correcto. ` +
    `Para servicio, código, filesystem, root o VPS delega a codex.engineering; para automatización del hogar a Domus; para backup/continuidad a Ledger; para seguridad defensiva a Aegis. ` +
    `No esperes respuesta humana para diagnosticar, pero cualquier reparación side-effecting debe crear una solicitud aprobable y permanecer bloqueada hasta aprobación. Confirma evidencia, estructura la causa/hipótesis/reparación/validación y registra limitaciones y siguiente acción.\n` +
    `Origen: ${incident.source}\nCategoría: ${incident.category}\nEvidencia: ${incident.detail}`).slice(0, 4000);
  if (dryRun) return "would-queue";
  const stillGated = (await q(`SELECT data FROM "DataStore" WHERE key='agent-emergency-gate'`)).rows[0]?.data;
  if (stillGated?.active === true && Number(stillGated.expiresAt || 0) > Date.now()) return "emergency-reset-active";
  const id = randomUUID();
  await q(`INSERT INTO "AgentRequest" (id, kind, title, prompt, status, "sideEffecting", origin, "createdAt", "updatedAt") VALUES ($1,'max.chief-of-staff',$2,$3,'queued',false,'error-supervisor',now(),now())`, [id, title, prompt]);
  await q(`INSERT INTO "DataStore" (key, data, "updatedAt") VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data,"updatedAt"=now()`, [key, JSON.stringify({ at: new Date().toISOString(), lastSeenAt: new Date().toISOString(), requestId: id, source: incident.source, category: incident.category })]);
  await q(`INSERT INTO "AgentEvent" (id, kind, title, detail, agent, level, meta, "createdAt") VALUES ($1,'alert',$2,$3,'max','warn',$4::jsonb,now())`, [randomUUID(), `Supervisor escaló ${incident.category} a Max`, incident.detail, JSON.stringify({ requestId: id, source: incident.source, category: incident.category, supervisor: true })]);
  return "queued";
}

try {
  const incidents = await collect();
  const outcomes = [];
  for (const incident of incidents) outcomes.push({ id: incident.id, source: incident.source, category: incident.category, outcome: await enqueue(incident) });
  console.log(JSON.stringify({ dryRun, incidents: outcomes }));
} finally { await pool.end(); }
