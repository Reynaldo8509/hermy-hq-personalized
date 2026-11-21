import { createHash } from "node:crypto";

function compact(value, limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function category(value) {
  const text = String(value).toLowerCase();
  if (/telegram|413|payload too large/.test(text)) return "telegram";
  if (/qwen|llm|provider|model|429/.test(text)) return "llm";
  if (/home assistant|alexa|adb|fire tv/.test(text)) return "home-automation";
  if (/database|postgres|sqlite|state\.db/.test(text)) return "database";
  if (/backup|rclone|onedrive|github/.test(text)) return "backup";
  if (/ssh|tailscale|samba|network|timeout|connection/.test(text)) return "connectivity";
  return "service";
}

export function legacyFingerprint(incident) {
  return createHash("sha256").update(`${incident.source}|${category(incident.detail)}`).digest("hex").slice(0, 24);
}

export function fingerprint(incident) {
  const stable = compact(incident.detail, 240).toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, "<time>")
    .replace(/\bpid[= :]\d+\b/gi, "pid=<n>")
    .replace(/\[\d+\]/g, "[pid]")
    .replace(/\s+/g, " ").trim();
  return createHash("sha256").update(incident.source + "|" + category(incident.detail) + "|" + stable).digest("hex").slice(0, 24);
}

export function filterSupervisorUnitFailures(value) {
  return String(value || "").split(/\r?\n/)
    .filter((line) => !/(?:^|\s)hermy-error-supervisor\.service(?:\s|$)/i.test(line))
    .join("\n");
}
