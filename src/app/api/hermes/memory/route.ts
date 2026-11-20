import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { prisma } from "@/lib/prisma";
import { requireHumanActor, requestActor } from "@/lib/human-auth";
import { createQueueRequest, readIdempotencyKey } from "@/lib/queue-request";
import { exactMemoryDuplicates, normalizeMemoryEntry, safeWikiPath } from "@/lib/phase4-domain.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const AGENTS = new Set(["max", "codex", "atlas", "aegis", "ledger", "milo", "pulse", "domus", "hermes"]);

function wikiDir() {
  return process.env.HERMES_WIKI || path.join(os.homedir(), ".hermes", "wiki");
}

async function historyFor(id: string, includePreview?: string) {
  const row = await prisma.hermesMemory.findUnique({ where: { id }, select: { id: true, path: true, title: true } });
  const rel = safeWikiPath(row?.path);
  if (!row || !rel) return { response: NextResponse.json({ error: "Entrada o ruta de memoria no válida" }, { status: 404 }) };
  try {
    const [historyResult, statusResult] = await Promise.all([
      execFileP("git", ["log", "--follow", "-n", "25", "--format=%H%x09%ct%x09%s", "--", rel], { cwd: wikiDir(), timeout: 5000, maxBuffer: 32 * 1024 }),
      execFileP("git", ["status", "--short", "--untracked-files=all", "--", rel], { cwd: wikiDir(), timeout: 5000, maxBuffer: 8192 }),
    ]);
    const stdout = String(historyResult.stdout || "");
    const workingTreeDirty = Boolean(String(statusResult.stdout || "").trim());
    const versions = stdout.split("\n").filter(Boolean).map((line) => {
      const [commit, seconds, ...subject] = line.split("\t");
      return { commit, createdAt: Number.isFinite(Number(seconds)) ? new Date(Number(seconds) * 1000).toISOString() : null, subject: subject.join("\t").replace(/[\r\n\0]/g, " ").slice(0, 180) };
    }).filter((version) => /^[a-f0-9]{40,64}$/i.test(version.commit));
    let preview: string | undefined;
    if (includePreview) {
      if (!versions.some((version) => version.commit === includePreview)) return { response: NextResponse.json({ error: "La versión no pertenece al historial de esta entrada" }, { status: 400 }) };
      const shown = await execFileP("git", ["show", `${includePreview}:${rel}`], { cwd: wikiDir(), timeout: 5000, maxBuffer: 128 * 1024 });
      preview = String(shown.stdout || "").slice(0, 4000);
    }
    return { row, versions, workingTreeDirty, ...(preview === undefined ? {} : { preview }) };
  } catch {
    return { response: NextResponse.json({ error: "No se pudo consultar el historial Git de la wiki" }, { status: 503 }) };
  }
}

export async function GET(req: Request) {
  const auth = await requestActor(req, "max");
  if (auth.response) return auth.response;
  const url = new URL(req.url);
  const historyId = (url.searchParams.get("historyId") || "").trim();
  if (historyId) {
    const commit = (url.searchParams.get("commit") || "").trim();
    const result = await historyFor(historyId, commit || undefined);
    if ("response" in result) return result.response;
    return NextResponse.json({ entry: result.row, versions: result.versions, workingTreeDirty: result.workingTreeDirty, ...(result.preview === undefined ? {} : { preview: result.preview }) });
  }

  const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status") || "active";
  const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
  if (agent && agent !== "all" && !AGENTS.has(agent)) return NextResponse.json({ error: "Agente de memoria no válido" }, { status: 400 });
  const and: Prisma.HermesMemoryWhereInput[] = [];
  if (q) and.push({ OR: [
    { title: { contains: q, mode: "insensitive" } },
    { body: { contains: q, mode: "insensitive" } },
    { tags: { has: q.toLowerCase() } },
  ] });
  if (agent && agent !== "all") and.push({ OR: [
    { provenance: { contains: agent, mode: "insensitive" } },
    { tags: { has: agent } },
  ] });
  const where: Prisma.HermesMemoryWhereInput = {};
  if (status !== "all") where.status = status;
  if (type && type !== "all") where.type = type;
  if (and.length) where.AND = and;
  const entries = await prisma.hermesMemory.findMany({ where, orderBy: { updatedAt: "desc" }, take: 300 });
  const all = await prisma.hermesMemory.findMany({ select: { type: true }, where: status === "all" ? {} : { status } });
  const typeCounts: Record<string, number> = {};
  for (const entry of all) typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
  const proposals = await prisma.agentRequest.findMany({
    where: { kind: { in: ["memory.write", "memory.restore"] } },
    orderBy: { createdAt: "desc" }, take: 30,
    select: { id: true, kind: true, title: true, status: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({
    entries, typeCounts, total: all.length, lastSync: entries[0]?.syncedAt ?? null,
    duplicates: exactMemoryDuplicates(entries), proposals,
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const key = readIdempotencyKey(req, body);
  const action = String(body.action || "propose");
  if (action === "restore") {
    const id = String(body.id || "").trim();
    const commit = String(body.commit || "").trim();
    if (!id || !/^[a-f0-9]{40,64}$/i.test(commit)) return NextResponse.json({ error: "Entrada y commit Git válidos requeridos" }, { status: 400 });
    const row = await prisma.hermesMemory.findUnique({ where: { id }, select: { id: true, path: true, title: true } });
    const rel = safeWikiPath(row?.path);
    if (!row || !rel) return NextResponse.json({ error: "Entrada de memoria no válida" }, { status: 404 });
    const history = await historyFor(id);
    if ("response" in history) return history.response;
    if (history.workingTreeDirty) return NextResponse.json({ error: "La ruta tiene cambios locales sin commit; resuélvelos antes de proponer una restauración" }, { status: 409 });
    if (!history.versions.some((version) => version.commit === commit)) return NextResponse.json({ error: "La versión no pertenece al historial de esta entrada" }, { status: 400 });
    try {
      const created = await createQueueRequest({
        key, actor: auth.actor, origin: "web", kind: "memory.restore",
        title: `Propuesta de restauración de memoria: ${row.title}`.slice(0, 200),
        prompt: JSON.stringify({ id: row.id, path: rel, commit }), sideEffecting: true,
        action: "restore", capability: "memory.mutate",
        status: "awaiting_approval", dependsOn: [],
      });
      return NextResponse.json({ request: created.request, duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
    } catch (error) {
      if (error instanceof Error && "status" in error) return NextResponse.json({ error: error.message }, { status: Number((error as Error & { status: number }).status) });
      return NextResponse.json({ error: "No se pudo crear la propuesta de restauración" }, { status: 500 });
    }
  }
  if (action !== "propose") return NextResponse.json({ error: "Acción de memoria no válida" }, { status: 400 });

  const requestedId = String(body.id || "").trim();
  const existing = requestedId ? await prisma.hermesMemory.findUnique({ where: { id: requestedId } }) : null;
  if (requestedId && !existing) return NextResponse.json({ error: "La entrada a corregir ya no existe" }, { status: 404 });
  const type = String(body.type || existing?.type || "note").trim();
  const title = String(body.title || existing?.title || "").trim();
  const slug = title.toLocaleLowerCase("es").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  const rel = existing?.path || `${type}s/${slug}.md`;
  const id = existing?.id || rel.slice(0, -3);
  const normalized = normalizeMemoryEntry({
    id, path: rel, type, title,
    body: typeof body.body === "string" ? body.body : existing?.body || "",
    status: String(body.status || existing?.status || "active"),
    confidence: body.confidence === undefined ? existing?.confidence : body.confidence,
    provenance: existing?.provenance || "dashboard",
    tags: Array.isArray(body.tags) ? body.tags : existing?.tags || [],
    links: Array.isArray(body.links) ? body.links : existing?.links || [],
  });
  if (!normalized.ok || !normalized.entry) return NextResponse.json({ error: normalized.error || "La propuesta de memoria no es válida" }, { status: 400 });
  const proposal = normalized.entry;
  const collision = !existing && await prisma.hermesMemory.findUnique({ where: { id }, select: { id: true } });
  if (collision) return NextResponse.json({ error: "Ya existe una entrada con ese identificador" }, { status: 409 });
  try {
    const created = await createQueueRequest({
      key, actor: auth.actor, origin: "web", kind: "memory.write",
      title: `Propuesta de memoria: ${proposal.title}`.slice(0, 200),
      prompt: JSON.stringify(proposal), sideEffecting: true,
      action: "write", capability: "memory.mutate",
      status: "awaiting_approval", dependsOn: [],
    });
    return NextResponse.json({ request: created.request, duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Error && "status" in error) return NextResponse.json({ error: error.message }, { status: Number((error as Error & { status: number }).status) });
    return NextResponse.json({ error: "No se pudo crear la propuesta de memoria" }, { status: 500 });
  }
}
