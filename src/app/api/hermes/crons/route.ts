import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor, requestActor } from "@/lib/human-auth";
import { createQueueRequest, readIdempotencyKey } from "@/lib/queue-request";

export type CronJob = {
  id: string;
  status: string;           // "active" | "paused"
  name: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  deliver: string | null;
  skills: string | null;
  script: string | null;
  mode: string | null;
};

// Parse the raw `hermes cron list --all` terminal output into clean objects.
// Format per job: two-space-indented "<id> [status]" then four-space "Key: value" lines.
function parseCrons(raw: string): CronJob[] {
  const jobs: CronJob[] = [];
  let cur: CronJob | null = null;
  const push = () => { if (cur) jobs.push(cur); };
  for (const line of raw.split("\n")) {
    const head = line.match(/^\s{2}([0-9a-f]{6,})\s+\[(\w+)\]/);
    if (head) {
      push();
      cur = { id: head[1], status: head[2], name: "", schedule: "", nextRun: null, lastRun: null, lastResult: null, deliver: null, skills: null, script: null, mode: null };
      continue;
    }
    const kv = line.match(/^\s{4}([A-Za-z][A-Za-z ]*?):\s+(.*)$/);
    if (kv && cur) {
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (key === "name") cur.name = val;
      else if (key === "schedule") cur.schedule = val;
      else if (key === "next run") cur.nextRun = val;
      else if (key === "deliver") cur.deliver = val;
      else if (key === "skills") cur.skills = val;
      else if (key === "script") cur.script = val;
      else if (key === "mode") cur.mode = val;
      else if (key === "last run") {
        const m = val.match(/^(\S+)\s+(.*)$/);
        cur.lastRun = m ? m[1] : val;
        cur.lastResult = m ? m[2] : null;
      }
    }
  }
  push();
  return jobs;
}

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-crons" } });
  const data = (row?.data as { raw?: string; jobs?: unknown; syncStatus?: string; syncedAt?: string; lastAttemptAt?: string } | null) ?? {};
  const syncedAt = typeof data.syncedAt === "string" ? data.syncedAt : null;
  if (data.syncStatus === "error") {
    return NextResponse.json({ error: "cron_list_failed", syncStatus: "error", syncedAt }, { status: 503 });
  }
  if (!row || !syncedAt) {
    return NextResponse.json({ error: "cron_sync_unavailable", syncStatus: "unknown", syncedAt: null }, { status: 503 });
  }
  const storedJobs = Array.isArray(data.jobs) && data.jobs.every((job) =>
    job !== null && typeof job === "object" && typeof (job as { id?: unknown }).id === "string")
    ? data.jobs as CronJob[] : null;
  const jobs = storedJobs ?? parseCrons(typeof data.raw === "string" ? data.raw : "");
  return NextResponse.json({ jobs, syncStatus: "ok", syncedAt, lastAttemptAt: data.lastAttemptAt ?? syncedAt });
}

// POST { op: "create"|"pause"|"resume"|"run"|"remove"|"edit", ... } → queue a cron mutation for the bridge
export async function POST(req: Request) {
  const auth = await requestActor(req, "max");
  if (auth.response) return auth.response;
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const op = String(b.op || "");
  if (!["create", "pause", "resume", "run", "remove", "edit"].includes(op))
    return NextResponse.json({ error: "bad op" }, { status: 400 });
  const label = op === "create"
    ? "Schedule: " + String(b.schedule || "?") + " — " + String(b.prompt || b.name || "")
    : "Cron " + op + ": " + String(b.name || b.id || "");
  const prompt = JSON.stringify(b);
  const key = readIdempotencyKey(req, b);
  try {
    const created = await createQueueRequest({
      key, actor: auth.actor, origin: "web", kind: "cron." + op,
      title: label.slice(0, 200), prompt, sideEffecting: true,
      action: `timer.${op}`, capability: "systemd.timer.mutate",
      status: "awaiting_approval", dependsOn: [],
    });
    return NextResponse.json({ request: created.request, duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Error && "status" in error) return NextResponse.json({ error: error.message }, { status: Number((error as Error & { status: number }).status) });
    console.error("Cron operation could not be queued:", error);
    return NextResponse.json({ error: "No se pudo encolar el cambio de cron" }, { status: 500 });
  }
}
