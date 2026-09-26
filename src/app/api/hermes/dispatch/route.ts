import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST { kind?, title, prompt?, sideEffecting? } → queue work for Hermes.
// Side-effecting work waits for approval; safe work is queued immediately.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const title = (b.title || b.prompt || "").toString().trim();
  if (!title) return NextResponse.json({ error: "title or prompt required" }, { status: 400 });
  const kind = (b.kind || "oneshot").toString();
  if (kind.startsWith("codex.")) {
    return NextResponse.json({ error: "Codex solo puede recibir delegaciones justificadas de Max" }, { status: 403 });
  }
  const sideEffecting = Boolean(b.sideEffecting);
  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind,
      title: title.slice(0, 200),
      prompt: (b.prompt ?? b.title ?? "").toString() || null,
      sideEffecting,
      status: sideEffecting ? "awaiting_approval" : "queued",
    },
  });
  return NextResponse.json({ request: row });
}
