export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const scripts = await prisma.youtubeScript.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(scripts);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  const script = await prisma.youtubeScript.create({
    data: {
      id: body.id || undefined,
      title: body.title,
      hook: body.hook || null,
      storySetup: body.storySetup || null,
      conflict: body.conflict || null,
      insight: body.insight || null,
      cta: body.cta || null,
      caption: body.caption || null,
      onScreenText: body.onScreenText || null,
      hookType: body.hookType || null,
      funnelStage: body.funnelStage || null,
      factCheck: body.factCheck || null,
      fullScript: body.fullScript || null,
      status: body.status || "draft",
      rejectedReason: body.rejectedReason || null,
      // SEO Package
      seoTitle: body.seoTitle || null,
      seoDescription: body.seoDescription || null,
      seoTags: body.seoTags || null,
      seoChapters: body.seoChapters || null,
      titleVariants: body.titleVariants || null,
      thumbnailConcept: body.thumbnailConcept || null,
    },
  });

  return NextResponse.json(script);
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, deleted, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (deleted) {
    await prisma.youtubeScript.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  try {
    const script = await prisma.youtubeScript.update({
      where: { id },
      data: updates,
    });

    // Save rejection feedback for learning
    if (updates.status === "rejected" && updates.rejectedReason) {
      await prisma.youtubeFeedback.create({
        data: {
          title: script.title,
          reason: updates.rejectedReason,
          type: "script",
        },
      });
    }

    return NextResponse.json(script);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
