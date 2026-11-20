"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, Bot, CircleHelp, Clock3, Cpu, Home, RefreshCw, ShieldAlert, Workflow, type LucideIcon } from "lucide-react";

type OperationalStatus = "online" | "offline" | "stale" | "unknown" | "sleeping" | "service-unavailable" | "authentication-error";
type EventRow = { id: string; title: string | null; agent: string | null; level: string; kind: string; createdAt: string };
type ActiveRequest = { id: string; agent: string; title: string | null; status: string; createdAt: string; startedAt: string | null; updatedAt: string };
type CommandData = {
  generatedAt: string;
  homeAssistant: { reachable: boolean; summary: string; checkedAt: string };
  operational: {
    hermes: { status: OperationalStatus; gateway: string; lastSeen: string | null; freshness: string };
    infrastructure: {
      collectedAt: string | null; freshness: string; failingServices: number | null;
      services: { unit: string; state: string }[];
      qwen: { status: string; freshness: string; checkedAt: string | null; latencyMs: number | null; modelIds: string[] };
    };
  };
  counts: { activeRequests: number; runningRequests: number; failedTasks: number; interventionTasks: number; pendingApprovals: number; openIncidents: number; alerts24h: number };
  activeRequests: ActiveRequest[];
  recentEvents: EventRow[];
};
type TimerRow = { unit: string; label: string; lastRun: string | null; lastResult: string | null; lastExitStatus: string | null; durationMs: number | null };
type AutomationData = { generatedAt: string; timers: TimerRow[] };

function dateTime(value?: string | null) {
  if (!value) return "Sin lectura";
  return formatEcuadorTimestamp(value, { invalid: "Fecha no disponible" });
}

function statusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    online: "Operativo", offline: "Sin conexión", stale: "Sin datos recientes", unknown: "Sin verificar",
    sleeping: "Dormido", "service-unavailable": "Servicio no disponible", "authentication-error": "Error de autenticación",
    queued: "En cola", approved: "Autorizada", awaiting_approval: "Pendiente de aprobación", incident_open: "Incidente abierto", needs_intervention: "Requiere intervención", alerts_review: "Revisar alertas", running: "En ejecución",
    done: "Finalizada", failed: "Fallida", active: "Activa", inactive: "Inactiva", success: "Correcto",
  };
  return labels[status || "unknown"] || status || "Sin verificar";
}

function tone(status: string) {
  if (["online", "done", "success", "active"].includes(status)) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (["offline", "failed", "service-unavailable", "authentication-error", "incident_open"].includes(status)) return "border-red-500/30 bg-red-500/10 text-red-200";
  if (["awaiting_approval", "queued", "approved", "stale", "sleeping", "needs_intervention", "alerts_review"].includes(status)) return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  return "border-[var(--line)] bg-[var(--surface-1)] text-[var(--text-2)]";
}

function MetricCard({ href, label, value, detail, status, icon: Icon }: {
  href: string; label: string; value: string | number; detail: string; status?: string; icon: LucideIcon;
}) {
  return <Link href={href} className="panel group relative flex min-h-36 flex-col justify-between p-4 transition-colors hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <span className="eyebrow">{label}</span>
      <Icon aria-hidden="true" className="h-4 w-4 text-[var(--text-3)] group-hover:text-[var(--accent)]" />
    </div>
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-xl font-semibold tracking-tight sm:text-2xl">{value}</strong>
        {status && <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone(status)}`}>{statusLabel(status)}</span>}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-3)]">{detail}</p>
    </div>
    <ArrowUpRight aria-hidden="true" className="absolute right-4 top-4 h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-70" />
  </Link>;
}

function operationalHomeValue(reachable: boolean) { return reachable ? "Disponible" : "Sin conexión"; }

function CardGrid({ data }: { data: CommandData }) {
  const { operational, counts } = data;
  const serviceFresh = operational.infrastructure.freshness === "fresh";
  const serviceStatus = !serviceFresh ? "stale" : operational.infrastructure.failingServices === null ? "unknown" : operational.infrastructure.failingServices === 0 ? "online" : "service-unavailable";
  const serviceValue = serviceStatus === "online"
    ? "Todo activo"
    : serviceStatus === "service-unavailable"
      ? `${operational.infrastructure.failingServices} fuera de servicio`
      : serviceStatus === "unknown" ? "Sin lectura de servicios" : "Sin datos recientes";
  const qwen = operational.infrastructure.qwen;
  const qwenModel = qwen.modelIds.length ? qwen.modelIds.join(", ") : "Modelo no informado";
  const qwenDetail = qwen.freshness === "fresh"
    ? `${qwenModel}${qwen.latencyMs == null ? "" : ` · HTTP ${qwen.latencyMs} ms`} · lectura ${dateTime(qwen.checkedAt)}`
    : `Último dato: ${dateTime(qwen.checkedAt)} · abrir para ver historial`;

  return <section aria-label="Estado operativo" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <MetricCard href="/hermes" label="Hermes" value={statusLabel(operational.hermes.status)} detail={`Heartbeat: ${dateTime(operational.hermes.lastSeen)} · ${operational.hermes.gateway}`} status={operational.hermes.status} icon={Activity} />
    <MetricCard href="/infrastructure#nodes" label="Servicios VPS" value={serviceValue} detail={`Lectura de infraestructura: ${dateTime(operational.infrastructure.collectedAt)}`} status={serviceStatus} icon={AlertTriangle} />
    <MetricCard href="/action-center" label="Incidencias abiertas" value={counts.openIncidents} detail={`${counts.pendingApprovals} aprobaciones pendientes · ${counts.interventionTasks} solicitudes esperan aprobación o confirmación`} status={counts.pendingApprovals ? "awaiting_approval" : counts.openIncidents ? "incident_open" : counts.interventionTasks ? "needs_intervention" : "online"} icon={ShieldAlert} />
    <MetricCard href="/tasks" label="Solicitudes activas" value={counts.activeRequests} detail={`${counts.runningRequests} en ejecución · ${Math.max(0, counts.activeRequests - counts.runningRequests)} esperando o aprobadas`} icon={Workflow} />
    <MetricCard href="/agents" label="Agentes trabajando" value={counts.runningRequests} detail="Ejecuciones registradas como running en la cola existente" icon={Bot} />
    <MetricCard href="/automations" label="Home Assistant" value={operationalHomeValue(data.homeAssistant.reachable)} detail={`${data.homeAssistant.summary} · comprobado ${dateTime(data.homeAssistant.checkedAt)}`} status={data.homeAssistant.reachable ? "online" : "offline"} icon={Home} />
    <MetricCard href="/tasks" label="Tareas fallidas" value={counts.failedTasks} detail="Solicitudes fallidas en los últimos 30 días; revisar evidencia antes de reintentar" status={counts.failedTasks ? "failed" : "online"} icon={CircleHelp} />
    <MetricCard href="/infrastructure#nodes" label="Qwen · Dell G15" value={statusLabel(qwen.status)} detail={qwenDetail} status={qwen.status} icon={Cpu} />
    <MetricCard href="/security-center" label="Alertas recientes" value={counts.alerts24h} detail="Eventos con nivel down o tipo alert de las últimas 24 horas" status={counts.alerts24h ? "alerts_review" : "online"} icon={ShieldAlert} />
  </section>;
}

export default function CommandCenterPage() {
  const [data, setData] = useState<CommandData | null>(null);
  const [automations, setAutomations] = useState<AutomationData | null>(null);
  const [error, setError] = useState("");
  const [automationError, setAutomationError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const automationInFlight = useRef(false);

  const loadSummary = useCallback(async (manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/command-center", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `No se pudo consultar Hermy HQ (HTTP ${response.status})`);
      if (!payload || typeof payload !== "object" || !payload.operational || !payload.counts) throw new Error("Hermy HQ devolvió una respuesta incompleta");
      setData(payload as CommandData);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el resumen operativo");
    } finally {
      setLoading(false);
      setRefreshing(false);
      inFlight.current = false;
    }
  }, []);

  const loadAutomations = useCallback(async () => {
    if (automationInFlight.current) return;
    automationInFlight.current = true;
    try {
      const response = await fetch("/api/automations", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `No se pudo consultar Automation Center (HTTP ${response.status})`);
      if (!payload || !Array.isArray(payload.timers)) throw new Error("Automation Center devolvió un inventario incompleto");
      setAutomations(payload as AutomationData);
      setAutomationError("");
    } catch (cause) {
      setAutomationError(cause instanceof Error ? cause.message : "No se pudo consultar el resultado de las automatizaciones");
    } finally {
      automationInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadAutomations();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSummary();
    }, 90_000);
    return () => window.clearInterval(timer);
  }, [loadSummary, loadAutomations]);

  const refresh = () => { void loadSummary(true); void loadAutomations(); };
  const latestTimer = automations?.timers
    .filter((timer) => timer.lastRun && !Number.isNaN(Date.parse(timer.lastRun)))
    .sort((a, b) => Date.parse(b.lastRun || "") - Date.parse(a.lastRun || ""))[0];

  return <div className="mx-auto w-full max-w-[1440px] space-y-6 pb-6 text-[var(--text)] sm:space-y-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="eyebrow">Hermy HQ · operaciones</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Centro de mando</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--text-3)]">Estado observado de Hermes, agentes, cola, infraestructura y automatizaciones. Cada lectura incluye su fuente y vigencia.</p>
      </div>
      <div className="flex items-center gap-3">
        {data && <span className="text-right text-[10px] text-[var(--text-3)]">Actualizado<br />{dateTime(data.generatedAt)}</span>}
        <button type="button" onClick={refresh} disabled={refreshing || loading} aria-busy={refreshing} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-xs text-[var(--text-2)] hover:bg-[var(--surface-1)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />Actualizar
        </button>
      </div>
    </header>

    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-950/20 p-4 text-sm text-red-200">
      <span>{error}</span><button type="button" onClick={() => void loadSummary(true)} className="rounded-md border border-red-400/30 px-3 py-1.5 text-xs hover:bg-red-500/10">Reintentar</button>
    </div>}
    {automationError && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-100">No se pudo leer el último resultado de systemd. <Link href="/automations" className="underline">Abrir Automation Center</Link></div>}

    {loading && !data && <div aria-live="polite" className="panel p-6 text-sm text-[var(--text-3)]">Consultando lecturas operativas…</div>}
    {data && <>
      <CardGrid data={data} />

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <section aria-labelledby="running-heading" className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 id="running-heading" className="text-lg font-semibold">Actividad en curso</h2><p className="mt-1 text-xs text-[var(--text-3)]">Solicitudes reales de AgentRequest; no crea una cola paralela.</p></div>
            <Link href="/tasks" className="text-xs text-[var(--accent)] hover:underline">Ver tareas</Link>
          </div>
          {data.activeRequests.length ? <ul className="mt-4 divide-y divide-[var(--line)]">
            {data.activeRequests.map((request) => <li key={request.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className={`rounded-full border px-2 py-1 text-[10px] ${tone(request.status)}`}>{statusLabel(request.status)}</span>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{request.title || "Solicitud sin título"}</p><p className="mt-1 text-[11px] text-[var(--text-3)]">{request.agent.toUpperCase()} · {request.id}</p></div>
              <span className="text-[10px] text-[var(--text-3)]">{dateTime(request.updatedAt)}</span>
            </li>)}
          </ul> : <p className="mt-4 rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-[var(--text-3)]">No hay solicitudes activas en la cola.</p>}
        </section>

        <section aria-labelledby="automation-heading" className="panel p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3"><div><h2 id="automation-heading" className="text-lg font-semibold">Última automatización</h2><p className="mt-1 text-xs text-[var(--text-3)]">Último timer con una ejecución registrada</p></div><Workflow aria-hidden="true" className="h-4 w-4 text-[var(--text-3)]" /></div>
          {latestTimer ? <div className="mt-4 rounded-lg border border-[var(--line)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{latestTimer.label}</p><p className="mt-1 text-[11px] text-[var(--text-3)]">{latestTimer.unit} · {dateTime(latestTimer.lastRun)}</p></div><span className={`rounded-full border px-2 py-1 text-[10px] ${tone(latestTimer.lastResult || "unknown")}`}>{statusLabel(latestTimer.lastResult)}</span></div>
            <p className="mt-3 text-xs text-[var(--text-2)]">Código de salida: {latestTimer.lastExitStatus ?? "Sin dato"} · Duración: {latestTimer.durationMs == null ? "Sin dato" : `${latestTimer.durationMs} ms`}</p>
          </div> : <p className="mt-4 rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-[var(--text-3)]">{automations ? "No hay ejecución previa informada por systemd." : "Consultando el inventario existente…"}</p>}
          <Link href="/automations" className="mt-4 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">Investigar automatizaciones <ArrowUpRight aria-hidden="true" className="h-3 w-3" /></Link>
        </section>
      </div>

      <section aria-labelledby="events-heading" className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="events-heading" className="text-lg font-semibold">Errores y alertas recientes</h2><p className="mt-1 text-xs text-[var(--text-3)]">Eventos con nivel down o tipo alert en las últimas 24 horas · {data.recentEvents.length} más recientes de {data.counts.alerts24h}</p></div><Link href="/security-center" className="text-xs text-[var(--accent)] hover:underline">Centro de seguridad</Link></div>
        {data.recentEvents.length ? <ul className="mt-4 grid gap-2 lg:grid-cols-2">
          {data.recentEvents.map((event) => <li key={event.id} className="rounded-lg border border-[var(--line)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 flex-1 text-sm">{event.title || "Evento sin título"}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone(event.level === "down" ? "failed" : event.level)}`}>{event.level}</span></div>
            <p className="mt-2 text-[10px] text-[var(--text-3)]">{(event.agent || "Sistema").toUpperCase()} · {event.kind} · {dateTime(event.createdAt)}</p>
          </li>)}
        </ul> : <p className="mt-4 text-sm text-[var(--text-3)]">No hay eventos de alerta en esta ventana.</p>}
      </section>
      <p className="flex items-start gap-2 text-[10px] leading-relaxed text-[var(--text-4)]"><Clock3 aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />La vigencia se calcula con el último heartbeat o ciclo de recolección guardado. Qwen muestra disponibilidad del endpoint y no rendimiento de generación.</p>
    </>}
  </div>;
}
