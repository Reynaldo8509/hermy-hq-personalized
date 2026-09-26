import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAuthorized(request: Request) {
  const secret = process.env.CLIENT_PULSE_ADMIN_SECRET || process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json() as {
    telegramChatId?: string;
    title?: string;
    linkedClientId?: string;
    internalUserIds?: string[];
    status?: string;
  };
  if (!body.telegramChatId) return NextResponse.json({ error: "telegramChatId is required" }, { status: 400 });
  const chat = await prisma.clientPulseChat.upsert({
    where: { telegramChatId: body.telegramChatId },
    update: {
      title: body.title,
      linkedClientId: body.linkedClientId,
      internalUserIds: body.internalUserIds || [],
      status: body.status,
    },
    create: {
      telegramChatId: body.telegramChatId,
      title: body.title || body.telegramChatId,
      linkedClientId: body.linkedClientId,
      internalUserIds: body.internalUserIds || [],
      status: body.status || "active",
    },
  });
  return NextResponse.json({ ok: true, chat });
}
