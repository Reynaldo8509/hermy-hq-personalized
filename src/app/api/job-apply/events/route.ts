import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeJobApplyBatch, persistJobApplyBatch, readBoundedJson } from "@/lib/job-apply-events.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 10;
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(req: Request) {
  const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
  if (parsed.status === 413) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  if (parsed.status !== 200) return NextResponse.json({ error: "invalid_event_batch" }, { status: 400 });
  const events = normalizeJobApplyBatch(parsed.value);
  if (!events) return NextResponse.json({ error: "invalid_event_batch" }, { status: 400 });

  const result = await persistJobApplyBatch(prisma, events);
  if (result.status === 409) {
    return NextResponse.json({ error: "idempotency_conflict", accepted: result.accepted,
      duplicate: result.duplicate }, { status: 409 });
  }
  if (result.status !== 200) {
    console.error("Job-apply activity event persistence failed");
    return NextResponse.json({ error: "event_persistence_failed", accepted: result.accepted,
      duplicate: result.duplicate }, { status: 503 });
  }
  return NextResponse.json({ accepted: result.accepted, duplicate: result.duplicate }, { status: 200 });
}
