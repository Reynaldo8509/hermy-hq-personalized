import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-health" } });
  const raw = row?.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
  return NextResponse.json({ online: raw.online === true, gateway: typeof raw.gateway === "string" ? raw.gateway : "unknown", lastSeen: typeof raw.lastSeen === "string" ? raw.lastSeen : null });
}
