"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type RequestRow = { id: string; kind: string; title: string; prompt?: string | null; status: string; result?: string | null; error?: string | null; createdAt: string; sideEffecting: boolean };
type BusMessage = { id: string; from: string; to: string; content: string; type: string; timestamp: string; read: boolean };
type Agent = { id: string; emoji: string; name: string; status: string; currentTask?: string };

const PANELS = {
  max: { label: "Command", emoji: "🧭", title: "Max Command Center", text: "Decisions, delegation and results for your chief of staff.", kind: "max.chief-of-staff", sideEffecting: false },
  atlas: { label: "Research", emoji: "🔭", title: "Atlas Research", text: "Evidence-based technical research and implementation plans.", kind: "atlas.research", sideEffecting: false },
  aegis: { label: "Security", emoji: "🛡️", title: "Aegis Security", text: "Authorized cybersecurity reviews. Every request waits for approval.", kind: "aegis.security", sideEffecting: true },
  pulse: { label: "Social", emoji: "📣", title: "Pulse Social Strategy", text: "Social media and YouTube research, planning, SEO, and performance.", kind: "pulse.social", sideEffecting: false },
  ledger: { label: "Ledger", emoji: "🧰", title: "Ledger Operations", text: "Backups, Git, branch health, and daily agent operations. Finance and trading are out of scope.", kind: "ledger.operations", sideEffecting: false },
  domus: { label: "Domus", emoji: "🏠", title: "Domus Home Automation", text: "Home Assistant, Alexa, devices, automations, and safe household status.", kind: "domus.home", sideEffecting: false },
  codex: { label: "Codex", emoji: "⚙️", title: "Codex VPS Worker", text: "Privileged VPS engineering worker. The owner authorized autonomous execution with full system access.", kind: "codex.engineering" },
  milo: { label: "Mail", emoji: "📡", title: "Milo Mail Watch", text: "Only new important Gmail messages are reviewed and alerted through Telegram." },
  home: { label: "Home", emoji: "🏠", title: "Home Assistant", text: "Read-only integration status through Hermes. Physical actions stay outside this panel." },
} as const;
type PanelId = keyof typeof PANELS;

function ago(value?: string) {
  if (!value) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

function OperationsContent() {
  const params = useSearchParams();
  const selected = (params.get("panel") || "max") as PanelId;
  const panel = PANELS[selected] || PANELS.max;
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [milo, setMilo] = useState<any>(null);
  const [home, setHome] = useState<any>(null);
  const [prompt, setPrompt] = useState("");
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    const [requestData, agentData, busData, miloData, homeData] = await Promise.all([
      fetch("/api/hermes/requests?take=100").then(r => r.json()),
      fetch("/api/agents").then(r => r.json()),
      fetch("/api/agent-bus?agent=max").then(r => r.json()),
      fetch("/api/milo/status").then(r => r.json()),
      fetch("/api/home-assistant/status").then(r => r.json()),
    ]);
    setRequests(requestData.requests || []); setAgents(Array.isArray(agentData) ? agentData : []);
    setMessages(busData.messages || []); setMilo(miloData); setHome(homeData);
  }
  useEffect(() => { void load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, []);

  const agent = agents.find(a => a.id === selected);
  const requestKind = "kind" in panel ? panel.kind : "";
  const visibleRequests = useMemo(() => requests.filter(r => r.kind === requestKind), [requests, requestKind]);
  async function dispatch() {
    if (!prompt.trim() || !requestKind) return;
    setSubmitting(true);
    const kind = selected === "max" && deepAnalysis ? "max.deep-analysis" : requestKind;
    await fetch("/api/hermes/dispatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, title: `${panel.label}: ${prompt.trim()}`.slice(0, 200), prompt: prompt.trim(), sideEffecting: deepAnalysis || ("sideEffecting" in panel && panel.sideEffecting) }) });
    setPrompt(""); setSubmitting(false); void load();
  }

  return <div className="w-full p-8 pb-16 space-y-7 text-[var(--text)]">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><div className="eyebrow">Operations</div><h1 className="mt-2 text-[32px] font-semibold tracking-[-.025em]">{panel.emoji} {panel.title}</h1><p className="mt-2 text-[13px] text-[var(--text-3)]">{panel.text}</p></div>
      {agent && <div className="panel px-4 py-3 text-right"><div className="text-[12px] text-[var(--text-3)]">{agent.name}</div><div className="text-[13px] font-medium">{agent.status}{agent.currentTask ? ` · ${agent.currentTask}` : ""}</div></div>}
    </header>
    <nav className="flex flex-wrap gap-2">{Object.entries(PANELS).map(([id, item]) => <a key={id} href={`/operations?panel=${id}`} className={`rounded-full px-3 py-1.5 text-[12px] ${id === selected ? "bg-white/[.1] text-[var(--text)]" : "text-[var(--text-3)]"}`} style={{ border: "1px solid var(--line)" }}>{item.emoji} {item.label}</a>)}</nav>
    {selected === "codex" && <section className="space-y-3"><div className="panel p-5 text-sm text-[var(--text-2)]">Codex runs as the owner-authorized privileged worker on the VPS and processes its queue autonomously.</div><div className="eyebrow">Codex queue</div>{visibleRequests.length === 0 ? <div className="panel p-5 text-sm text-[var(--text-3)]">No Codex tasks.</div> : visibleRequests.slice(0, 20).map(r => <article key={r.id} className="panel p-4"><div className="flex justify-between gap-3"><strong className="text-sm">{r.title}</strong><span className="text-xs text-[var(--text-3)]">{r.status}</span></div><p className="mt-2 text-xs text-[var(--text-2)] whitespace-pre-wrap">{r.result || r.error || r.prompt || "Waiting"}</p></article>)}</section>}
    {selected === "milo" && <section className="panel p-6 space-y-3"><div className="flex justify-between"><span className="eyebrow">Gmail</span><span className={milo?.connected ? "text-[var(--up)]" : "text-[var(--down)]"}>{milo?.connected ? "Connected" : "Not connected"}</span></div><p className="text-sm">Account: {milo?.email || "—"}</p><p className="text-sm text-[var(--text-2)]">Last review: {ago(milo?.lastCheckedAt)} · Alerts last run: {milo?.lastAlertCount ?? 0} · Frequency: every {milo?.intervalMinutes ?? 60} min</p><p className="text-xs text-[var(--text-3)]">{milo?.initialized ? "Baseline saved; only future mail is eligible for alerts." : "Waiting to save the first-mail baseline."}</p></section>}
    {selected === "home" && <section className="panel p-6 space-y-3"><div className="flex justify-between"><span className="eyebrow">Home Assistant service</span><span className={home?.reachable ? "text-[var(--up)]" : "text-[var(--down)]"}>{home?.reachable ? "Connected" : "Unavailable"}</span></div><p className="text-sm">{home?.summary || "Checking Home Assistant reachability…"}</p><p className="text-xs text-[var(--text-3)]">This checks service reachability only. It does not read entity states or run automations.</p></section>}
    {(selected === "max" || selected === "atlas" || selected === "aegis" || selected === "pulse" || selected === "ledger" || selected === "domus") && <><section className="panel p-5"><div className="eyebrow mb-3">New request{"sideEffecting" in panel && panel.sideEffecting ? " · approval required" : ""}</div><div className="flex gap-2"><input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === "Enter" && void dispatch()} placeholder={selected === "atlas" ? "What should Atlas investigate?" : selected === "aegis" ? "Describe the authorized security review" : selected === "ledger" ? "Audit backups, Git, branches, or agent health" : selected === "domus" ? "Review Home Assistant, Alexa, or household status" : "What should Max decide or delegate?"} className="flex-1 rounded-[var(--r-md)] px-3 py-2 text-sm bg-[var(--surface-2)]" style={{ border: "1px solid var(--line)" }}/><button onClick={() => void dispatch()} disabled={submitting || !prompt.trim()} className="btn-primary px-4 text-sm">{submitting ? "Queueing…" : "Send"}</button></div>{selected === "max" && <label className="mt-3 flex items-center gap-2 text-xs text-[var(--text-2)]"><input type="checkbox" checked={deepAnalysis} onChange={e => setDeepAnalysis(e.target.checked)} /> Deep Analysis · requires approval · OpenRouter Free</label>}</section><section className="space-y-3"><div className="eyebrow">Requests</div>{visibleRequests.length === 0 ? <div className="panel p-6 text-sm text-[var(--text-3)]">No requests yet.</div> : visibleRequests.slice(0, 20).map(r => <article key={r.id} className="panel p-4"><div className="flex justify-between gap-3"><strong className="text-sm">{r.title}</strong><span className="text-xs text-[var(--text-3)]">{r.status}</span></div><p className="mt-2 text-xs text-[var(--text-2)] whitespace-pre-wrap">{r.result || r.error || r.prompt || "Waiting in queue"}</p><p className="mt-2 text-[10px] text-[var(--text-4)]">{ago(r.createdAt)}</p></article>)}</section>{selected === "max" && messages.length > 0 && <section className="space-y-3"><div className="eyebrow">Team reports to Max</div>{messages.slice(-10).reverse().map(m => <div key={m.id} className="panel p-3 text-xs"><span className="font-medium">{m.from}:</span> <span className="text-[var(--text-2)]">{m.content}</span></div>)}</section>}</>}
  </div>;
}

export default function OperationsPage() {
  return <Suspense fallback={<div className="p-8 text-sm text-[var(--text-3)]">Loading operations…</div>}><OperationsContent /></Suspense>;
}
