"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Pill, rise } from "@/components/ui/kit";

interface Dependency { id: string; title?: string; status: string; error?: string | null }
interface Activity { id: string; title: string; detail?: string | null; agent?: string | null; createdAt: string }
interface Task {
  id: string; title: string; kind: string; origin: string; agentId: string; status: string;
  sideEffecting: boolean; prompt: string | null; result: string | null; error: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null; blockedByDependencies: boolean; dependencies: Dependency[]; activity: Activity[];
}

const agents = [
  { id: "max", name: "MAX", instructions: "Coordina y delega usando Hermes; indica el resultado verificable." },
  { id: "codex", name: "CODEX mediante MAX", instructions: "La solicitud se registra para MAX, que decide si crea una delegación CODEX válida." },
  { id: "atlas", name: "ATLAS", instructions: "Investigación técnica con fuentes, hallazgos y límites." },
  { id: "aegis", name: "AEGIS", instructions: "Trabajo de seguridad defensiva; siempre requiere aprobación antes de ejecución." },
  { id: "ledger", name: "LEDGER", instructions: "Operaciones, continuidad, salud y respaldos; requiere aprobación." },
  { id: "milo", name: "MILO", instructions: "Tareas de correo y alertas; requiere aprobación." },
  { id: "pulse", name: "PULSE", instructions: "Contenido, redes y video; requiere aprobación." },
  { id: "domus", name: "DOMUS", instructions: "Automatización del hogar; requiere aprobación." },
];
const mandatoryApproval = new Set(["aegis", "ledger", "milo", "pulse", "domus"]);
const columns = [
  { id: "todo", label: "En cola", statuses: ["queued"] },
  { id: "approved", label: "Aprobaciones", statuses: ["awaiting_approval", "awaiting_destructive_confirmation", "approved"] },
  { id: "progress", label: "En curso", statuses: ["running"] },
  { id: "done", label: "Resultados", statuses: ["done", "failed", "rejected", "cancelled"] },
];
const statusLabel: Record<string, string> = {
  queued: "En cola", awaiting_approval: "Requiere aprobación", awaiting_destructive_confirmation: "Confirmación destructiva requerida",
  approved: "Aprobada", running: "En curso", done: "Completada", failed: "Fallida", rejected: "Rechazada", cancelled: "Cancelada",
};
const statusTone: Record<string, "warn" | "neutral"> = { failed: "warn", awaiting_approval: "warn", awaiting_destructive_confirmation: "warn", rejected: "neutral", cancelled: "neutral" };

function formatDate(value: string | null) {
  if (!value) return "—";
  return formatEcuadorTimestamp(value, { invalid: "—" });
}
function requestKey() {
  return globalThis.crypto?.randomUUID?.() || "task-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [historyMode, setHistoryMode] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [totalRequests, setTotalRequests] = useState(0);
  const [pageSize, setPageSize] = useState(250);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyTask, setBusyTask] = useState("");
  const [newAgent, setNewAgent] = useState("max");
  const [newTitle, setNewTitle] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [showAddTask, setShowAddTask] = useState(false);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState("");
  const idempotencyKeyRef = useRef("");

  const fetchTasks = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const query = new URLSearchParams({ limit: String(historyMode ? 50 : 250) });
      if (historyMode) {
        query.set("status", "failed");
        query.set("offset", String(historyOffset));
      }
      const res = await fetch(`/api/tasks?${query.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo cargar Tasks");
      setTasks(Array.isArray(data.requests) ? data.requests : []);
      setTotalRequests(Number(data.pagination?.total) || 0);
      setPageSize(Number(data.pagination?.limit) || (historyMode ? 50 : 250));
      setSyncedAt(data.syncedAt || new Date().toISOString());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar las solicitudes");
    } finally { setLoading(false); }
  }, [historyMode, historyOffset]);

  useEffect(() => {
    const requestedAgent = new URLSearchParams(window.location.search).get("agent");
    if (requestedAgent && agents.some((agent) => agent.id === requestedAgent)) {
      setNewAgent(requestedAgent);
      setShowAddTask(true);
      setRequiresApproval(mandatoryApproval.has(requestedAgent));
    }
    void fetchTasks();
    const timer = window.setInterval(() => void fetchTasks(true), 10000);
    return () => window.clearInterval(timer);
  }, [fetchTasks]);

  function chooseAgent(agentId: string) {
    setNewAgent(agentId);
    setRequiresApproval(mandatoryApproval.has(agentId));
  }

  async function addTask() {
    if (!newTitle.trim() || !newPrompt.trim() || saving) return;
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = requestKey();
    setSaving(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKeyRef.current },
        body: JSON.stringify({ agentId: newAgent, name: newTitle, prompt: newPrompt, requiresApproval, dependsOn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo crear la solicitud");
      idempotencyKeyRef.current = "";
      setNewTitle(""); setNewPrompt(""); setDependsOn([]); setShowAddTask(false);
      await fetchTasks(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la solicitud");
    } finally { setSaving(false); }
  }

  async function mutateTask(task: Task, action: "cancel" | "retry" | "assign", agentId?: string) {
    setBusyTask(task.id); setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, action, agentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo actualizar la tarea");
      await fetchTasks(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar la tarea");
    } finally { setBusyTask(""); }
  }

  async function decideTask(task: Task, action: "approve" | "reject") {
    setBusyTask(task.id); setError("");
    try {
      const res = await fetch("/api/hermes/requests/" + encodeURIComponent(task.id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo actualizar la aprobación");
      await fetchTasks(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar la aprobación");
    } finally { setBusyTask(""); }
  }

  return (
    <div className="relative z-10 min-h-full flex flex-col w-full mx-auto pt-4 pb-16">
      <div className="hq-rise flex flex-wrap justify-between items-end gap-4 mb-6" style={rise(0)}>
        <div><div className="eyebrow mb-2">Cola única AgentRequest · persistida en Hermy HQ</div><h1 className="text-[32px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Tasks</h1><p className="text-[12px] text-[var(--text-3)] mt-2">Asignación, dependencias, errores, aprobaciones y resultados del mismo worker queue.</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant={historyMode ? "ghost" : "primary"} onClick={() => { setHistoryMode(false); setHistoryOffset(0); }}>Cola reciente</Button>
          <Button variant={historyMode ? "primary" : "ghost"} onClick={() => { setHistoryMode(true); setHistoryOffset(0); }}>Historial de fallidas</Button>
          <Button variant="ghost" onClick={() => void fetchTasks()}>Actualizar</Button>
          <Button variant="primary" onClick={() => setShowAddTask((visible) => !visible)}>+ Crear tarea</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-3)] mb-4">
        <span>{historyMode ? (totalRequests ? `Fallidas ${historyOffset + 1}–${Math.min(historyOffset + tasks.length, totalRequests)} de ${totalRequests}` : "No hay solicitudes fallidas") : `Mostrando ${tasks.length} solicitudes recientes de ${totalRequests} · actualización cada 10 s`}</span>
        {historyMode && <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={loading || historyOffset === 0} onClick={() => setHistoryOffset((offset) => Math.max(0, offset - pageSize))}>Anterior</Button>
          <Button size="sm" variant="ghost" disabled={loading || historyOffset + tasks.length >= totalRequests} onClick={() => setHistoryOffset((offset) => offset + pageSize)}>Siguiente</Button>
        </div>}
        <span>Última actualización: {formatDate(syncedAt)}</span>
      </div>
      {error && <div role="alert" className="mb-4 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3 text-[13px] text-[var(--text)]">{error}</div>}

      {showAddTask && <form className="hq-rise elevated mb-6 p-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void addTask(); }}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block text-[12px] text-[var(--text-2)]">Agente de destino
            <select value={newAgent} onChange={(event) => chooseAgent(event.target.value)} className="mt-1 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-3 text-[14px]">
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <p className="self-end text-xs text-[var(--text-3)]">{agents.find((agent) => agent.id === newAgent)?.instructions}</p>
        </div>
        <label className="block text-[12px] text-[var(--text-2)]">Título
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Ej.: Revisar fallo de integración" maxLength={200} required className="mt-1 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-3 text-[14px]" />
        </label>
        <label className="block text-[12px] text-[var(--text-2)]">Instrucciones para {agents.find((agent) => agent.id === newAgent)?.name}
          <textarea value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder="Indica objetivo, evidencia esperada y límites de ejecución…" maxLength={12000} required rows={4} className="mt-1 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-3 text-[14px]" />
        </label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={requiresApproval} onChange={(event) => setRequiresApproval(event.target.checked)} disabled={mandatoryApproval.has(newAgent)} />Requiere aprobación antes de entrar en ejecución</label>
        {mandatoryApproval.has(newAgent) && <p className="text-xs text-amber-300">Este agente requiere aprobación individual siempre. CODEX se solicita mediante MAX.</p>}
        <label className="block text-[12px] text-[var(--text-2)]">Dependencias (la tarea espera a que todas estén en done)
          <select multiple value={dependsOn} onChange={(event) => setDependsOn(Array.from(event.target.selectedOptions).map((option) => option.value))} className="mt-1 h-28 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-3 py-2 text-[13px]">
            {tasks.filter((task) => !["failed", "cancelled", "rejected"].includes(task.status)).map((task) => <option key={task.id} value={task.id}>{task.status} · {task.title} · {task.id}</option>)}
          </select>
        </label>
        <div className="flex gap-2"><Button type="submit" variant="primary" disabled={saving || !newTitle.trim() || !newPrompt.trim()}>{saving ? "Creando…" : "Enviar a cola"}</Button><Button onClick={() => setShowAddTask(false)}>Cancelar</Button></div>
      </form>}

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {columns.map((column, idx) => {
          const group = tasks.filter((task) => column.statuses.includes(task.status));
          return <section key={column.id} className="hq-rise panel flex flex-col min-h-64 overflow-hidden" style={rise(idx + 1)}>
            <div className="px-4 py-3.5 flex items-center justify-between"><span className="eyebrow">{column.label}</span><span className="num text-[11px] text-[var(--text-3)]">{group.length}</span></div>
            <div className="rule" /><div className="flex-1 p-2.5 space-y-2 overflow-y-auto">
              {group.map((task) => <article key={task.id} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3.5">
                <div className="flex justify-between items-start gap-2"><p className="font-medium text-[13px] leading-relaxed text-[var(--text)]">{task.title}</p><Pill tone={statusTone[task.status] || (task.blockedByDependencies ? "warn" : "neutral")}>{task.blockedByDependencies ? "Bloqueada por dependencias" : statusLabel[task.status] || task.status}</Pill></div>
                <div className="mt-2 flex gap-2 flex-wrap text-[10px] text-[var(--text-3)]"><span>{task.kind}</span><span>·</span><span>agente: {task.agentId}</span><span>· origen: {task.origin}</span>{task.sideEffecting && <Pill tone="warn">aprobación individual</Pill>}</div>
                <details className="mt-3 text-[11px] text-[var(--text-2)]"><summary className="cursor-pointer">Ver instrucciones, historial, errores y resultado</summary>
                  <dl className="mt-2 space-y-1"><div><dt className="inline font-medium">ID: </dt><dd className="inline">{task.id}</dd></div><div><dt className="inline font-medium">Creada: </dt><dd className="inline">{formatDate(task.createdAt)}</dd></div>{task.startedAt && <div><dt className="inline font-medium">Iniciada: </dt><dd className="inline">{formatDate(task.startedAt)}</dd></div>}{task.finishedAt && <div><dt className="inline font-medium">Finalizada/duración: </dt><dd className="inline">{formatDate(task.finishedAt)} / {task.durationMs ?? "—"} ms</dd></div>}</dl>
                  {task.dependencies.length > 0 && <div className="mt-2"><strong>Dependencias</strong>{task.dependencies.map((dependency) => <p key={dependency.id}>{dependency.status} · {dependency.title || dependency.id}</p>)}</div>}
                  {task.prompt && <div className="mt-2"><strong>Solicitud</strong><p className="whitespace-pre-wrap break-words mt-1">{task.prompt}</p></div>}
                  {task.result && <div className="mt-2"><strong>Resultado / artefactos</strong><p className="whitespace-pre-wrap break-words mt-1">{task.result}</p></div>}
                  {task.error && <div className="mt-2 text-[var(--down)]"><strong>Error</strong><p className="whitespace-pre-wrap break-words mt-1">{task.error}</p></div>}
                  {task.activity.length > 0 && <div className="mt-3"><strong>Historial</strong>{task.activity.map((event) => <p key={event.id} className="mt-1 text-[var(--text-3)]">{formatDate(event.createdAt)} · {event.title} {event.detail || ""}</p>)}</div>}
                </details>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--line)] pt-3">
                  {task.status === "queued" && !task.sideEffecting && <label className="text-[10px] text-[var(--text-3)]">Asignar<select value={task.agentId} disabled={busyTask === task.id} onChange={(event) => void mutateTask(task, "assign", event.target.value)} className="ml-1 rounded bg-[var(--surface-2)] p-1 text-[10px]">{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
                  {task.status === "awaiting_approval" && <Button size="sm" variant="primary" disabled={busyTask === task.id} onClick={() => void decideTask(task, "approve")}>Aprobar</Button>}
                  {task.status === "awaiting_approval" && <Button size="sm" disabled={busyTask === task.id} onClick={() => void decideTask(task, "reject")}>Rechazar</Button>}
                  {["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation"].includes(task.status) && <Button size="sm" disabled={busyTask === task.id} onClick={() => void mutateTask(task, "cancel")}>Cancelar</Button>}
                  {task.status === "failed" && !task.sideEffecting && <Button size="sm" variant="primary" disabled={busyTask === task.id} onClick={() => void mutateTask(task, "retry")}>Reintentar</Button>}
                </div>
              </article>)}
              {!group.length && <p className="text-[var(--text-4)] text-[12.5px] text-center py-8">{loading ? "Cargando…" : "Sin solicitudes"}</p>}
            </div>
          </section>;
        })}
      </div>
    </div>
  );
}
