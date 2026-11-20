"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Plus, History, ShieldCheck, RotateCcw, RefreshCw } from "lucide-react";

type Entry = { id: string; path: string; type: string; title: string; status: string; confidence: string | number | null; provenance: string | null; tags: string[]; links: string[]; body: string; updatedAt: string; syncedAt: string };
type Proposal = { id: string; kind: string; title: string; status: string; createdAt: string; updatedAt: string };
type MemoryData = { entries: Entry[]; total: number; lastSync: string | null; duplicates: Array<{ fingerprint: string; title: string; ids: string[]; occurrences: number }>; proposals: Proposal[] };
type Incident = { id: string; fingerprint?: string | null; incident: string; evidence: string; cause?: string; hypothesis?: string; remediation?: string; validation?: string; limitations?: string; next_action?: string; status: string; agent: string; created_at: string; updated_at: string; closed_at?: string | null };
type HistoryData = { entry: { id: string; title: string }; workingTreeDirty?: boolean; versions: Array<{ commit: string; createdAt: string | null; subject: string }>; preview?: string };
type HonchoPeer = { id: string; name: string; kind: string };
type HonchoData = { ok: boolean; error?: string; workspace?: { id: string; name: string; createdAt: string | null }; peers?: { total: number; items: HonchoPeer[] }; sessions?: { total: number; recent: Array<{ id: string; createdAt: string | null; active: boolean; messageCount: number; lastMessageAt: string | null }> }; messages?: Array<{ id: string; sessionId: string; peerId: string; peerName: string; role: string; content: string; createdAt: string | null }>; conclusions?: { total: number; recent: Array<{ id: string; content: string; observerId: string; observerName: string; observedId: string; observedName: string; sessionId: string | null; level: string; createdAt: string | null }> }; metrics?: { messagesInRecentSessions: number; messagesCoverageSessions: number; conclusions: number; lastWrittenAt: string | null }; partialErrors?: string[]; statusUrl?: string };

type EditDraft = { id?: string; type: string; title: string; body: string; status: string; confidence: string; tags: string; links: string };
const agents = ["max", "codex", "atlas", "aegis", "ledger", "milo", "pulse", "domus", "hermes"];
const types = ["fact", "preference", "decision", "event", "project", "contact", "lesson", "metric", "note", "investigation"];

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
function key() { return globalThis.crypto?.randomUUID?.() || `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function formatDate(value?: string | null) { if (!value) return "Sin dato"; return formatEcuadorTimestamp(value, { invalid: value }); }
function draftFrom(entry?: Entry): EditDraft { return { id: entry?.id, type: entry?.type || "note", title: entry?.title || "", body: entry?.body || "", status: entry?.status || "active", confidence: entry?.confidence == null ? "" : String(entry.confidence), tags: (entry?.tags || []).join(", "), links: (entry?.links || []).join(", ") }; }

export default function MemoryCenterPage() {
  const [tab, setTab] = useState<"wiki" | "incidents" | "honcho">("wiki");
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [honcho, setHoncho] = useState<HonchoData | null>(null);
  const [honchoLoading, setHonchoLoading] = useState(false);
  const [honchoSaving, setHonchoSaving] = useState(false);
  const [honchoObserver, setHonchoObserver] = useState("");
  const [honchoObserved, setHonchoObserved] = useState("");
  const [honchoContent, setHonchoContent] = useState("");
  const [honchoNotice, setHonchoNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [historyFor, setHistoryFor] = useState<Entry | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [preview, setPreview] = useState("");
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status: "all" });
      if (query.trim()) params.set("q", query.trim());
      if (agent !== "all") params.set("agent", agent);
      if (typeFilter !== "all") params.set("type", typeFilter);
      const data = await responseJson<MemoryData>(await fetch(`/api/hermes/memory?${params}`, { cache: "no-store" }));
      setMemory(data);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo cargar la memoria"); }
    finally { setLoading(false); }
  }, [query, agent, typeFilter]);

  useEffect(() => { const timer = setTimeout(() => { void load(); }, 250); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (tab !== "incidents") return;
    const params = new URLSearchParams(); if (query.trim()) params.set("q", query.trim()); if (agent !== "all") params.set("agent", agent);
    fetch(`/api/hermes/incident-memory?${params}`, { cache: "no-store" }).then((r) => r.json()).then((data) => setIncidents(data.incidents || [])).catch(() => setIncidents([]));
  }, [tab, query, agent]);
  const loadHoncho = useCallback(async () => {
    setHonchoLoading(true);
    try {
      const response = await fetch("/api/honcho", { cache: "no-store" });
      const payload = await response.json();
      setHoncho(payload as HonchoData);
    } catch { setHoncho({ ok: false, error: "Honcho no disponible" }); }
    finally { setHonchoLoading(false); }
  }, []);
  useEffect(() => {
    if (tab === "honcho" && !honcho && !honchoLoading) void loadHoncho();
  }, [tab, honcho, honchoLoading, loadHoncho]);
  useEffect(() => {
    if (!honcho?.peers?.items?.length) return;
    const peers = honcho.peers.items;
    setHonchoObserver((current) => current || peers.find((peer) => peer.id === "hermes")?.id || peers[0]?.id || "");
    setHonchoObserved((current) => current || peers.find((peer) => peer.id === "user")?.id || peers.find((peer) => peer.id !== "hermes")?.id || peers[0]?.id || "");
  }, [honcho]);


  const writeHonchoMemory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (honchoSaving) return;
    setHonchoSaving(true); setError(""); setHonchoNotice("");
    try {
      await responseJson(await fetch("/api/honcho", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write-memory", observerId: honchoObserver, observedId: honchoObserved, content: honchoContent }),
      }));
      setHonchoNotice("Memoria explícita guardada en Honcho.");
      setHonchoContent(""); setHoncho(null);
      await loadHoncho();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo escribir la memoria en Honcho"); }
    finally { setHonchoSaving(false); }
  };

  const duplicateIds = useMemo(() => new Set((memory?.duplicates || []).flatMap((group) => group.ids)), [memory]);
  const incidentGroups = useMemo(() => {
    const groups = new Map<string, Incident[]>();
    for (const incident of incidents) {
      const fingerprint = incident.fingerprint || incident.id;
      groups.set(fingerprint, [...(groups.get(fingerprint) || []), incident]);
    }
    return [...groups.entries()].map(([fingerprint, records]) => ({ fingerprint, records: records.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)), latest: records.reduce((a, b) => Date.parse(a.updated_at) >= Date.parse(b.updated_at) ? a : b) }))
      .sort((a, b) => Date.parse(b.latest.updated_at) - Date.parse(a.latest.updated_at));
  }, [incidents]);
  const pendingProposals = (memory?.proposals || []).filter((item) => ["awaiting_approval", "approved", "queued", "running"].includes(item.status));

  const saveProposal = async () => {
    if (!editor || saving) return;
    setSaving(true); setError("");
    try {
      const parsedConfidence = Number(editor.confidence);
      const payload = { ...editor, confidence: editor.confidence && Number.isFinite(parsedConfidence) ? parsedConfidence : null,
        tags: editor.tags.split(",").map((v) => v.trim()).filter(Boolean), links: editor.links.split(",").map((v) => v.trim()).filter(Boolean), action: "propose" };
      const data = await responseJson<{ request: { id: string; status: string }; duplicate: boolean }>(await fetch("/api/hermes/memory", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(payload),
      }));
      setNotice(`Propuesta ${data.request.id} · ${data.request.status}. Requiere aprobación individual.`);
      setEditor(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear la propuesta"); }
    finally { setSaving(false); }
  };

  const openHistory = async (entry: Entry) => {
    setHistoryFor(entry); setHistory(null); setPreview(""); setSelectedVersion("");
    try {
      const params = new URLSearchParams({ historyId: entry.id });
      const result = await responseJson<HistoryData>(await fetch(`/api/hermes/memory?${params}`, { cache: "no-store" }));
      setHistory(result); setSelectedVersion(result.versions[0]?.commit || "");
    } catch (e) { setError(e instanceof Error ? e.message : "Historial Git no disponible"); }
  };
  const previewVersion = async (commit: string) => {
    setSelectedVersion(commit); setPreview("");
    if (!historyFor || !commit) return;
    try {
      const params = new URLSearchParams({ historyId: historyFor.id, commit });
      const result = await responseJson<HistoryData>(await fetch(`/api/hermes/memory?${params}`, { cache: "no-store" }));
      setPreview(result.preview || "");
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo leer la versión"); }
  };
  const proposeRestore = async () => {
    if (!historyFor || !selectedVersion || restoring) return;
    setRestoring(true);
    try {
      const data = await responseJson<{ request: { id: string; status: string } }>(await fetch("/api/hermes/memory", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({ action: "restore", id: historyFor.id, commit: selectedVersion }),
      }));
      setNotice(`Restauración propuesta ${data.request.id} · ${data.request.status}. La versión no cambia hasta que se apruebe.`);
      setHistoryFor(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo proponer la restauración"); }
    finally { setRestoring(false); }
  };

  return <main className="w-full max-w-7xl mx-auto pb-16 space-y-6 text-[var(--text)]">
    <header className="flex flex-wrap items-end justify-between gap-4 pt-2">
      <div><div className="eyebrow">Hermes · memoria y continuidad</div><h1 className="mt-2 text-3xl font-semibold">Memory Center</h1><p className="mt-2 text-sm text-[var(--text-3)]">Wiki versionada, incidentes y métricas de memoria compartida. Las correcciones y restauraciones quedan como propuestas aprobables.</p></div>
      {tab === "wiki" && <button onClick={() => setEditor(draftFrom())} className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm"><Plus size={15}/> Nueva propuesta</button>}
    </header>
    <div className="flex flex-wrap gap-2">
      {([ ["wiki", "Wiki Hermes"], ["incidents", "Incidentes y decisiones"], ["honcho", "Honcho"] ] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`rounded-full border px-4 py-2 text-xs ${tab === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)] text-[var(--text-2)]"}`}>{label}</button>)}
      <Link href="/action-center" className="ml-auto rounded-full border border-[var(--line)] px-4 py-2 text-xs text-[var(--text-2)]">Revisar aprobaciones →</Link>
    </div>
    {notice && <div className="panel p-3 text-sm text-[var(--up)]">{notice}</div>}
    {error && <div role="alert" className="panel p-3 text-sm text-[var(--down)]">{error}</div>}

    {tab !== "honcho" && <section className="panel flex flex-wrap gap-3 p-4">
      <label className="relative min-w-[220px] flex-1"><Search size={15} className="absolute left-3 top-3 text-[var(--text-3)]"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar título, evidencia o cuerpo" className="w-full rounded-lg border border-[var(--line)] bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none"/></label>
      <select value={agent} onChange={(e) => setAgent(e.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"><option value="all">Todos los agentes</option>{agents.map((id) => <option key={id} value={id}>{id.toUpperCase()}</option>)}</select>
      {tab === "wiki" && <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"><option value="all">Todos los tipos</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select>}
      <button onClick={() => void load()} className="rounded-lg border border-[var(--line)] p-2.5" aria-label="Actualizar"><RefreshCw size={16}/></button>
    </section>}

    {tab === "wiki" && <>
      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel p-4"><div className="eyebrow">Wiki</div><div className="mt-1 text-2xl font-semibold">{memory?.total ?? "—"}</div><div className="text-xs text-[var(--text-3)]">entradas · sincronizada {formatDate(memory?.lastSync)}</div></div>
        <div className="panel p-4"><div className="eyebrow">Duplicados exactos en resultados</div><div className="mt-1 text-2xl font-semibold">{memory?.duplicates?.length ?? "—"}</div><div className="text-xs text-[var(--text-3)]">solo sugerencias; no se fusiona ni borra nada</div></div>
        <div className="panel p-4"><div className="eyebrow">Propuestas activas</div><div className="mt-1 text-2xl font-semibold">{pendingProposals.length}</div><div className="text-xs text-[var(--text-3)]">cambios esperando aprobación o ejecución</div></div>
      </section>
      {(memory?.proposals?.length || 0) > 0 && <section className="panel p-4"><h2 className="font-semibold">Cambios de memoria recientes</h2><p className="mt-1 text-xs text-[var(--text-3)]">Incluye propuestas pendientes y resultados anteriores. Los parámetros completos de cambios pendientes se revisan en Action Center.</p><div className="mt-3 space-y-2">{memory?.proposals.slice(0, 10).map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"><span className="flex-1">{item.title}</span><span className={`text-xs ${item.status === "awaiting_approval" ? "text-[var(--warn)]" : "text-[var(--text-3)]"}`}>{item.status}</span><span className="num text-[11px] text-[var(--text-3)]">{formatDate(item.createdAt)}</span></div>)}</div></section>}
      <section className="space-y-3">{loading && <div className="panel p-4 text-sm text-[var(--text-3)]">Consultando wiki…</div>}{!loading && memory?.entries.length === 0 && <div className="panel p-6 text-sm text-[var(--text-3)]">No hay coincidencias. La búsqueda usa el espejo Hermes existente.</div>}
        {(memory?.entries || []).map((entry) => <article key={entry.id} className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="eyebrow">{entry.type} · {entry.status}</span>{duplicateIds.has(entry.id) && <span className="rounded-full border border-[var(--warn)] px-2 py-0.5 text-[10px] text-[var(--warn)]">Duplicado exacto</span>}</div><h2 className="mt-1 text-lg font-semibold">{entry.title}</h2></div><span className="num text-[11px] text-[var(--text-3)]">{formatDate(entry.updatedAt)}</span></div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-3)]"><span><ShieldCheck size={12} className="mr-1 inline"/>Procedencia: {entry.provenance || "sin registrar"}</span><span>Wiki: {entry.path}</span></div>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-2)]">{entry.body}</p>
          {!!entry.tags?.length && <div className="mt-3 flex flex-wrap gap-1.5">{entry.tags.map((tag) => <span key={tag} className="rounded-full bg-[var(--surface-2)] px-2 py-1 text-[10px] text-[var(--text-3)]">{tag}</span>)}</div>}
          <div className="mt-4 flex flex-wrap gap-2"><button onClick={() => setEditor(draftFrom(entry))} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs">Proponer corrección</button><button onClick={() => void openHistory(entry)} className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-3 py-1.5 text-xs"><History size={13}/> Versiones</button></div>
        </article>)}
      </section>
    </>}

    {tab === "incidents" && <section className="space-y-3">
      <div className="panel p-4 text-sm text-[var(--text-3)]">Incidentes agrupados por fingerprint desde IncidentMemory; los resultados de tareas no se marcan resueltos automáticamente. Las decisiones históricas están disponibles en Wiki con filtro de tipo decisión.</div>
      {incidentGroups.length === 0 && <div className="panel p-6 text-sm text-[var(--text-3)]">No hay incidentes para estos filtros o IncidentMemory no tiene datos.</div>}
      {incidentGroups.map((group) => { const item = group.latest; return <article key={group.fingerprint} className="panel p-4"><div className="flex flex-wrap items-center gap-2"><h2 className="flex-1 font-semibold">{item.incident}</h2><span className="text-xs text-[var(--warn)]">{item.status}</span><span className="rounded-full border border-[var(--line)] px-2 py-1 text-[10px]">{group.records.length} ocurrencia{group.records.length === 1 ? "" : "s"}</span></div><div className="mt-1 text-[11px] text-[var(--text-3)]">Agente {item.agent || "—"} · fingerprint {group.fingerprint} · actualizado {formatDate(item.updated_at)}</div><dl className="mt-3 grid gap-3 md:grid-cols-2 text-sm"><div><dt className="eyebrow">Evidencia</dt><dd className="mt-1 whitespace-pre-wrap text-[var(--text-2)]">{item.evidence || "Sin evidencia registrada"}</dd></div><div><dt className="eyebrow">Causa / hipótesis</dt><dd className="mt-1 text-[var(--text-2)]">{item.cause || item.hypothesis || "Sin causa documentada"}</dd></div><div><dt className="eyebrow">Acción propuesta</dt><dd className="mt-1 text-[var(--text-2)]">{item.next_action || item.remediation || "Sin acción documentada"}</dd></div><div><dt className="eyebrow">Validación</dt><dd className="mt-1 text-[var(--text-2)]">{item.validation || "Pendiente"}</dd></div></dl>{item.limitations && <p className="mt-3 text-xs text-[var(--text-3)]">Límites: {item.limitations}</p>}{group.records.length > 1 && <details className="mt-3 border-t border-[var(--line)] pt-3"><summary className="cursor-pointer text-xs text-[var(--accent)]">Ver historial de {group.records.length} ocurrencias</summary><div className="mt-2 space-y-2">{group.records.map((record) => <div key={record.id} className="rounded border border-[var(--line)] p-2 text-xs"><div>{formatDate(record.created_at)} · {record.status}</div><p className="mt-1 whitespace-pre-wrap text-[var(--text-2)]">{record.evidence || record.incident}</p></div>)}</div></details>}</article>; })}
    </section>}

    {tab === "honcho" && <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-[var(--text-3)]">Memoria remota de Honcho y memoria local de Hermes permanecen separadas.</div><div className="flex gap-2"><button onClick={() => setTab("wiki")} className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs">Abrir Wiki Hermes</button><button onClick={() => { setHoncho(null); void loadHoncho(); }} disabled={honchoLoading} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:opacity-50"><RefreshCw size={13} className={honchoLoading ? "animate-spin" : ""}/>Actualizar Honcho</button></div></div>
      {honchoLoading && !honcho && <div className="panel p-5 text-sm text-[var(--text-3)]">Consultando workspace, peers, sesiones y memorias recientes de Honcho…</div>}
      {honcho && !honcho.ok && <div role="alert" className="panel p-5 text-sm text-[var(--down)]">Honcho no disponible: {honcho.error || "Error de conexión"}. La Wiki Hermes local sigue accesible en su pestaña.</div>}
      {honcho?.ok && <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="panel p-4"><div className="eyebrow">Conexión Honcho</div><div className="mt-2 font-semibold text-[var(--up)]">Disponible</div><div className="mt-1 text-xs text-[var(--text-3)]">Última escritura: {formatDate(honcho.metrics?.lastWrittenAt)}</div></div>
          <div className="panel p-4"><div className="eyebrow">Workspace</div><div className="mt-2 break-all font-semibold">{honcho.workspace?.name || honcho.workspace?.id}</div><div className="mt-1 text-xs text-[var(--text-3)]">Organización de memoria · {honcho.workspace?.id}</div></div>
          <div className="panel p-4"><div className="eyebrow">Peers / agentes</div><div className="mt-2 text-2xl font-semibold">{honcho.peers?.total ?? 0}</div><div className="mt-1 text-xs text-[var(--text-3)]">Identidades registradas en el workspace</div></div>
          <div className="panel p-4"><div className="eyebrow">Sesiones y análisis</div><div className="mt-2 text-2xl font-semibold">{honcho.sessions?.total ?? 0} · {honcho.metrics?.conclusions ?? 0}</div><div className="mt-1 text-xs text-[var(--text-3)]">sesiones · conclusiones registradas</div></div>
        </section>
        {honcho.partialErrors?.length ? <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-100">Lectura parcial de Honcho: {honcho.partialErrors.join(" · ")}</div> : null}
        <section className="panel p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Peers de la organización</h2><p className="mt-1 text-xs text-[var(--text-3)]">Workspace {honcho.workspace?.id}; las relaciones se forman entre peers observador y observado.</p></div><a href={honcho.statusUrl || "https://app.honcho.dev/status"} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)]">Estado de Honcho ↗</a></div>
          {honcho.peers?.items.length ? <div className="mt-3 flex flex-wrap gap-2">{honcho.peers.items.map((peer) => <span key={peer.id} className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs"><strong>{peer.name || peer.id}</strong><span className="ml-2 text-[var(--text-3)]">{peer.kind} · {peer.id}</span></span>)}</div> : <p className="mt-3 text-sm text-[var(--text-3)]">No hay peers en este workspace.</p>}
        </section>
        <section className="panel p-4 sm:p-5"><div><h2 className="font-semibold">Crear memoria en Honcho</h2><p className="mt-1 text-xs text-[var(--text-3)]">Esta acción escribe directamente una conclusión explícita. No modifica la Wiki local ni crea una propuesta de aprobación de wiki.</p></div>
          {honcho.peers?.items.length ? <form onSubmit={(event) => void writeHonchoMemory(event)} className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs text-[var(--text-2)]">Quién recuerda
              <select required value={honchoObserver} onChange={(event) => setHonchoObserver(event.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm">{honcho.peers.items.map((peer) => <option key={peer.id} value={peer.id}>{peer.name || peer.id} · {peer.id}</option>)}</select>
            </label>
            <label className="grid gap-1 text-xs text-[var(--text-2)]">Sobre quién trata
              <select required value={honchoObserved} onChange={(event) => setHonchoObserved(event.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm">{honcho.peers.items.map((peer) => <option key={peer.id} value={peer.id}>{peer.name || peer.id} · {peer.id}</option>)}</select>
            </label>
            <label className="grid gap-1 text-xs text-[var(--text-2)] md:col-span-2">Nueva memoria
              <textarea required minLength={8} maxLength={4000} value={honchoContent} onChange={(event) => setHonchoContent(event.target.value)} rows={4} placeholder="Escribe el hecho o preferencia que debe quedar recordado…" className="rounded-lg border border-[var(--line)] bg-transparent p-3 text-sm"/>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2"><span className="text-[11px] text-[var(--text-3)]">La relación elegida queda registrada en Honcho con nivel explícito.</span><button disabled={honchoSaving || !honchoContent.trim() || !honchoObserver || !honchoObserved} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{honchoSaving ? "Escribiendo…" : "Guardar memoria en Honcho"}</button></div>
          </form> : <p className="mt-3 text-sm text-[var(--text-3)]">Se necesitan peers existentes para escribir. Esta pantalla no crea identidades nuevas.</p>}
        </section>
        {honchoNotice && <div role="status" className="panel p-3 text-sm text-[var(--up)]">{honchoNotice}</div>}
        <section className="panel p-4 sm:p-5"><h2 className="font-semibold">Relaciones y análisis de Honcho</h2><p className="mt-1 text-xs text-[var(--text-3)]">Conclusiones recientes con dirección observador → observado, tipo de análisis y sesión de origen.</p>
          {honcho.conclusions?.recent.length ? <div className="mt-3 space-y-2">{honcho.conclusions.recent.slice(0, 20).map((item) => <article key={item.id} className="rounded-lg border border-[var(--line)] p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-xs">{item.observerName} → {item.observedName}</strong><span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--accent)]">{item.level}</span><span className="ml-auto text-[10px] text-[var(--text-3)]">{formatDate(item.createdAt)}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--text-2)]">{item.content || "Conclusión sin texto"}</p><p className="mt-2 text-[10px] text-[var(--text-3)]">{item.observerId} → {item.observedId}{item.sessionId ? ` · sesión ${item.sessionId}` : ""}</p></article>)}</div> : <p className="mt-3 text-sm text-[var(--text-3)]">Honcho no devolvió conclusiones recientes.</p>}
        </section>
        <section className="panel p-4 sm:p-5"><h2 className="font-semibold">Escrituras recientes</h2><p className="mt-1 text-xs text-[var(--text-3)]">Mensajes leídos de {honcho.metrics?.messagesCoverageSessions ?? 0} sesiones recientes · {honcho.metrics?.messagesInRecentSessions ?? 0} mensajes totales en esas sesiones.</p>
          {honcho.messages?.length ? <div className="mt-3 space-y-2">{honcho.messages.slice(0, 30).map((item) => <article key={item.id} className="rounded-lg border border-[var(--line)] p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-xs">{item.peerName || item.peerId || item.role || "Escritura"}</strong><span className="ml-auto text-[10px] text-[var(--text-3)]">{formatDate(item.createdAt)}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--text-2)]">{item.content || "Mensaje sin contenido de texto"}</p><p className="mt-2 text-[10px] text-[var(--text-3)]">Sesión {item.sessionId}</p></article>)}</div> : <p className="mt-3 text-sm text-[var(--text-3)]">No hay mensajes recientes disponibles.</p>}
        </section>
        <section className="panel p-4 sm:p-5"><h2 className="font-semibold">Sesiones recientes</h2><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{honcho.sessions?.recent.map((session) => <article key={session.id} className="rounded-lg border border-[var(--line)] p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{session.id}</span><span className={session.active ? "text-[var(--up)]" : "text-[var(--text-3)]"}>{session.active ? "Activa" : "Cerrada"}</span></div><p className="mt-2 text-[11px] text-[var(--text-3)]">{session.messageCount} mensajes · última escritura {formatDate(session.lastMessageAt || session.createdAt)}</p></article>)}</div></section>
      </>}
    </section>}

    {editor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><section className="panel max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5"><header className="flex items-center justify-between"><div><div className="eyebrow">Propuesta aprobable</div><h2 className="mt-1 text-xl font-semibold">{editor.id ? "Corregir entrada" : "Crear entrada"}</h2></div><button onClick={() => setEditor(null)} aria-label="Cerrar" className="rounded border border-[var(--line)] px-3 py-1">×</button></header><div className="mt-4 grid gap-3"><label className="text-xs text-[var(--text-3)]">Título<input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm"/></label><label className="text-xs text-[var(--text-3)]">Tipo<select value={editor.type} onChange={(e) => setEditor({ ...editor, type: e.target.value })} className="mt-1 w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-sm">{types.map((type) => <option key={type}>{type}</option>)}</select></label><label className="text-xs text-[var(--text-3)]">Contenido<textarea value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} rows={9} maxLength={12000} className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm"/></label><label className="text-xs text-[var(--text-3)]">Etiquetas<input value={editor.tags} onChange={(e) => setEditor({ ...editor, tags: e.target.value })} className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm"/></label><label className="text-xs text-[var(--text-3)]">Enlaces<input value={editor.links} onChange={(e) => setEditor({ ...editor, links: e.target.value })} className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm"/></label></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-[var(--text-3)]">La propuesta conserva su versión anterior y requiere aprobación individual antes de escribir en la wiki.</span><button disabled={saving || !editor.title.trim()} onClick={() => void saveProposal()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{saving ? "Enviando…" : "Enviar a aprobación"}</button></div></section></div>}

    {historyFor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><section className="panel max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5"><header className="flex items-start justify-between gap-3"><div><div className="eyebrow">Wiki Git</div><h2 className="mt-1 text-xl font-semibold">Versiones · {historyFor.title}</h2></div><button onClick={() => setHistoryFor(null)} aria-label="Cerrar" className="rounded border border-[var(--line)] px-3 py-1">×</button></header>{!history && <p className="mt-4 text-sm text-[var(--text-3)]">Consultando historial…</p>}{history?.workingTreeDirty && <p className="mt-3 rounded-lg border border-[var(--warn)] p-3 text-xs text-[var(--warn)]">Esta ruta tiene cambios locales sin commit. La restauración queda bloqueada para conservarlos.</p>}{history?.versions.length === 0 && <p className="mt-4 text-sm text-[var(--text-3)]">No hay commits versionados para esta ruta.</p>}{history?.versions.map((version) => <div key={version.commit} className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] p-3"><div className="min-w-0 flex-1"><div className="text-sm">{version.subject || "Versión sin descripción"}</div><div className="num text-[10px] text-[var(--text-3)]">{formatDate(version.createdAt)} · {version.commit.slice(0, 12)}</div></div><button onClick={() => void previewVersion(version.commit)} className="rounded border border-[var(--line)] px-2.5 py-1 text-xs">Previsualizar</button><button onClick={() => { setSelectedVersion(version.commit); }} className={`rounded border px-2.5 py-1 text-xs ${selectedVersion === version.commit ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)]"}`}>Elegir</button></div>)}{preview && <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3 text-xs">{preview}</pre>}{history?.versions.length ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-[var(--text-3)]">Restaurar solo crea una solicitud. Se escribe después de aprobarla.</p><button disabled={!selectedVersion || restoring || history?.workingTreeDirty === true} onClick={() => void proposeRestore()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--warn)] px-3 py-2 text-xs text-[var(--warn)] disabled:opacity-50"><RotateCcw size={13}/>{restoring ? "Enviando…" : "Proponer restauración"}</button></div> : null}</section></div>}
  </main>;
}
