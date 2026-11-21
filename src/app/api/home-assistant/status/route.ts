import { NextResponse } from "next/server";
import { readHomeAssistantStatus } from "@/lib/home-assistant-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const status = await readHomeAssistantStatus();
  return NextResponse.json(status, {
    status: status.reachable ? 200 : 503,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
