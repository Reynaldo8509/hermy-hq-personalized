import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BASE = (process.env.HONCHO_API_BASE || "https://api.honcho.dev/v3").replace(/\/$/, "");
const WORKSPACE = process.env.HONCHO_WORKSPACE_ID || "hermes";
const RECENT_SESSION_LIMIT = 10;

type Page<T> = { items?: T[]; total?: number };
type Session = { id?: string; created_at?: string; is_active?: boolean };
type Message = { created_at?: string };

async function honcho(path: string, init: RequestInit = {}) {
  const key = process.env.HONCHO_API_KEY;
  if (!key) throw new Error("HONCHO_API_KEY is not configured");
  const headers = new Headers(init.headers); headers.set("Authorization", "Bearer " + key); headers.set("Content-Type", "application/json");
  const response = await fetch(BASE + path, { ...init, headers, cache: "no-store" });
  const text = await response.text(); let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 300) }; }
  if (!response.ok) throw new Error("Honcho returned HTTP " + response.status);
  return data;
}

function listPath(path: string) {
  return `${path}?page=1&size=${RECENT_SESSION_LIMIT}&reverse=true`;
}

export async function GET() {
  try {
    const workspacePath = "/workspaces/" + encodeURIComponent(WORKSPACE);
    const [workspace, queue, peers, sessions, conclusions] = await Promise.all([
      honcho("/workspaces", { method: "POST", body: JSON.stringify({ id: WORKSPACE }) }),
      honcho(workspacePath + "/queue/status"),
      honcho(workspacePath + "/peers/list", { method: "POST", body: JSON.stringify({ filters: {} }) }),
      honcho(listPath(workspacePath + "/sessions/list"), { method: "POST", body: JSON.stringify({ filters: {} }) }) as Promise<Page<Session>>,
      honcho(listPath(workspacePath + "/conclusions/list"), { method: "POST", body: JSON.stringify({ filters: {} }) }) as Promise<Page<unknown>>,
    ]);
    const recentSessions = Array.isArray(sessions.items) ? sessions.items.slice(0, RECENT_SESSION_LIMIT) : [];
    const messageStats = await Promise.all(recentSessions.map(async (session) => {
      if (!session.id) return { messageCount: 0, lastMessageAt: null };
      const messages = await honcho(listPath(`${workspacePath}/sessions/${encodeURIComponent(session.id)}/messages/list`), {
        method: "POST", body: JSON.stringify({ filters: {} }),
      }) as Page<Message>;
      return {
        messageCount: Number(messages.total || 0),
        lastMessageAt: messages.items?.[0]?.created_at || null,
      };
    }));
    const recent = recentSessions.map((session, index) => ({
      createdAt: session.created_at || null,
      active: Boolean(session.is_active),
      messageCount: messageStats[index]?.messageCount || 0,
      lastMessageAt: messageStats[index]?.lastMessageAt || null,
    }));
    const lastWrittenAt = recent.reduce<string | null>((latest, session) => {
      if (!session.lastMessageAt) return latest;
      return !latest || session.lastMessageAt > latest ? session.lastMessageAt : latest;
    }, null);
    return NextResponse.json({
      ok: true, workspace, queue, peers, sessions: { total: Number(sessions.total || 0), recent },
      metrics: {
        messagesInRecentSessions: recent.reduce((sum, session) => sum + session.messageCount, 0),
        messagesCoverageSessions: recent.length,
        conclusions: Number(conclusions.total || 0),
        lastWrittenAt,
      },
      timezone: "America/Guayaquil",
      workspaceId: WORKSPACE,
      tenantId: process.env.HONCHO_TENANT_ID || null,
      statusUrl: process.env.HONCHO_STATUS_URL || "https://app.honcho.dev/status",
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Honcho unavailable", timezone: "America/Guayaquil", workspaceId: WORKSPACE, statusUrl: process.env.HONCHO_STATUS_URL || "https://app.honcho.dev/status" }, { status: 503 });
  }
}
