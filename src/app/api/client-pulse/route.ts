import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type AnalysisWithClient = Prisma.ClientPulseAnalysisGetPayload<{ include: { client: { include: { chats: true } } } }>;

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function GET() {
  const latestRows = await prisma.clientPulseAnalysis.findMany({
    include: { client: { include: { chats: true } } },
    orderBy: { analyzedAt: "desc" },
    take: 500,
  });
  const seen = new Set<string>();
  const latest: AnalysisWithClient[] = [];
  for (const row of latestRows) {
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    latest.push(row);
  }
  const clientIds = latest.map((row) => row.clientId);
  const messages = await prisma.clientPulseMessage.findMany({
    where: { chat: { linkedClientId: { in: clientIds } } },
    include: { chat: true },
    orderBy: { sentAt: "desc" },
    take: 1000,
  });
  const alerts = await prisma.clientPulseAlert.findMany({
    where: { acknowledgedAt: null },
    include: { client: true, chat: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const unmappedChats = await prisma.clientPulseChat.findMany({
    where: { linkedClientId: null },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });

  const messageByClient = new Map<string, { lastClient?: string; lastInternal?: string }>();
  for (const message of messages) {
    const linkedClientId = message.chat?.linkedClientId;
    if (!linkedClientId) continue;
    const existing = messageByClient.get(linkedClientId) || {};
    if (!message.isInternal && !existing.lastClient) existing.lastClient = `${message.senderName}: ${message.text.slice(0, 180)}`;
    if (message.isInternal && !existing.lastInternal) existing.lastInternal = `${message.senderName}: ${message.text.slice(0, 180)}`;
    messageByClient.set(linkedClientId, existing);
  }

  const clients = latest.map((analysis) => {
    const msg = messageByClient.get(analysis.clientId) || {};
    return {
      clientId: analysis.clientId,
      clientName: analysis.client.clientName,
      productManagerName: analysis.client.productManagerName,
      services: asStringArray(analysis.client.services),
      status: analysis.client.status,
      renewalDate: analysis.client.renewalDate,
      endDate: analysis.client.endDate,
      expectedCheckinHours: analysis.client.expectedCheckinHours,
      score: analysis.overallScore,
      category: analysis.category,
      sentimentScore: analysis.sentimentScore,
      responseScore: analysis.responseScore,
      cadenceScore: analysis.cadenceScore,
      renewalRiskScore: analysis.renewalRiskScore,
      reasons: asStringArray(analysis.reasons),
      evidence: asStringArray(analysis.evidence),
      recommendedAction: analysis.recommendedAction,
      llmSummary: analysis.llmSummary,
      analysisSource: analysis.analysisSource,
      analyzedAt: analysis.analyzedAt,
      chats: analysis.client.chats.map((chat) => ({ telegramChatId: chat.telegramChatId, title: chat.title, lastSeenAt: chat.lastSeenAt })),
      lastClientMessage: msg.lastClient,
      lastInternalReply: msg.lastInternal,
    };
  });
  const average = clients.length ? Math.round(clients.reduce((sum, client) => sum + client.score, 0) / clients.length) : null;
  const counts = {
    urgent: clients.filter((client) => client.category === "urgent").length,
    needsAttention: clients.filter((client) => client.category === "needs_attention").length,
    watch: clients.filter((client) => client.category === "watch").length,
    healthy: clients.filter((client) => client.category === "healthy").length,
  };
  return NextResponse.json({ average, counts, clients, alerts, unmappedChats });
}
