import { createHash } from "node:crypto";

export const SYSTEMD_AUTOMATIONS = Object.freeze({
  "milo-mail.timer": Object.freeze({ label: "MILO · Gmail triage", objective: "Revisar correo y actualizar el digest", service: "milo-mail.service" }),
  "hermy-error-supervisor.timer": Object.freeze({ label: "Supervisor de errores", objective: "Detectar fallos operativos y deduplicar incidentes", service: "hermy-error-supervisor.service" }),
  "hermes-backup.timer": Object.freeze({ label: "Backup de Hermes", objective: "Crear y verificar la copia programada de Hermes", service: "hermes-backup.service" }),
  "hermes-vps-updater.timer": Object.freeze({ label: "Actualización staged de Hermes", objective: "Revisar una actualización en staging; no la promueve automáticamente", service: "hermes-vps-updater.service" }),
  "hermes-weekly-movies.timer": Object.freeze({ label: "Informe semanal de películas", objective: "Generar el informe multimedia semanal", service: "hermes-weekly-movies.service" }),
  "hermes-security-summary-night.timer": Object.freeze({ label: "Resumen de seguridad nocturno", objective: "Generar el resumen nocturno de seguridad", service: "hermes-security-summary@12.service" }),
  "hermes-security-summary-morning.timer": Object.freeze({ label: "Resumen de seguridad matutino", objective: "Generar el resumen matutino de seguridad", service: "hermes-security-summary@12.service" }),
});

export const AUTOMATION_ACTIONS = Object.freeze(["enable", "disable", "run"]);
const MEMORY_TYPES = new Set(["fact", "preference", "decision", "event", "project", "contact", "lesson", "metric", "note", "investigation"]);
const MEMORY_STATUSES = new Set(["active", "superseded", "archived"]);

export function systemdActionAllowed(timer, action) {
  return Object.hasOwn(SYSTEMD_AUTOMATIONS, String(timer || "")) && AUTOMATION_ACTIONS.includes(String(action || ""));
}

export function safeWikiPath(value) {
  const rel = String(value || "");
  if (!rel || rel.length > 240 || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return null;
  const parts = rel.split("/");
  if (parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part) || part === "." || part === ".." || part === ".git")) return null;
  if (!parts.at(-1)?.endsWith(".md")) return null;
  return rel;
}

export function normalizeMemoryEntry(value) {
  const input = value && typeof value === "object" ? value : {};
  const id = String(input.id || "").trim();
  const path = safeWikiPath(input.path);
  const type = String(input.type || "note").trim();
  const title = String(input.title || "").trim();
  const body = String(input.body || "");
  const status = String(input.status || "active").trim();
  const provenance = String(input.provenance || "dashboard").trim();
  if (!path || !id || id !== path.slice(0, -3) || !MEMORY_TYPES.has(type) || !MEMORY_STATUSES.has(status)) {
    return { ok: false, error: "La ruta, el identificador, el tipo o el estado de memoria no son válidos" };
  }
  if (!title || title.length > 200 || /[\r\n\0]/.test(title)) return { ok: false, error: "El título es obligatorio y debe ser una sola línea de hasta 200 caracteres" };
  if (body.length > 12000 || body.includes("\0")) return { ok: false, error: "El contenido supera el máximo permitido de 12 000 caracteres" };
  if (provenance.length > 200 || /[\r\n\0]/.test(provenance)) return { ok: false, error: "La procedencia no es válida" };
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const links = Array.isArray(input.links) ? input.links : [];
  if (tags.length > 40 || links.length > 40) return { ok: false, error: "Se permiten hasta 40 etiquetas y 40 enlaces" };
  const cleanTags = tags.map((item) => String(item).trim()).filter(Boolean);
  const cleanLinks = links.map((item) => String(item).trim()).filter(Boolean);
  if (cleanTags.some((item) => item.length > 80 || /[\r\n,\[\]\0]/.test(item)) || cleanLinks.some((item) => item.length > 180 || /[\r\n,\[\]\0]/.test(item))) {
    return { ok: false, error: "Las etiquetas y enlaces deben ser valores cortos de una sola línea" };
  }
  const confidence = input.confidence == null || input.confidence === "" ? null : Number(input.confidence);
  if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)) return { ok: false, error: "La confianza debe estar entre 0 y 100" };
  return { ok: true, entry: { id, path, type, title, body, status, provenance, tags: cleanTags, links: cleanLinks, confidence } };
}

function normalizeExact(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("es").replace(/\s+/g, " ").trim();
}

export function exactMemoryDuplicates(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const title = normalizeExact(entry?.title);
    const body = normalizeExact(entry?.body);
    if (!title || !body) continue;
    const digest = createHash("sha256").update(title + "\0" + body).digest("hex").slice(0, 16);
    const group = groups.get(digest) || { fingerprint: digest, title: String(entry.title), ids: [] };
    group.ids.push(String(entry.id));
    groups.set(digest, group);
  }
  return [...groups.values()].filter((group) => group.ids.length > 1).map((group) => ({ ...group, occurrences: group.ids.length }));
}

function peerDigest(peer) {
  const stable = String(peer?.StableID || peer?.ID || peer?.PublicKey || peer?.HostName || peer?.DNSName || "unknown");
  return createHash("sha256").update(stable).digest("hex").slice(0, 20);
}

function cleanHostname(value) {
  const base = String(value || "unknown").split(".")[0].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);
  return base || "unknown";
}

export function summarizeTailnetPeers(status, collectedAt = new Date().toISOString()) {
  if (!status || typeof status !== "object") return null;
  const rawPeers = [status.Self, ...Object.values(status.Peer || {})].filter((peer) => peer && typeof peer === "object");
  const peers = rawPeers.map((peer) => {
    const rawLastSeen = Date.parse(String(peer.LastSeen || ""));
    return {
      key: peerDigest(peer),
      hostname: cleanHostname(peer.HostName || peer.DNSName),
      os: /^[A-Za-z0-9_.-]{1,40}$/.test(String(peer.OS || "")) ? String(peer.OS) : "unknown",
      online: typeof peer.Online === "boolean" ? peer.Online : null,
      exitNodeAdvertised: peer.ExitNodeOption === true,
      lastSeenAt: Number.isFinite(rawLastSeen) && rawLastSeen > 0 ? new Date(rawLastSeen).toISOString() : null,
      observedAt: collectedAt,
    };
  });
  const unique = new Map(peers.map((peer) => [peer.key, peer]));
  return [...unique.values()].slice(0, 500);
}

export function reconcileTailnetPeers(previous, observedPeers, collectedAt = new Date().toISOString()) {
  const data = previous && typeof previous === "object" ? previous : {};
  const prior = Array.isArray(data.knownTailnetPeers) ? data.knownTailnetPeers : [];
  const priorByKey = new Map(prior.filter((peer) => peer?.key).map((peer) => [String(peer.key), peer]));
  const events = Array.isArray(data.tailnetPeerEvents) ? data.tailnetPeerEvents.filter((event) => Date.parse(String(event?.at || "")) >= Date.now() - 90 * 24 * 60 * 60 * 1000) : [];
  if (!Array.isArray(observedPeers)) {
    return { peerBaselineAt: data.peerBaselineAt || null, tailnetPeersObservedAt: data.tailnetPeersObservedAt || null, knownTailnetPeers: prior.slice(-500), tailnetPeerEvents: events.slice(-200) };
  }
  const hasBaseline = priorByKey.size > 0;
  const latest = new Map(priorByKey);
  for (const peer of observedPeers) {
    if (!peer?.key) continue;
    const old = priorByKey.get(String(peer.key));
    if (!old && hasBaseline) {
      events.push({ kind: "new_device", at: collectedAt, hostname: peer.hostname, os: peer.os });
    } else if (old && ((old.online !== peer.online && old.online != null && peer.online != null) || old.exitNodeAdvertised !== peer.exitNodeAdvertised)) {
      events.push({ kind: "status_change", at: collectedAt, hostname: peer.hostname, os: peer.os,
        previousOnline: old.online, online: peer.online, previousExitNodeAdvertised: old.exitNodeAdvertised, exitNodeAdvertised: peer.exitNodeAdvertised });
    }
    latest.set(String(peer.key), { ...old, ...peer, firstSeenAt: old?.firstSeenAt || collectedAt });
  }
  const knownTailnetPeers = [...latest.values()].sort((a, b) => String(a.firstSeenAt || "").localeCompare(String(b.firstSeenAt || ""))).slice(-500);
  return {
    peerBaselineAt: data.peerBaselineAt || collectedAt,
    tailnetPeersObservedAt: collectedAt,
    knownTailnetPeers,
    tailnetPeerEvents: events.slice(-200),
  };
}
