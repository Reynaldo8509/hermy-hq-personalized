import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { title, status, rejectedReason } = await req.json();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  // Update the idea by title
  await prisma.youtubeIdea.updateMany({
    where: { title },
    data: {
      status: status || "rejected",
      rejectedReason: rejectedReason || undefined,
    },
  });

  // Also save feedback to learning table
  if (status === "rejected" && rejectedReason) {
    await prisma.youtubeFeedback.create({
      data: {
        title,
        reason: rejectedReason,
        type: "idea",
      },
    });
  }

  return NextResponse.json({ ok: true });
}
