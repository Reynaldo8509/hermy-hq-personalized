import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SECRET = "296cfa48ad6963eb21ac9deb4981ad0c982cff51631bda9cf43fd0fa7217088b";

export async function POST(req: Request) {
  if (req.headers.get("x-internal-secret") !== SECRET)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  if (!Array.isArray(body.signals))
    return NextResponse.json({ error: "Expected { signals: [] }" }, { status: 400 });

  await prisma.dataStore.upsert({
    where: { key: "watchlist-radar" },
    update: { data: body },
    create: { key: "watchlist-radar", data: body },
  });

  return NextResponse.json({ ok: true, count: body.signals.length });
}
