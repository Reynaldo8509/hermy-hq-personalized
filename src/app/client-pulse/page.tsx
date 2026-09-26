"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, SectionHeader, Eyebrow, Skeleton, EmptyState, Pill } from "@/components/ui/kit";

type PulseClient = {
  clientId: string;
  clientName: string;
  productManagerName?: string;
  services: string[];
  status?: string;
  renewalDate?: string;
  endDate?: string;
  score: number;
  category: "healthy" | "watch" | "needs_attention" | "urgent";
  sentimentScore: number;
  responseScore: number;
  cadenceScore: number;
  renewalRiskScore: number;
  reasons: string[];
  evidence: string[];
  recommendedAction?: string;
  llmSummary?: string;
  analysisSource: string;
  analyzedAt: string;
  chats: { telegramChatId: string; title: string; lastSeenAt?: string }[];
  lastClientMessage?: string;
  lastInternalReply?: string;
};

type PulseData = {
  average: number | null;
  counts: { urgent: number; needsAttention: number; watch: number; healthy: number };
  clients: PulseClient[];
  unmappedChats: { telegramChatId: string; title: string; lastSeenAt?: string }[];
};

const categoryLabel: Record<PulseClient["category"], string> = {
  urgent: "Urgent",
  needs_attention: "Needs attention",
  watch: "Watch",
  healthy: "Healthy",
};

const categoryTone: Record<PulseClient["category"], "down" | "warn" | "neutral" | "up"> = {
  urgent: "down",
  needs_attention: "warn",
  watch: "neutral",
  healthy: "up",
};

function scoreColor(score: number) {
  if (score >= 85) return "var(--up)";
  if (score >= 70) return "var(--warn)";
  if (score >= 50) return "var(--accent)";
  return "var(--down)";
}

function dateLabel(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { timeZone: "Europe/Amsterdam" });
}

export default function ClientPulsePage() {
  const [data, setData] = useState<PulseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");
  const [service, setService] = useState("all");
  const [owner, setOwner] = useState("all");

  useEffect(() => {
    fetch("/api/client-pulse")
      .then((res) => res.json())
      .then((json) => setData(json))
      .finally(() => setLoading(false));
  }, []);

  const services = useMemo(() => Array.from(new Set((data?.clients || []).flatMap((client) => client.services))).sort(), [data]);
  const owners = useMemo(() => Array.from(new Set((data?.clients || []).map((client) => client.productManagerName || "Unassigned"))).sort(), [data]);
  const clients = useMemo(() => {
    return (data?.clients || []).filter((client) => {
      if (category !== "all" && client.category !== category) return false;
      if (service !== "all" && !client.services.includes(service)) return false;
      if (owner !== "all" && (client.productManagerName || "Unassigned") !== owner) return false;
      return true;
    });
  }, [data, category, service, owner]);

  const selectClass = "bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3 py-2 text-sm text-[var(--text)]";

  if (loading) {
    return (
      <div className="relative z-10 p-8 space-y-8">
        <Skeleton className="h-16 w-72" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-64" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-10 p-8 space-y-8 text-[var(--text)]">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <Eyebrow>Quality control</Eyebrow>
          <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.02em] text-[var(--text)]">Client Pulse</h1>
          <p className="text-sm text-[var(--text-2)] mt-1">Telegram client sentiment, response SLAs, check-in cadence, and renewal risk.</p>
        </div>
        <div className="text-right">
          <Eyebrow>Average score</Eyebrow>
          <p className="num text-[40px] font-semibold tracking-[-0.02em] leading-none mt-1" style={{ color: scoreColor(data?.average || 0) }}>{data?.average ?? "—"}</p>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Panel className="p-4">
          <Eyebrow className="text-[var(--down)]">Urgent</Eyebrow>
          <p className="num text-[28px] font-semibold tracking-[-0.02em] mt-1">{data?.counts.urgent || 0}</p>
        </Panel>
        <Panel className="p-4">
          <Eyebrow className="text-[var(--warn)]">Needs attention</Eyebrow>
          <p className="num text-[28px] font-semibold tracking-[-0.02em] mt-1">{data?.counts.needsAttention || 0}</p>
        </Panel>
        <Panel className="p-4">
          <Eyebrow>Watch</Eyebrow>
          <p className="num text-[28px] font-semibold tracking-[-0.02em] mt-1">{data?.counts.watch || 0}</p>
        </Panel>
        <Panel className="p-4">
          <Eyebrow className="text-[var(--up)]">Healthy</Eyebrow>
          <p className="num text-[28px] font-semibold tracking-[-0.02em] mt-1">{data?.counts.healthy || 0}</p>
        </Panel>
      </section>

      <section className="flex flex-wrap gap-3">
        <select value={category} onChange={(event) => setCategory(event.target.value)} className={selectClass}>
          <option value="all">All categories</option>
          {Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={service} onChange={(event) => setService(event.target.value)} className={selectClass}>
          <option value="all">All services</option>
          {services.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={owner} onChange={(event) => setOwner(event.target.value)} className={selectClass}>
          <option value="all">All PMs</option>
          {owners.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {clients.map((client) => (
          <Panel key={client.clientId} className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold tracking-[-0.015em] text-[var(--text)]">{client.clientName}</h2>
                  <Pill tone={categoryTone[client.category]}>{categoryLabel[client.category]}</Pill>
                </div>
                <p className="text-sm text-[var(--text-3)] mt-1">{client.productManagerName || "Unassigned"} · {client.services.join(", ") || "No service"} · {client.status || "No status"}</p>
              </div>
              <div className="text-right">
                <p className="num text-[40px] font-semibold tracking-[-0.02em] leading-none" style={{ color: scoreColor(client.score) }}>{client.score}</p>
                <p className="text-xs text-[var(--text-3)] mt-1">overall</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="bg-[var(--surface-2)] rounded-[var(--r-md)] p-3"><p className="text-xs text-[var(--text-3)]">Sentiment</p><p className="num font-semibold text-[var(--text)] mt-0.5">{client.sentimentScore}</p></div>
              <div className="bg-[var(--surface-2)] rounded-[var(--r-md)] p-3"><p className="text-xs text-[var(--text-3)]">Response</p><p className="num font-semibold text-[var(--text)] mt-0.5">{client.responseScore}</p></div>
              <div className="bg-[var(--surface-2)] rounded-[var(--r-md)] p-3"><p className="text-xs text-[var(--text-3)]">Cadence</p><p className="num font-semibold text-[var(--text)] mt-0.5">{client.cadenceScore}</p></div>
              <div className="bg-[var(--surface-2)] rounded-[var(--r-md)] p-3"><p className="text-xs text-[var(--text-3)]">Renewal</p><p className="num font-semibold text-[var(--text)] mt-0.5">{client.renewalRiskScore}</p></div>
            </div>
            <div className="text-sm text-[var(--text-2)] space-y-2">
              <p><span className="text-[var(--text-3)]">Renewal/end:</span> {dateLabel(client.renewalDate || client.endDate)}</p>
              {client.llmSummary && <p><span className="text-[var(--text-3)]">Summary:</span> {client.llmSummary}</p>}
              {client.recommendedAction && <p><span className="text-[var(--text-3)]">Action:</span> {client.recommendedAction}</p>}
              {client.lastClientMessage && <p><span className="text-[var(--text-3)]">Last client:</span> {client.lastClientMessage}</p>}
              {client.lastInternalReply && <p><span className="text-[var(--text-3)]">Last internal:</span> {client.lastInternalReply}</p>}
            </div>
            <div className="space-y-1">
              {client.reasons.slice(0, 4).map((reason) => <p key={reason} className="text-xs text-[var(--text-3)]">• {reason}</p>)}
              {client.evidence.slice(0, 2).map((evidence) => <p key={evidence} className="text-xs text-[var(--text-2)] border-l border-[var(--line)] pl-3">{evidence}</p>)}
            </div>
          </Panel>
        ))}
      </section>

      <Panel className="p-5">
        <SectionHeader title="Unmapped Telegram chats" />
        {!data?.unmappedChats.length && (
          <EmptyState title="No unmapped chats discovered yet." />
        )}
        <div className="space-y-2">
          {data?.unmappedChats.map((chat) => (
            <div key={chat.telegramChatId} className="flex justify-between border border-[var(--line)] rounded-[var(--r-md)] p-3 text-sm text-[var(--text)]">
              <span>{chat.title}</span>
              <code className="num text-[var(--text-3)]">{chat.telegramChatId}</code>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
