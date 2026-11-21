"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";

type Policy = {
  minimumPriority: "important" | "critical" | "paused";
  requireApprovalForSideEffects: true;
  maxRunsPerFiveHours: number;
  maxRunsPerSevenDays: number;
};
type Quota = {
  runsLastFiveHours: number;
  maxRunsPerFiveHours: number;
  runsLastSevenDays: number;
  maxRunsPerSevenDays: number;
  blocked: boolean;
  nextAllowedAt: string | null;
};
type PolicyResponse = {
  policy: Policy;
  updatedAt: string | null;
  waitingApproval: number;
  readyTasks?: number;
  quota?: Quota;
  circuit?: { open?: boolean; activeAgent?: string; reason?: string | null };
};
const localTime = (value?: string | null) => value ? formatEcuadorTimestamp(value) : "Sin cambios registrados";

export function CodexPolicyControl() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [minimumPriority, setMinimumPriority] = useState<Policy["minimumPriority"]>("important");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/codex/policy", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      setData(payload as PolicyResponse);
      setMinimumPriority((payload as PolicyResponse).policy.minimumPriority);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo leer el control de Codex"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/codex/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minimumPriority }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      await refresh();
      setNotice(minimumPriority === "paused" ? "Codex quedó pausado. Max seguirá atendiendo solicitudes con los demás agentes." : "Política de Codex guardada.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar la política"); }
    finally { setSaving(false); }
  }

  async function resumeCodex() {
    if (resuming || !window.confirm("Esto solo cerrará el circuito. No ejecutará Codex ni comprobará la conexión; la próxima tarea seguirá requiriendo aprobación y respetará los límites de cuota. ¿Continuar?")) return;
    setResuming(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/codex/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resumeCodex" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      await refresh();
      setNotice("Codex quedó habilitado para una próxima tarea elegible; no se ejecutó ninguna prueba.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo habilitar Codex"); }
    finally { setResuming(false); }
  }

  const quota = data?.quota;

  return <section aria-labelledby="codex-policy-heading" className="panel space-y-4 p-5 sm:p-6">
    <div className="flex items-start gap-3"><ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 text-[var(--accent)]"/><div className="min-w-0 flex-1"><div className="eyebrow">Control de cuota</div><h2 id="codex-policy-heading" className="mt-1 text-lg font-semibold">Asignaciones de Codex</h2><p className="mt-1 max-w-3xl text-sm text-[var(--text-3)]">Max solo puede preparar trabajos técnicos concretos con prioridad, objetivo y resultado esperado. No deriva consultas, operaciones rutinarias, investigación ni tareas vagas.</p></div><button type="button" onClick={() => void refresh()} disabled={loading || saving || resuming} aria-label="Actualizar control de cuota" className="rounded-lg border border-[var(--line)] p-2 text-[var(--text-3)] disabled:opacity-50"><RefreshCw aria-hidden="true" className="h-4 w-4"/></button></div>

    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm">
      <p className="font-medium">Tope automático: {data?.policy.maxRunsPerFiveHours ?? 1} ejecución cada 5 horas y {data?.policy.maxRunsPerSevenDays ?? 3} en 7 días.</p>
      <p className="mt-1 text-xs text-[var(--text-3)]">Cuenta cada inicio real del worker contra OpenAI. Las pruebas automáticas de recuperación están desactivadas; consultar la cola no ejecuta Codex.</p>
      <p className="mt-2 text-xs text-[var(--text-2)]">Uso registrado: {quota ? quota.runsLastFiveHours + "/" + quota.maxRunsPerFiveHours + " en 5 h · " + quota.runsLastSevenDays + "/" + quota.maxRunsPerSevenDays + " en 7 días" : "consultando…"}</p>
      {quota?.blocked && <p role="status" className="mt-2 text-xs text-amber-300">Límite alcanzado. Próxima ejecución posible: {localTime(quota.nextAllowedAt)}.</p>}
    </div>

    <form onSubmit={(event) => void save(event)} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
      <label className="grid gap-1.5 text-xs text-[var(--text-2)]">Prioridad mínima para permitir una asignación
        <select value={minimumPriority} onChange={(event) => setMinimumPriority(event.target.value as Policy["minimumPriority"])} disabled={loading || saving || resuming} className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)]">
          <option value="important">Importante o crítica · recomendado</option><option value="critical">Solo crítica</option><option value="paused">Pausado · no aceptar nuevas tareas</option>
        </select>
      </label>
      <button type="submit" disabled={loading || saving || resuming || minimumPriority === data?.policy.minimumPriority} className="btn-primary min-h-10 px-4 py-2 text-sm disabled:opacity-50">{saving ? "Guardando…" : "Guardar control"}</button>
    </form>

    {data?.circuit?.open && <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">Circuito Codex abierto; respaldo activo: {data.circuit.activeAgent || "Qwen"}.</p>
      <p className="mt-1 text-xs text-[var(--text-3)]">No se harán pruebas automáticas que consuman cuota. Puedes habilitar Codex sin ejecutarlo; la próxima tarea requerirá aprobación humana y respetará ambos topes.</p>
      {data.circuit.reason && <p className="mt-2 text-xs text-[var(--text-3)]">Motivo registrado: {data.circuit.reason}</p>}
      <button type="button" onClick={() => void resumeCodex()} disabled={loading || saving || resuming} className="mt-3 min-h-10 rounded-lg border border-amber-500/50 px-4 py-2 text-sm disabled:opacity-50">{resuming ? "Habilitando…" : "Habilitar para la próxima tarea aprobada"}</button>
    </div>}

    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] pt-3 text-xs text-[var(--text-3)]"><span>Aprobación previa para cambios; auditorías read-only limitadas por contrato y sandbox.</span><span>{data?.waitingApproval ?? "—"} esperando aprobación</span><span>{data?.readyTasks ?? "—"} aprobada(s) o en cola</span><span>Actualizado: {localTime(data?.updatedAt)}</span></div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
    {loading && !data && <p className="text-xs text-[var(--text-3)]">Consultando la política guardada…</p>}
  </section>;
}
