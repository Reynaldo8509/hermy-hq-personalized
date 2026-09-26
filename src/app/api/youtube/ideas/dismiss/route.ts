import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { title } = await req.json();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  // Delete ideas matching the title
  const result = await prisma.youtubeIdea.deleteMany({
    where: { title },
  });

  // Count remaining ideas
  const remaining = await prisma.youtubeIdea.count();

  return NextResponse.json({ remaining });
}
