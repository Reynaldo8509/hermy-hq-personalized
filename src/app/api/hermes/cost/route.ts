import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-cost" } });
  return NextResponse.json(row?.data ?? { summary: null, byModel: [], totalCost: null, totalTokens: null, syncedAt: null });
}
