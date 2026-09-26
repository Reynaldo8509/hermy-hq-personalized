export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    // Get the most recent calendar entry
    const calendar = await prisma.contentCalendar.findFirst({
      orderBy: { week: "desc" },
    });

    if (!calendar) return NextResponse.json({ days: [] });

    // The `data` field contains the full calendar JSON
    return NextResponse.json(calendar.data);
  } catch {
    return NextResponse.json({ days: [] });
  }
}
