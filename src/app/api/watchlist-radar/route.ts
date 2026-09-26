import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "watchlist-radar" } });
    if (row?.data) return NextResponse.json(row.data);
  } catch { /* fallthrough */ }
  return NextResponse.json({ signals: [], lastUpdated: null });
}
