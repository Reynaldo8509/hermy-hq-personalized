import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
const run = promisify(execFile);

export async function GET() {
  const generatedAt = new Date().toISOString();
  const [queue, hermes, homeAssistant] = await Promise.allSettled([
    prisma.agentRequest.count({ where: { status: { in: ["queued", "running"] } } }),
    run("systemctl", ["is-active", "hermes-vps.service"], { timeout: 3000 }),
    fetch("http://127.0.0.1:8123/", { cache: "no-store", signal: AbortSignal.timeout(3000) }),
  ]);
  const queueDepth = queue.status === "fulfilled" ? queue.value : null;
  const hermesActive = hermes.status === "fulfilled" && hermes.value.stdout.trim() === "active";
  const homeAssistantHttp = homeAssistant.status === "fulfilled" ? homeAssistant.value.status : null;
  const available = queueDepth !== null && hermes.status === "fulfilled" && homeAssistantHttp !== null;

  return NextResponse.json({
    generated_at: generatedAt,
    status: available && hermesActive && homeAssistantHttp === 200 ? "ok" : "degraded",
    metrics: {
      hermy_hq_queue_depth: queueDepth,
      hermes_vps_active: hermesActive,
      home_assistant_http_status: homeAssistantHttp,
    },
    limitations: ["Qwen token/latency and Home Assistant unavailable-entity metrics require telemetry credentials or collection on the Dell; this endpoint does not expose secrets."],
  }, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } });
}
