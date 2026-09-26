import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-briefing" } });
  return NextResponse.json(row?.data ?? { generatedAt: null, summary: null, sections: [] });
}

// POST → ask the bridge to (re)generate the chief-of-staff brief now.
export async function POST() {
  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind: "briefing.generate",
      title: "Generate chief-of-staff brief",
      prompt: "now",
      sideEffecting: false,
      status: "queued",
    },
  });
  return NextResponse.json({ request: row });
}
