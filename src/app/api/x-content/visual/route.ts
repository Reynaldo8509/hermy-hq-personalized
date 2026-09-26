import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";

export const dynamic = 'force-dynamic';

const PUBLIC_VISUAL_DIR = path.join(process.cwd(), "public", "draft-visuals");

// Ensure the directory exists
if (!fs.existsSync(PUBLIC_VISUAL_DIR)) {
  fs.mkdirSync(PUBLIC_VISUAL_DIR, { recursive: true });
}

export async function POST(req: NextRequest) {
  // Get the multipart/form-data
  const formData = await req.formData();
  const file = formData.get('file') as File;
  const draftId = formData.get('draftId') as string;

  if (!file || !draftId) {
    return NextResponse.json({ error: "Missing file or draftId" }, { status: 400 });
  }

  // Check file size (10MB max)
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large. Max 10MB." }, { status: 400 });
  }

  // Check file type
  const validTypes = ['image/png', 'image/jpeg'];
  if (!validTypes.includes(file.type)) {
    return NextResponse.json({ error: "Invalid file type. PNG or JPG only." }, { status: 400 });
  }

  try {
    const draft = await prisma.draft.findUnique({ where: { id: draftId } });

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    // Determine file extension
    const ext = file.type === 'image/png' ? '.png' : '.jpg';
    const newFilename = `${draftId}${ext}`;
    const newPath = path.join(PUBLIC_VISUAL_DIR, newFilename);

    // Write file
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(newPath, buffer);

    // Update the draft with the visual URL
    const visualUrl = `/draft-visuals/${newFilename}`;
    await prisma.draft.update({
      where: { id: draftId },
      data: { visualUrl },
    });

    return NextResponse.json({ visualUrl }, { status: 201 });
  } catch (error) {
    console.error("Visual upload error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { draftId } = await req.json();

  try {
    const draft = await prisma.draft.findUnique({ where: { id: draftId } });

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    // Remove the file if it exists
    if (draft.visualUrl) {
      const filename = path.basename(draft.visualUrl);
      const filePath = path.join(PUBLIC_VISUAL_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // Clear the visualUrl in the draft
      await prisma.draft.update({
        where: { id: draftId },
        data: { visualUrl: null },
      });
    }

    return NextResponse.json({ message: "Visual removed successfully" }, { status: 200 });
  } catch (error) {
    console.error("Visual delete error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
