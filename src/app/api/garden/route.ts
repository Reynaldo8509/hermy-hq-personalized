import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const GARDEN_KEY = "hermy-hq-garden";

function emptyGarden() {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    plants: [],
  };
}

function validGarden(value: unknown): value is { version?: unknown; plants: unknown[] } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { plants?: unknown }).plants));
}

// Garden data is stored locally in Hermy HQ's Postgres database. The former
// JSONBlob source now returns 403 and made this page unavailable.
export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: GARDEN_KEY } });
  return NextResponse.json(row?.data ?? emptyGarden());
}

export async function PUT(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  if (!validGarden(body)) {
    return NextResponse.json({ error: "garden.plants must be an array" }, { status: 400 });
  }

  const garden = {
    ...body,
    version: typeof body.version === "number" ? body.version : 1,
    lastUpdated: new Date().toISOString(),
  } as Prisma.InputJsonObject;

  await prisma.dataStore.upsert({
    where: { key: GARDEN_KEY },
    update: { data: garden },
    create: { key: GARDEN_KEY, data: garden },
  });
  return NextResponse.json(garden);
}
