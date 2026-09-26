import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Credentials = { email?: string; refreshToken?: string; connectedAt?: string };
type MiloState = { lastCheckedAt?: string; initialized?: boolean; processedIds?: string[]; lastAlertCount?: number };

export async function GET() {
  const [credentials, state] = await Promise.all([
    prisma.dataStore.findUnique({ where: { key: "milo-gmail-credentials" } }),
    prisma.dataStore.findUnique({ where: { key: "milo-gmail-state" } }),
  ]);
  const auth = (credentials?.data || {}) as Credentials;
  const runtime = (state?.data || {}) as MiloState;
  return NextResponse.json({
    email: "rey.amado8509@gmail.com",
    connected: Boolean(auth.refreshToken && auth.email === "rey.amado8509@gmail.com"),
    connectedAt: auth.connectedAt || null,
    lastCheckedAt: runtime.lastCheckedAt || null,
    initialized: Boolean(runtime.initialized),
    lastAlertCount: runtime.lastAlertCount || 0,
    intervalMinutes: 1440,
  }, { headers: { "Cache-Control": "no-store" } });
}
