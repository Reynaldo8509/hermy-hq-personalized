import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET ?q=&type=&status= → list/search wiki entries (mirrored by the bridge)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status") || "active";
  const where: Record<string, unknown> = {};
  if (status !== "all") where.status = status;
  if (type && type !== "all") where.type = type;
  if (q) where.OR = [
    { title: { contains: q, mode: "insensitive" } },
    { body: { contains: q, mode: "insensitive" } },
    { tags: { has: q.toLowerCase() } },
  ];
  const entries = await prisma.hermesMemory.findMany({ where, orderBy: { updatedAt: "desc" }, take: 300 });
  const all = await prisma.hermesMemory.findMany({ select: { type: true }, where: status === "all" ? {} : { status } });
  const typeCounts: Record<string, number> = {};
  for (const e of all) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const lastSync = entries[0]?.syncedAt ?? null;
  return NextResponse.json({ entries, typeCounts, total: all.length, lastSync });
}

// POST { path?, id?, type, title, body, tags?, links?, status?, confidence? }
// → queue a wiki write for the bridge (writes the .md file + git commit on the mini).
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const title = (b.title || "").toString().trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  const slug = (b.id || b.path || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).toString();
  const entry = {
    id: slug,
    path: (b.path || `${b.type || "note"}s/${slug}.md`).toString(),
    type: (b.type || "note").toString(),
    title,
    status: (b.status || "active").toString(),
    confidence: b.confidence ?? null,
    provenance: b.provenance ?? "dashboard",
    tags: Array.isArray(b.tags) ? b.tags : [],
    links: Array.isArray(b.links) ? b.links : [],
    body: (b.body || "").toString(),
  };
  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind: "memory.write",
      title: `Memory: ${title}`.slice(0, 200),
      prompt: JSON.stringify(entry),
      sideEffecting: false,
      status: "queued",
    },
  });
  return NextResponse.json({ request: row, entry });
}
