import { NextResponse } from "next/server";
import { requireHumanActor } from "@/lib/human-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BASE = (process.env.HONCHO_API_BASE || "https://api.honcho.dev/v3").replace(/\/$/, "");
const WORKSPACE = process.env.HONCHO_WORKSPACE_ID || "hermes";
const SESSION_LIMIT = 8;
const MESSAGE_LIMIT = 8;
const CONCLUSION_LIMIT = 100;

type Row = Record<string, unknown>;
type Page<T> = { items: T[]; total: number };
class HonchoHttpError extends Error { status: number; constructor(status: number) { super("Honcho HTTP error"); this.status = status; } }

async function honcho(path: string, init: RequestInit = {}): Promise<unknown> {
  const key = process.env.HONCHO_API_KEY;
  if (!key) throw new Error("Honcho API key is not configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Content-Type", "application/json");
  const response = await fetch(BASE + path, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok) throw new HonchoHttpError(response.status);
  try { return text ? JSON.parse(text) : null; } catch { throw new Error("Honcho returned invalid JSON"); }
}

function listPage<T extends Row>(value: unknown): Page<T> {
  if (Array.isArray(value)) return { items: value as T[], total: value.length };
  const row = value && typeof value === "object" ? value as Row : {};
  const rawItems = Array.isArray(row.items) ? row.items : Array.isArray(row.data) ? row.data : Array.isArray(row.results) ? row.results : [];
  return { items: rawItems as T[], total: Number(row.total ?? row.count ?? rawItems.length) || 0 };
}

function scalar(value: unknown, max = 1000): string {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") { try { return JSON.stringify(value).slice(0, max); } catch {} }
  return "";
}

function apiError(label: string, error: unknown): string {
  if (error instanceof HonchoHttpError) return `${label}: HTTP ${error.status}`;
  return `${label}: no disponible`;
}

async function guarded<T>(label: string, work: () => Promise<T>) {
  try { return { value: await work(), error: null as string | null }; }
  catch (error) { return { value: null as T | null, error: apiError(label, error) }; }
}

function safeId(value: unknown) { return scalar(value, 160); }
function listPath(path: string, size: number, page = 1) { return `${path}?page=${page}&size=${size}&reverse=true`; }

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  try {
    const workspacePath = "/workspaces/" + encodeURIComponent(WORKSPACE);
    // The workspace ID is already configured. Use it directly instead of
    // calling the workspace collection endpoint from a read-only status view.
    const workspaceObject: Row = { id: WORKSPACE, name: WORKSPACE };
    const [queueResult, peersResult, sessionsResult, conclusionsResult] = await Promise.all([
      guarded("Cola", () => honcho(workspacePath + "/queue/status")),
      guarded("Peers", async () => listPage<Row>(await honcho(workspacePath + "/peers/list", { method: "POST", body: JSON.stringify({ filters: {} }) }))),
      guarded("Sesiones", async () => listPage<Row>(await honcho(listPath(workspacePath + "/sessions/list", SESSION_LIMIT), { method: "POST", body: JSON.stringify({ filters: {} }) }))),
      guarded("Conclusiones", async () => listPage<Row>(await honcho(listPath(workspacePath + "/conclusions/list", CONCLUSION_LIMIT), { method: "POST", body: JSON.stringify({ filters: {} }) }))),
    ]);
    const peers = peersResult.value || { items: [], total: 0 };
    const sessions = sessionsResult.value || { items: [], total: 0 };
    let conclusions = conclusionsResult.value || { items: [], total: 0 };
    let conclusionsPageError: string | null = null;
    if (conclusionsResult.value && conclusions.total > conclusions.items.length) {
      const latestPage = Math.ceil(conclusions.total / CONCLUSION_LIMIT);
      if (latestPage > 1) {
        const latestResult = await guarded("Conclusiones recientes", async () => listPage<Row>(await honcho(
          listPath(workspacePath + "/conclusions/list", CONCLUSION_LIMIT, latestPage),
          { method: "POST", body: JSON.stringify({ filters: {} }) },
        )));
        if (latestResult.value) conclusions = { ...latestResult.value, total: conclusions.total };
        else conclusionsPageError = latestResult.error;
      }
    }
    const peerNames = new Map(peers.items.map((peer) => [safeId(peer.id ?? peer.peer_id), scalar(peer.name ?? peer.display_name, 120)]));
    const recentSessions = sessions.items.slice(0, SESSION_LIMIT);
    const messageResults = await Promise.all(recentSessions.map(async (session) => {
      const sessionId = safeId(session.id ?? session.session_id);
      if (!sessionId) return { sessionId: "", items: [] as Row[], total: 0, error: null as string | null };
      const result = await guarded(`Mensajes de sesión ${sessionId.slice(0, 24)}`, async () => listPage<Row>(await honcho(
        listPath(`${workspacePath}/sessions/${encodeURIComponent(sessionId)}/messages/list`, MESSAGE_LIMIT),
        { method: "POST", body: JSON.stringify({ filters: {} }) },
      )));
      return { sessionId, items: result.value?.items || [], total: result.value?.total || 0, error: result.error };
    }));
    const messages = messageResults.flatMap((result) => result.items.map((message) => ({
      id: safeId(message.id ?? message.message_id) || `${result.sessionId}:${safeId(message.created_at)}`,
      sessionId: result.sessionId,
      peerId: safeId(message.peer_id ?? message.peerId ?? message.speaker_id),
      peerName: peerNames.get(safeId(message.peer_id ?? message.peerId ?? message.speaker_id)) || "",
      role: scalar(message.role ?? message.speaker, 80),
      content: scalar(message.content ?? message.text ?? message.message, 1600),
      createdAt: scalar(message.created_at ?? message.createdAt, 80) || null,
    }))).sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    const recent = recentSessions.map((session, index) => {
      const sessionId = safeId(session.id ?? session.session_id);
      const result = messageResults[index];
      return {
        id: sessionId,
        createdAt: scalar(session.created_at ?? session.createdAt, 80) || null,
        active: Boolean(session.is_active ?? session.isActive),
        messageCount: result?.total || 0,
        lastMessageAt: result?.items[0] ? scalar(result.items[0].created_at ?? result.items[0].createdAt, 80) || null : null,
      };
    });
    const normalizedConclusions = conclusions.items.map((item) => {
      const observerId = safeId(item.observer_id ?? item.observerId);
      const observedId = safeId(item.observed_id ?? item.observedId);
      return {
        id: safeId(item.id ?? item.conclusion_id),
        content: scalar(item.content ?? item.text, 1600),
        observerId,
        observerName: peerNames.get(observerId) || observerId,
        observedId,
        observedName: peerNames.get(observedId) || observedId,
        sessionId: safeId(item.session_id ?? item.sessionId) || null,
        level: scalar(item.level, 40) || "sin clasificar",
        createdAt: scalar(item.created_at ?? item.createdAt, 80) || null,
      };
    }).sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    const timestamps = [...messages.map((item) => item.createdAt), ...normalizedConclusions.map((item) => item.createdAt)].filter((item): item is string => Boolean(item));
    const partialErrors = [queueResult.error, peersResult.error, sessionsResult.error, conclusionsResult.error, conclusionsPageError, ...messageResults.map((result) => result.error)].filter((item): item is string => Boolean(item));
    return NextResponse.json({
      ok: true,
      workspace: { id: safeId(workspaceObject.id ?? workspaceObject.workspace_id) || WORKSPACE, name: scalar(workspaceObject.name, 160) || WORKSPACE, createdAt: scalar(workspaceObject.created_at, 80) || null },
      queue: queueResult.value,
      peers: { total: peers.total, items: peers.items.map((peer) => ({ id: safeId(peer.id ?? peer.peer_id), name: scalar(peer.name ?? peer.display_name, 120), kind: scalar(peer.kind, 40) || "peer" })) },
      sessions: { total: sessions.total, recent },
      messages,
      conclusions: { total: conclusions.total, recent: normalizedConclusions },
      metrics: {
        messagesInRecentSessions: messageResults.reduce((sum, result) => sum + result.total, 0),
        messagesCoverageSessions: recentSessions.length,
        conclusions: conclusions.total,
        lastWrittenAt: timestamps.sort().at(-1) || null,
      },
      partialErrors,
      timezone: "America/Guayaquil",
      statusUrl: process.env.HONCHO_STATUS_URL || "https://app.honcho.dev/status",
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: apiError("Honcho", error), timezone: "America/Guayaquil", workspaceId: WORKSPACE, statusUrl: process.env.HONCHO_STATUS_URL || "https://app.honcho.dev/status" }, { status: 503, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }
}

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "write-memory") return NextResponse.json({ error: "Acción de Honcho no válida" }, { status: 400 });
  const content = String(body.content || "").trim();
  const observerId = String(body.observerId || "").trim();
  const observedId = String(body.observedId || "").trim();
  if (content.length < 8 || content.length > 4000) return NextResponse.json({ error: "La memoria debe tener entre 8 y 4000 caracteres" }, { status: 400 });
  if (!observerId || !observedId || observerId.length > 160 || observedId.length > 160) return NextResponse.json({ error: "Selecciona quién recuerda y sobre quién trata la memoria" }, { status: 400 });
  const workspacePath = "/workspaces/" + encodeURIComponent(WORKSPACE);
  try {
    const peers = listPage<Row>(await honcho(workspacePath + "/peers/list", { method: "POST", body: JSON.stringify({ filters: {} }) }));
    const ids = new Set(peers.items.map((peer) => safeId(peer.id ?? peer.peer_id)));
    if (!ids.has(observerId) || !ids.has(observedId)) return NextResponse.json({ error: "Los peers seleccionados ya no existen en este workspace. Actualiza la vista." }, { status: 409 });
    const created = await honcho(workspacePath + "/conclusions", {
      method: "POST",
      body: JSON.stringify({ conclusions: [{ content, observer_id: observerId, observed_id: observedId }] }),
    });
    return NextResponse.json({ ok: true, created }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: apiError("No se pudo escribir en Honcho", error) }, { status: error instanceof HonchoHttpError ? (error.status === 401 || error.status === 403 ? 502 : error.status) : 502 });
  }
}
