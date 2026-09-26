import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SECRET = process.env.INTERNAL_SECRET || "296cfa48ad6963eb21ac9deb4981ad0c982cff51631bda9cf43fd0fa7217088b";

export async function POST(req: Request) {
  const secret = req.headers.get("x-internal-secret");
  if (secret !== SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    if (!body.trends || !Array.isArray(body.trends)) {
      return NextResponse.json({ error: "Invalid payload — expected { trends, lastUpdated, nextUpdate }" }, { status: 400 });
    }

    await prisma.dataStore.upsert({
      where: { key: "trend-radar" },
      update: { data: body },
      create: { key: "trend-radar", data: body },
    });

    return NextResponse.json({ ok: true, count: body.trends.length });
  } catch (error) {
    console.error("[trends/update] error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
