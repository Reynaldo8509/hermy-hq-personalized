"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw, Play, Pause, CalendarClock, ShieldCheck, FileText } from "lucide-react";

type Timer = { unit: string; label: string; objective?: string | null; schedule?: string | null; nextRun?: string | null; lastRun?: string | null; lastResult?: string | null; lastExitStatus?: string | null; durationMs?: number | null; activeState: string; subState: string; unitFileState: string; service?: string | null; serviceActiveState?: string; managed: boolean; allowedActions: string[]; source: string };
type Cron = { id: string; name: string; status: string; schedule: string; nextRun: string | null; lastRun: string | null; lastResult: string | null; deliver?: string | null; skills?: string | null; script?: string | null; mode?: string | null };
function idempotencyKey() { return globalThis.crypto?.randomUUID?.() || `automation-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function formatDate(value?: string | null) { if (!value) return "Sin dato"; return formatEcuadorTimestamp(value, { invalid: value }); }
function formatDuration(value?: number | null) { return value == null ? "Sin medición" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`; }

export default function AutomationCenterPage() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [crons, setCrons] = useState<Cron[]>([]);
  const [homeAssistant, setHomeAssistant] = useState<{ reachable: boolean; summary: string; checkedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [logsFor, setLogsFor] = useState("");
  const [logs, setLogs] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [timerResponse, cronResponse] = await Promise.all([fetch("/api/automations", { cache: "no-store" }), fetch("/api/hermes/crons", { cache: "no-store" })]);
      const [timerData, cronData] = await Promise.all([timerResponse.json(), cronResponse.json()]);
      if (!timerResponse.ok) throw new Error(timerData.error || `HTTP ${timerResponse.status}`);
      if (!cronResponse.ok) throw new Error(cronData.error || `HTTP ${cronResponse.status}`);
      setTimers(timerData.timers || []); setCrons(cronData.jobs || []);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo cargar el inventario"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch("/api/home-assistant/status", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      setHomeAssistant({ reachable: Boolean(data.reachable), summary: String(data.summary || ""), checkedAt: String(data.checkedAt || "") });
    }).catch(() => setHomeAssistant({ reachable: false, summary: "Home Assistant no responde desde el VPS.", checkedAt: "" }));
  }, []);

  const requestSystemd = async (timer: Timer, action: string) => {
    const key = `${timer.unit}:${action}`; setBusy(key); setError(""); setNotice("");
    try {
      const response = await fetch("/api/automations", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey() }, body: JSON.stringify({ timer: timer.unit, action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setNotice(`${data.duplicate ? "Ya existe" : "Creada"} la solicitud ${data.request.id}; está en ${data.request.status} y requiere aprobación individual.`);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear la solicitud"); }
    finally { setBusy(""); }
  };
  const requestCron = async (cron: Cron, op: "pause" | "resume" | "run") => {
    const key = `cron:${cron.id}:${op}`; setBusy(key); setError(""); setNotice("");
    try {
      const response = await fetch("/api/hermes/crons", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey() }, body: JSON.stringify({ op, id: cron.id, name: cron.name }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setNotice(`${data.duplicate ? "Ya existe" : "Creada"} la solicitud ${data.request.id}; está en ${data.request.status} y requiere aprobación individual.`);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear la solicitud"); }
    finally { setBusy(""); }
  };
  const loadLogs = async (timer: Timer) => {
    if (logsFor === timer.unit) { setLogsFor(""); setLogs([]); return; }
    setLogsFor(timer.unit); setLogs([]);
    try { const response = await fetch(`/api/automations?logsFor=${encodeURIComponent(timer.unit)}`, { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "No se pudo consultar el journal"); setLogs(data.logs || []); }
    catch (e) { setLogs([e instanceof Error ? e.message : "No se pudo consultar el journal"]); }
  };

  return <main className="w-full max-w-7xl mx-auto pb-16 space-y-6 text-[var(--text)]">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><div className="eyebrow">Hermy HQ · trabajos programados</div><h1 className="mt-2 text-3xl font-semibold">Automation Center</h1><p className="mt-2 text-sm text-[var(--text-3)]">Timers systemd y Hermes Cron existentes. Los controles crean solicitudes aprobables; no lanzan tareas directamente desde la página.</p></div><button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-xs"><RefreshCw size={14}/> Actualizar</button></header>
    {notice && <div className="panel p-3 text-sm text-[var(--up)]">{notice} <Link href="/action-center" className="underline">Abrir aprobaciones</Link></div>}
    {error && <div role="alert" className="panel p-3 text-sm text-[var(--down)]">{error}</div>}
    <section className="space-y-3"><div><h2 className="text-xl font-semibold">Timers systemd</h2><p className="mt-1 text-xs text-[var(--text-3)]">El inventario es de solo lectura. Los timers fuera de la allowlist solo se pueden consultar.</p></div>
      {loading && <div className="panel p-4 text-sm text-[var(--text-3)]">Consultando systemd…</div>}
      {timers.map((timer) => <article key={timer.unit} className="panel p-4 sm:p-5"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{timer.label}</h3><span className={`rounded-full border px-2 py-0.5 text-[10px] ${timer.managed ? "border-[var(--up)] text-[var(--up)]" : "border-[var(--line)] text-[var(--text-3)]"}`}>{timer.managed ? "control aprobado disponible" : "solo lectura"}</span></div><div className="num mt-1 text-[11px] text-[var(--text-3)]">{timer.unit} · {timer.service || "servicio no identificado"}</div>{timer.objective && <p className="mt-2 text-sm text-[var(--text-2)]">{timer.objective}</p>}</div><span className="text-xs text-[var(--text-2)]">{timer.activeState}/{timer.unitFileState}</span></div>
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"><div><span className="eyebrow">Programación</span><div className="mt-1">{timer.schedule || "No disponible"}</div></div><div><span className="eyebrow">Próxima</span><div className="mt-1">{formatDate(timer.nextRun)}</div></div><div><span className="eyebrow">Última</span><div className="mt-1">{formatDate(timer.lastRun)}</div></div><div><span className="eyebrow">Resultado / duración</span><div className="mt-1">{timer.lastResult || "Sin resultado"} · {formatDuration(timer.durationMs)}</div></div></div>
        {timer.managed && <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy === `${timer.unit}:enable` || timer.unitFileState.startsWith("enabled")} onClick={() => void requestSystemd(timer, "enable")} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs disabled:opacity-40">Habilitar</button><button disabled={busy === `${timer.unit}:disable` || !timer.unitFileState.startsWith("enabled")} onClick={() => void requestSystemd(timer, "disable")} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs disabled:opacity-40">Deshabilitar</button><button disabled={busy === `${timer.unit}:run`} onClick={() => void requestSystemd(timer, "run")} className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)] px-3 py-1.5 text-xs text-[var(--accent)] disabled:opacity-40"><Play size={12}/> Ejecutar ahora</button><button onClick={() => void loadLogs(timer)} className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-3 py-1.5 text-xs"><FileText size={12}/> {logsFor === timer.unit ? "Ocultar logs" : "Logs relevantes"}</button></div>}
        {logsFor === timer.unit && <div className="mt-3 rounded-lg bg-[var(--surface-2)] p-3"><div className="eyebrow mb-2">Journal filtrado y redactado</div>{logs.length ? logs.map((line, i) => <pre key={`${i}-${line.slice(0, 20)}`} className="whitespace-pre-wrap break-words py-1 text-[11px] text-[var(--text-2)]">{line}</pre>) : <p className="text-xs text-[var(--text-3)]">Sin líneas relevantes recientes.</p>}</div>}
        {timer.managed && <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--text-3)]"><ShieldCheck size={12}/> Cada control requiere aprobación ligada a unidad y operación. <Link href="/action-center" className="ml-1 underline">Revisar</Link></div>}
      </article>)}
      {!loading && timers.length === 0 && <div className="panel p-5 text-sm text-[var(--text-3)]">No se recibió inventario de timers.</div>}
    </section>

    <section className="panel p-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h2 className="font-semibold">Home Assistant</h2><p className="mt-1 text-xs text-[var(--text-3)]">{homeAssistant?.summary || "Consultando el estado existente…"}</p></div><span className="text-xs">{homeAssistant ? homeAssistant.reachable ? "VPS conectado" : "No disponible" : "Sin dato"}</span></div><p className="mt-2 text-[11px] text-[var(--text-3)]">La API actual solo expone alcance HTTP; no enumera automatizaciones, próximas ejecuciones ni permite operarlas. Se mantiene en lectura hasta que exista una interfaz autorizada y verificable.</p></section>

    <section className="space-y-3"><div><h2 className="text-xl font-semibold">Hermes Cron</h2><p className="mt-1 text-xs text-[var(--text-3)]">Usa el scheduler existente de Hermes. No se crean timers paralelos.</p></div>
      {crons.map((cron) => <article key={cron.id} className="panel p-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><div className="font-semibold">{cron.name || cron.id}</div><div className="num mt-1 text-[11px] text-[var(--text-3)]">{cron.id} · {cron.status} · {cron.schedule || "sin programación"}</div></div><div className="flex gap-2">{cron.status === "active" ? <button disabled={busy === `cron:${cron.id}:pause`} onClick={() => void requestCron(cron, "pause")} className="inline-flex items-center gap-1 rounded border border-[var(--line)] px-2.5 py-1.5 text-xs"><Pause size={12}/> Pausar</button> : <button disabled={busy === `cron:${cron.id}:resume`} onClick={() => void requestCron(cron, "resume")} className="rounded border border-[var(--line)] px-2.5 py-1.5 text-xs">Reanudar</button>}<button disabled={busy === `cron:${cron.id}:run`} onClick={() => void requestCron(cron, "run")} className="inline-flex items-center gap-1 rounded border border-[var(--accent)] px-2.5 py-1.5 text-xs text-[var(--accent)]"><Play size={12}/> Ejecutar ahora</button></div></div><div className="mt-3 grid gap-2 text-xs sm:grid-cols-3"><div><span className="eyebrow">Próxima</span><div className="mt-1">{formatDate(cron.nextRun)}</div></div><div><span className="eyebrow">Última</span><div className="mt-1">{formatDate(cron.lastRun)}</div></div><div><span className="eyebrow">Resultado</span><div className="mt-1">{cron.lastResult || "Sin resultado"}</div></div></div><div className="mt-2 text-[10px] text-[var(--text-3)]"><CalendarClock size={12} className="mr-1 inline"/>Duración: no medida por el mirror actual. Acciones requieren aprobación.</div></article>)}
      {!loading && crons.length === 0 && <div className="panel p-5 text-sm text-[var(--text-3)]">No hay Hermes Cron sincronizado.</div>}
    </section>
  </main>;
}
