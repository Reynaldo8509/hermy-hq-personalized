import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_AGENT = {
  id: "max",
  name: "Max",
  emoji: "🐺",
  role: "CEO Corner · Chief of Staff",
};

export async function GET() {
  try {
    const requests = await prisma.agentRequest.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 250,
    });
    return NextResponse.json(
      { requests, source: "hermy", syncedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Tasks API error:", error);
    return NextResponse.json({ error: "No se pudo cargar la cola real de Hermy HQ" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || body.title || "").trim().slice(0, 200);
    const prompt = String(body.prompt || body.description || body.name || "").trim().slice(0, 12000);
    if (!name || !prompt) return NextResponse.json({ error: "Indica un título y una descripción" }, { status: 400 });

    const title = `Max · ${name}`;
    const now = new Date();
    const request = await prisma.agentRequest.create({
      data: {
        origin: "web",
        kind: "max.chief-of-staff",
        title,
        prompt,
        sideEffecting: false,
        status: "queued",
      },
    });
    await prisma.$transaction([
      prisma.agentEvent.create({
        data: {
          kind: "run",
          title: `Solicitud creada desde Tasks: ${title}`,
          agent: "max",
          level: "info",
          meta: { requestId: request.id, source: "tasks-board" },
        },
      }),
      prisma.agentState.upsert({
        where: { id: MAX_AGENT.id },
        update: { status: "working", currentTask: title, lastActive: now },
        create: {
          ...MAX_AGENT,
          status: "working",
          currentTask: title,
          lastActive: now,
          tasksCompleted: 0,
          totalCost: 0,
          recentActivity: [{ timestamp: now.toISOString(), action: "Task created from Hermy HQ Tasks" }],
        },
      }),
    ]);
    return NextResponse.json({ request }, { status: 201 });
  } catch (error) {
    console.error("Create task error:", error);
    return NextResponse.json({ error: "No se pudo crear la solicitud" }, { status: 500 });
  }
}
