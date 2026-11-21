"use client";

import { useRef, useState } from "react";

export function CodexManualDispatch({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<"audit" | "change">("audit");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const idempotency = useRef({ payload: "", key: "" });

  async function submit() {
    if (!title.trim() || !prompt.trim()) return;
    const payloadKey = JSON.stringify([mode, title.trim(), prompt.trim()]);
    if (idempotency.current.payload !== payloadKey) {
      idempotency.current = { payload: payloadKey, key: globalThis.crypto?.randomUUID?.() || `codex-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/codex/manual-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency.current.key },
        body: JSON.stringify({ mode, title: title.trim(), prompt: prompt.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.request?.id) throw new Error(String(result?.error || `Hermy HQ respondió HTTP ${response.status}`));
      const state = result.request.status === "awaiting_approval" ? "espera tu aprobación" : result.request.status;
      setNotice(`Tarea ${result.request.id}: ${state}. Override aplicado solo a límites internos de prioridad/frecuencia.`);
      setTitle(""); setPrompt(""); idempotency.current = { payload: "", key: "" };
      onCreated();
    } catch (value) {
      setError(value instanceof Error ? value.message : "No se pudo asignar la tarea");
    } finally { setBusy(false); }
  }

  return <section className="panel p-5 space-y-3">
    <div><div className="eyebrow">Asignación manual directa</div><p className="mt-1 text-xs text-[var(--text-3)]">Tu sesión autorizada puede omitir prioridad mínima y frecuencia internas de Hermy HQ. No omite límites reales de Codex ni controles de seguridad. Puedes encolar varias tareas; el worker las procesa de una en una.</p></div>
    <label className="block text-xs text-[var(--text-2)]">Tipo de tarea
      <select value={mode} onChange={event => setMode(event.target.value as "audit" | "change")} className="mt-1 w-full rounded-[var(--r-md)] px-3 py-2 text-sm bg-[var(--surface-2)]" style={{ border: "1px solid var(--line)" }}>
        <option value="audit">Auditoría de solo lectura</option>
        <option value="change">Cambio de ingeniería · requiere aprobación</option>
      </select>
    </label>
    <input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="Título de la tarea" className="w-full rounded-[var(--r-md)] px-3 py-2 text-sm bg-[var(--surface-2)]" style={{ border: "1px solid var(--line)" }} />
    <textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={12000} rows={4} placeholder={mode === "audit" ? "Indica qué debe revisar Codex. No podrá modificar archivos ni servicios." : "Describe el cambio solicitado. Codex esperará tu aprobación antes de ejecutarlo."} className="w-full rounded-[var(--r-md)] px-3 py-2 text-sm bg-[var(--surface-2)]" style={{ border: "1px solid var(--line)" }} />
    <button type="button" onClick={() => void submit()} disabled={busy || !title.trim() || !prompt.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{busy ? "Enviando…" : "Asignar directamente a Codex"}</button>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-300">{notice}</p>}
  </section>;
}
