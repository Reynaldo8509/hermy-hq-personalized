import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Trend {
  id: string;
  topic: string;
  summary: string;
  source: "x_search" | "rss" | "breaking";
  velocity: "forming" | "rising" | "peaking" | "fading";
  velocityScore: number;
  ageMinutes: number;
  relevance: "crypto" | "ai" | "creator" | "other";
  url: string | null;
  sageAngle: string | null;
  detectedAt: string;
}

interface TrendsResponse {
  trends: Trend[];
  lastUpdated: string;
  nextUpdate: string;
}

async function readTrendData(): Promise<TrendsResponse> {
  // 1. Try DataStore (synced by heartbeat)
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "trend-radar" } });
    if (row?.data) {
      const parsed = row.data as unknown as TrendsResponse;
      if (parsed.trends && parsed.trends.length > 0) return parsed;
    }
  } catch { /* not available */ }

  // 2. Try env var cache (pushed by heartbeat, works on Vercel)
  if (process.env.TREND_RADAR_DATA) {
    try {
      const parsed = JSON.parse(process.env.TREND_RADAR_DATA) as TrendsResponse;
      if (parsed.trends && parsed.trends.length > 0) {
        // Normalise any non-standard velocity values Grok might return
        const validVelocities = new Set(["forming", "rising", "peaking", "fading"]);
        const velocityMap: Record<string, Trend["velocity"]> = {
          viral: "peaking", emerging: "forming", stable: "fading",
          breaking: "peaking", new: "forming", growing: "rising",
        };
        parsed.trends = parsed.trends.map((t) => ({
          ...t,
          velocity: validVelocities.has(t.velocity)
            ? t.velocity
            : (velocityMap[t.velocity] ?? "forming"),
        }));
        return parsed;
      }
    } catch { /* invalid */ }
  }

  // 3. No real data — return empty
  const now = new Date();
  return {
    trends: [],
    lastUpdated: now.toISOString(),
    nextUpdate: new Date(now.getTime() + 30 * 60000).toISOString(),
  };
}

export async function GET() {
  try {
    const data = await readTrendData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[trends] GET error:", error);
    const now = new Date();
    return NextResponse.json({
      trends: [],
      lastUpdated: now.toISOString(),
      nextUpdate: new Date(now.getTime() + 5 * 60000).toISOString(),
    });
  }
}
