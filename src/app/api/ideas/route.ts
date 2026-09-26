export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");

  const ideas = await prisma.idea.findMany({
    where: type ? { type } : undefined,
    orderBy: { timestamp: "desc" },
  });

  return NextResponse.json(ideas);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  const idea = await prisma.idea.create({
    data: {
      title: body.title,
      description: body.description || null,
      category: body.category || null,
      type: body.type || null,
      model: body.model || null,
      status: body.status || null,
    },
  });

  return NextResponse.json(idea);
}

export async function PUT(req: NextRequest) {
  const { id, ...updates } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const idea = await prisma.idea.update({
      where: { id },
      data: updates,
    });
    return NextResponse.json(idea);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.idea.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
