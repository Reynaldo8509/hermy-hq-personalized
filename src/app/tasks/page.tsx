"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Pill, rise } from "@/components/ui/kit";

interface Task {
  id: string;
  title: string;
  kind: string;
  origin: string;
  status: string;
  sideEffecting: boolean;
  prompt: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const columns = [
  { id: "todo", label: "To Do", statuses: ["queued"] },
  { id: "approved", label: "Approved", statuses: ["awaiting_approval", "awaiting_destructive_confirmation", "approved"] },
  { id: "progress", label: "In Progress", statuses: ["running"] },
  { id: "done", label: "Done", statuses: ["done", "failed", "rejected", "cancelled"] },
];
const statusLabel: Record<string, string> = {
  queued: "En cola", awaiting_approval: "Requiere aprobación", awaiting_destructive_confirmation: "Confirmación destructiva requerida",
  approved: "Aprobada", running: "En curso", done: "Completada", failed: "Fallida", rejected: "Rechazada", cancelled: "Cancelada",
};
const statusTone: Record<string, "warn" | "neutral"> = { failed: "warn", awaiting_approval: "warn", awaiting_destructive_confirmation: "warn", rejected: "neutral", cancelled: "neutral" };

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [showAddTask, setShowAddTask] = useState(false);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState("");

  const fetchTasks = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo cargar Tasks");
      setTasks(Array.isArray(data.requests) ? data.requests : []);
      setSyncedAt(data.syncedAt || new Date().toISOString());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar las solicitudes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTasks();
    const timer = window.setInterval(() => void fetchTasks(true), 10000);
    return () => window.clearInterval(timer);
  }, [fetchTasks]);

  async function addTask() {
    if (!newTitle.trim() || !newPrompt.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTitle, prompt: newPrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo crear la solicitud");
      setNewTitle(""); setNewPrompt(""); setShowAddTask(false);
      await fetchTasks(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la solicitud");
    } finally { setSaving(false); }
  }

  async function decideTask(task: Task, action: "approve" | "reject") {
    try {
      const res = await fetch(`/api/hermes/requests/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo actualizar la solicitud");
      await fetchTasks(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar la solicitud");
    }
  }

  return (
    <div className="relative z-10 min-h-full flex flex-col w-full mx-auto pt-4 pb-16">
      <div className="hq-rise flex flex-wrap justify-between items-end gap-4 mb-6" style={rise(0)}>
        <div>
          <div className="eyebrow mb-2">Synced with Hermy HQ · cola real de solicitudes</div>
          <h1 className="text-[32px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Tasks</h1>
          <p className="text-[12px] text-[var(--text-3)] mt-2">Las tareas nuevas se envían a Max para coordinación y se actualizan automáticamente.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void fetchTasks()}>Actualizar</Button>
          <Button variant="primary" onClick={() => setShowAddTask((visible) => !visible)}>+ Add Task</Button>
        </div>
      </div>

      <div className="flex justify-between text-[11px] text-[var(--text-3)] mb-4">
        <span>{tasks.length} solicitudes recientes · actualización cada 10 s</span>
        <span>Última actualización: {formatDate(syncedAt)}</span>
      </div>

      {error && <div role="alert" className="mb-4 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3 text-[13px] text-[var(--text)]">{error}</div>}

      {showAddTask && <form className="hq-rise elevated mb-6 p-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void addTask(); }}>
        <label className="block text-[12px] text-[var(--text-2)]">Título
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Ej.: Revisar fallo de integración" maxLength={200} required className="mt-1 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-3 text-[14px] focus:outline-none focus:border-[var(--line-strong)]" />
        </label>
        <label className="block text-[12px] text-[var(--text-2)]">Instrucciones para Max
          <textarea value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder="Describe qué necesitas y cualquier límite importante…" maxLength={12000} required rows={4} className="mt-1 w-full bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-3 text-[14px] focus:outline-none focus:border-[var(--line-strong)]" />
        </label>
        <div className="flex gap-2"><Button type="submit" variant="primary" disabled={saving || !newTitle.trim() || !newPrompt.trim()}>{saving ? "Creando…" : "Enviar a Max"}</Button><Button onClick={() => setShowAddTask(false)}>Cancelar</Button></div>
      </form>}

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {columns.map((column, idx) => {
          const group = tasks.filter((task) => column.statuses.includes(task.status));
          return <section key={column.id} className="hq-rise panel flex flex-col min-h-64 overflow-hidden" style={rise(idx + 1)}>
            <div className="px-4 py-3.5 flex items-center justify-between"><span className="eyebrow">{column.label}</span><span className="num text-[11px] text-[var(--text-3)]">{group.length}</span></div>
            <div className="rule" />
            <div className="flex-1 p-2.5 space-y-2 overflow-y-auto">
              {group.map((task) => <article key={task.id} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3.5">
                <div className="flex justify-between items-start gap-2"><p className="font-medium text-[13px] leading-relaxed text-[var(--text)]">{task.title}</p><Pill tone={statusTone[task.status] || "neutral"}>{statusLabel[task.status] || task.status}</Pill></div>
                <div className="mt-2 flex gap-2 flex-wrap text-[10px] text-[var(--text-3)]"><span>{task.kind}</span><span>·</span><span>origen: {task.origin}</span>{task.sideEffecting && <Pill tone="warn">requiere aprobación</Pill>}</div>
                <details className="mt-3 text-[11px] text-[var(--text-2)]"><summary className="cursor-pointer">Ver instrucciones, actividad y resultado</summary>
                  <dl className="mt-2 space-y-1"><div><dt className="inline font-medium">Creada: </dt><dd className="inline">{formatDate(task.createdAt)}</dd></div>{task.startedAt && <div><dt className="inline font-medium">Iniciada: </dt><dd className="inline">{formatDate(task.startedAt)}</dd></div>}{task.finishedAt && <div><dt className="inline font-medium">Finalizada: </dt><dd className="inline">{formatDate(task.finishedAt)}</dd></div>}</dl>
                  {task.prompt && <div className="mt-2"><strong>Solicitud</strong><p className="whitespace-pre-wrap break-words mt-1">{task.prompt}</p></div>}
                  {task.result && <div className="mt-2"><strong>Resultado</strong><p className="whitespace-pre-wrap break-words mt-1">{task.result}</p></div>}
                  {task.error && <div className="mt-2 text-[var(--down)]"><strong>Error</strong><p className="whitespace-pre-wrap break-words mt-1">{task.error}</p></div>}
                </details>
                {(task.status === "queued" || task.status === "awaiting_approval" || task.status === "awaiting_destructive_confirmation") && <div className="mt-3 pt-3 border-t border-[var(--line)] flex gap-2">
                  {task.status === "awaiting_approval" && <Button size="sm" variant="primary" onClick={() => void decideTask(task, "approve")}>Aprobar</Button>}
                  <Button size="sm" onClick={() => void decideTask(task, "reject")}>{task.status === "queued" ? "Cancelar solicitud" : "Rechazar"}</Button>
                </div>}
              </article>)}
              {!group.length && <p className="text-[var(--text-4)] text-[12.5px] text-center py-8">{loading ? "Cargando…" : "Sin solicitudes"}</p>}
            </div>
          </section>;
        })}
      </div>
    </div>
  );
}
