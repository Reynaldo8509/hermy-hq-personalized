export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const scripts = await prisma.longformScript.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(scripts, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (e: any) {
    console.error("[longform GET]", e?.message || e);
    return NextResponse.json({ error: e?.message || "DB error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  const script = await prisma.longformScript.create({
    data: {
      id: body.id || undefined,
      title: body.title,
      type: body.type || null,
      status: body.status || "draft",
      platform: body.platform || null,
      platforms: body.platforms || null,
      description: body.description || null,
      hook: body.hook || null,
      outline: body.outline || null,
      fullScript: body.fullScript || null,
      targetLength: body.targetLength || null,
      factCheck: body.factCheck || null,
      notes: body.notes || null,
    },
  });

  return NextResponse.json(script);
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, deleted, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (deleted) {
    await prisma.longformScript.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  try {
    const script = await prisma.longformScript.update({
      where: { id },
      data: updates,
    });
    return NextResponse.json(script);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
