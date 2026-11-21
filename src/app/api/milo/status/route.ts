import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
const MILO_EMAIL = String(process.env.MILO_ALLOWED_EMAIL || "").trim().toLowerCase();

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
    account: "configured mailbox",
    connected: Boolean(MILO_EMAIL && auth.refreshToken && auth.email?.toLowerCase() === MILO_EMAIL),
    connectedAt: auth.connectedAt || null,
    lastCheckedAt: runtime.lastCheckedAt || null,
    initialized: Boolean(runtime.initialized),
    lastAlertCount: runtime.lastAlertCount || 0,
    intervalMinutes: 1440,
  }, { headers: { "Cache-Control": "no-store" } });
}
