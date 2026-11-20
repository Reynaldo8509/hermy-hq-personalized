"use client";

import { formatEcuadorTimestamp } from "@/lib/ecuador-time";
import { useCallback, useEffect, useMemo, useState } from "react";

type AAModel = {
  id: string; slug: string; name: string; creator: string; releaseDate: string | null;
  intelligenceIndex: number | null; codingIndex: number | null; agenticIndex: number | null;
  inputUsdPerMillion: number | null; outputUsdPerMillion: number | null;
  medianOutputTokensPerSecond: number | null; medianTimeToFirstTokenSeconds: number | null;
};
type AACatalog = {
  source: string; tier: string; intelligenceIndexVersion: number | null; observedAt: string;
  pagination: { page: number | null; pageSize: number | null; totalPages: number | null; hasMore: boolean };
  models: AAModel[];
};
type APIResult = { catalog?: AACatalog; quota?: { limit: number | null; remaining: number | null; resetAt: string | null; cacheSeconds: number }; error?: { code: string; message: string } };
type TrackedModel = { provider: string; model: string; calls: number; successes: number; failures: number; avgLatencyMs: number | null; p95LatencyMs: number | null; fallbackAttempts: number };
type RuntimeDetails = { model: string | null; reasoningEffort: string | null; backupModel?: string | null };
type QwenRuntime = { model: string | null; quantization: string | null; reasoning: string | null; contextTokens: number | null; maxOutputTokens: number | null };
type SortKey = "intelligence" | "coding" | "agentic" | "output-speed" | "input-price" | "output-price" | "ttft";

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: "intelligence", label: "Índice de inteligencia" },
  { value: "coding", label: "Índice de programación" },
  { value: "agentic", label: "Índice agéntico" },
  { value: "output-speed", label: "Tokens/s de salida" },
  { value: "input-price", label: "Precio de entrada más bajo" },
  { value: "output-price", label: "Precio de salida más bajo" },
  { value: "ttft", label: "Menor latencia al primer token" },
];

function value(value: number | null, digits = 1) {
  return value === null ? "—" : value.toLocaleString("es-EC", { maximumFractionDigits: digits });
}
function price(value: number | null) {
  return value === null ? "—" : "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function errorText(code: string) {
  const messages: Record<string, string> = {
    not_configured: "Falta configurar el secreto ARTIFICIAL_ANALYSIS_API_KEY en el servidor.",
    invalid_key: "Artificial Analysis rechazó la clave configurada.",
    plan_unavailable: "La clave es válida, pero su plan no permite consultar este endpoint.",
    rate_limited: "Se alcanzó la cuota de consultas de Artificial Analysis.",
    provider_unavailable: "Artificial Analysis no está disponible temporalmente.",
    invalid_catalog: "La respuesta del catálogo no tiene el formato esperado.",
    upstream_timeout: "Artificial Analysis no respondió antes del límite de espera.",
  };
  return messages[code] || "No se pudo cargar el catálogo de Artificial Analysis.";
}

export default function ArtificialAnalysisCatalog({ trackedModels, codexRuntime, qwenRuntime }: { trackedModels: TrackedModel[]; codexRuntime: RuntimeDetails; qwenRuntime: QwenRuntime }) {
  const [catalog, setCatalog] = useState<AACatalog | null>(null);
  const [quota, setQuota] = useState<APIResult["quota"]>(undefined);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("intelligence");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/artificial-analysis", { cache: "no-store" });
      const payload = await response.json() as APIResult;
      if (!response.ok || !payload.catalog) throw new Error(errorText(payload.error?.code || "unknown"));
      setCatalog(payload.catalog);
      setQuota(payload.quota);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : errorText("unknown"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const models = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = (catalog?.models || []).filter((model) => !needle || `${model.name} ${model.creator} ${model.slug}`.toLocaleLowerCase().includes(needle));
    const keys: Record<SortKey, keyof AAModel> = {
      intelligence: "intelligenceIndex", coding: "codingIndex", agentic: "agenticIndex",
      "output-speed": "medianOutputTokensPerSecond", "input-price": "inputUsdPerMillion",
      "output-price": "outputUsdPerMillion", ttft: "medianTimeToFirstTokenSeconds",
    };
    const ascending = sort === "input-price" || sort === "output-price" || sort === "ttft";
    return filtered.sort((a, b) => {
      const left = a[keys[sort]] as number | null;
      const right = b[keys[sort]] as number | null;
      if (left === null) return right === null ? a.name.localeCompare(b.name) : 1;
      if (right === null) return -1;
      return (ascending ? left - right : right - left) || a.name.localeCompare(b.name);
    });
  }, [catalog, query, sort]);

  const selectedModels = selected.map((id) => catalog?.models.find((model) => model.id === id)).filter((model): model is AAModel => Boolean(model));
  const qwenStats = trackedModels.find((item) => item.provider === "qwen-local-tailscale" && item.model === "qwen3-8b-local");
  const codexStats = trackedModels.find((item) => item.provider === "openai" && item.model === "codex");
  const codexSlug = (codexRuntime.model || "").toLowerCase().replace(/\./g, "-") + (codexRuntime.reasoningEffort ? "-" + codexRuntime.reasoningEffort : "");
  const codexBenchmark = catalog?.models.find((item) => item.slug.toLowerCase() === codexSlug);

  function toggleModel(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= 3) return current;
      return [...current, id];
    });
  }

  return <section id="artificial-analysis" className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><div className="eyebrow">Comparación externa de modelos</div><h2 className="mt-1 text-xl font-semibold">Artificial Analysis</h2><p className="mt-1 text-xs text-[var(--text-3)]">Compara benchmarks independientes, velocidad de salida y precios publicados para crear una lista corta de modelos que revisar en las rutas de Hermes. Esta vista no cambia el enrutamiento.</p><nav aria-label="Fuentes de Artificial Analysis" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]"><span className="text-[var(--text-3)]">Fuentes:</span><a className="underline" href="https://artificialanalysis.ai/es" target="_blank" rel="noreferrer">Sitio en español</a><a className="underline" href="https://artificialanalysis.ai/es/models" target="_blank" rel="noreferrer">Modelos y comparaciones</a><a className="underline" href="https://artificialanalysis.ai/es/methodology/intelligence-benchmarking" target="_blank" rel="noreferrer">Metodología de benchmarks</a><a className="underline" href="https://artificialanalysis.ai/data-api/docs" target="_blank" rel="noreferrer">Documentación de Data API</a></nav></div>
      <button onClick={() => void load()} disabled={loading} className="rounded-full border border-[var(--line)] px-4 py-2 text-xs disabled:opacity-50">{loading ? "Consultando…" : "Actualizar catálogo"}</button>
    </div>
    <div className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-3)]">
        <span>{catalog ? `${catalog.models.length} modelos · plan ${catalog.tier} · índice v${catalog.intelligenceIndexVersion ?? "—"}` : "El catálogo requiere una clave configurada en el servidor."}</span>
        <span>{quota?.remaining != null ? `${quota.remaining}${quota.limit != null ? ` / ${quota.limit}` : ""} consultas disponibles` : ""}</span>
      </div>
      {error && <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-950/10 p-3 text-sm text-amber-100">{error}</div>}
      {loading && !catalog && !error && <p className="text-sm text-[var(--text-3)]">Cargando benchmarks y precios…</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-lg border border-cyan-500/30 bg-cyan-950/10 p-4">
            <div className="eyebrow">Modelo local usado ahora · respaldo de Codex</div><h3 className="mt-1 text-lg font-semibold">Qwen3 8B · {qwenRuntime.model || "qwen3-8b-local"}</h3>
            <p className="mt-1 text-sm">Índice de inteligencia Artificial Analysis: <strong>6* · bajo en su clase</strong></p>
            <p className="mt-1 text-xs text-[var(--text-3)]">Referencia del modelo base Qwen3 8B no razonador (estimación AA); no es un benchmark ejecutado sobre el GGUF Q4_K_M local. En el Dell: razonamiento {qwenRuntime.reasoning || "off"}; contexto {qwenRuntime.contextTokens?.toLocaleString("es-EC") || "65.536"}.</p>
            <p className="mt-2 text-xs text-[var(--text-3)]">{qwenStats ? qwenStats.calls + " intentos reales · " + (qwenStats.calls ? ((qwenStats.successes / qwenStats.calls) * 100).toFixed(1) : "0.0") + "% éxito · media " + (qwenStats.avgLatencyMs == null ? "sin dato" : qwenStats.avgLatencyMs.toLocaleString("es-EC") + " ms") + " · fallbacks " + qwenStats.fallbackAttempts : "Aún no hay intentos locales en el periodo."}</p>
            <a className="mt-2 inline-block text-xs underline" href="https://artificialanalysis.ai/models/comparisons/qwen3-8b-instruct-vs-qwen3-8b-instruct-reasoning" target="_blank" rel="noreferrer">Ver puntuación y variante en Artificial Analysis</a>
          </article>
          <article className="rounded-lg border border-violet-500/30 bg-violet-950/10 p-4">
            <div className="eyebrow">Modelo configurado para el trabajador Codex</div><h3 className="mt-1 text-lg font-semibold">{codexRuntime.model || "Modelo no informado"}{codexRuntime.reasoningEffort ? " · " + codexRuntime.reasoningEffort : ""}</h3>
            <p className="mt-1 text-sm">Índice de inteligencia Artificial Analysis: <strong>{codexBenchmark?.intelligenceIndex == null ? (codexSlug === "gpt-5-6-luna-low" ? "21 · referencia publicada" : "Sin dato en catálogo") : value(codexBenchmark.intelligenceIndex) + " · índice externo"}</strong></p>
            <p className="mt-1 text-xs text-[var(--text-3)]">{codexStats ? codexStats.calls + " ejecuciones medidas · " + (codexStats.calls ? ((codexStats.successes / codexStats.calls) * 100).toFixed(1) : "0.0") + "% éxito · media " + (codexStats.avgLatencyMs == null ? "sin dato" : codexStats.avgLatencyMs.toLocaleString("es-EC") + " ms") : "Aún no hay ejecuciones registradas en el periodo."} · respaldo configurado: {codexRuntime.backupModel || "sin dato"}.</p>
            <a className="mt-2 inline-block text-xs underline" href="https://artificialanalysis.ai/models/gpt-5-6-luna-low/" target="_blank" rel="noreferrer">Ver modelo y esfuerzo en Artificial Analysis</a>
          </article>
        </div>
      {catalog && <>
        <div className="grid gap-3 sm:grid-cols-[minmax(12rem,1fr)_16rem]">
          <label className="eyebrow">Buscar modelo o proveedor<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej. Qwen, Claude, OpenAI" className="mt-1 block w-full rounded-lg border border-[var(--line)] bg-[var(--surface-1)] p-2 text-sm font-normal text-[var(--text)]" /></label>
          <label className="eyebrow">Ordenar<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="mt-1 block w-full rounded-lg border border-[var(--line)] bg-[var(--surface-1)] p-2 text-sm font-normal text-[var(--text)]">{SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        </div>
        <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
          <table className="w-full min-w-[1040px] text-left text-xs">
            <thead className="bg-[var(--surface-2)] text-[var(--text-3)]"><tr><th className="p-3">Comparar</th><th className="p-3">Modelo / proveedor</th><th className="p-3">Inteligencia</th><th className="p-3">Coding</th><th className="p-3">Agéntico</th><th className="p-3">Salida tok/s</th><th className="p-3">Primer token</th><th className="p-3">USD / 1M entrada</th><th className="p-3">USD / 1M salida</th></tr></thead>
            <tbody>{models.slice(0, 100).map((model) => <tr key={model.id} className="border-t border-[var(--line)]">
              <td className="p-3"><input type="checkbox" aria-label={`Comparar ${model.name}`} checked={selected.includes(model.id)} disabled={!selected.includes(model.id) && selected.length >= 3} onChange={() => toggleModel(model.id)} /></td>
              <td className="p-3"><strong>{model.name}</strong><div className="mt-1 text-[var(--text-3)]">{model.creator} · {model.slug}</div></td>
              <td className="p-3">{value(model.intelligenceIndex)}</td><td className="p-3">{value(model.codingIndex)}</td><td className="p-3">{value(model.agenticIndex)}</td>
              <td className="p-3">{value(model.medianOutputTokensPerSecond)}</td><td className="p-3">{model.medianTimeToFirstTokenSeconds == null ? "—" : `${value(model.medianTimeToFirstTokenSeconds, 2)} s`}</td>
              <td className="p-3">{price(model.inputUsdPerMillion)}</td><td className="p-3">{price(model.outputUsdPerMillion)}</td>
            </tr>)}</tbody>
          </table>
          {!models.length && <p className="p-4 text-sm text-[var(--text-3)]">No hay modelos que coincidan con la búsqueda.</p>}
          {models.length > 100 && <p className="border-t border-[var(--line)] p-3 text-xs text-[var(--text-3)]">Se muestran los primeros 100 de {models.length} resultados; afina la búsqueda para comparar otros modelos.</p>}
        </div>
        {selectedModels.length > 0 && <div className="space-y-3 rounded-lg border border-[var(--line)] p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Comparación elegida ({selectedModels.length}/3)</h3><button onClick={() => setSelected([])} className="text-xs text-[var(--text-3)] underline">Limpiar selección</button></div><div className="grid gap-3 md:grid-cols-3">{selectedModels.map((model) => <article key={model.id} className="rounded-lg bg-[var(--surface-2)] p-3"><strong>{model.name}</strong><p className="mt-1 text-xs text-[var(--text-3)]">{model.creator}</p><p className="mt-3 text-sm">Índice {value(model.intelligenceIndex)} · coding {value(model.codingIndex)}</p><p className="mt-1 text-xs text-[var(--text-3)]">{value(model.medianOutputTokensPerSecond)} tok/s · entrada {price(model.inputUsdPerMillion)} · salida {price(model.outputUsdPerMillion)} por millón</p></article>)}</div></div>}
      </>}
      <div className="border-t border-[var(--line)] pt-3 text-xs text-[var(--text-3)]"><p>Son referencias de Artificial Analysis; la velocidad y latencia no miden el nodo Dell ni las llamadas reales de Hermes. Para eso usa InferenceAttempt y las lecturas locales de arriba. Los precios son referencias por millón de tokens, no costes medidos de esta instalación.</p><p className="mt-2">Catálogo consultado {catalog ? formatEcuadorTimestamp(catalog.observedAt) : "—"}; caché del servidor de {Math.round((quota?.cacheSeconds || 6 * 60 * 60) / 3600)} h para respetar cuota. Fuente: <a className="underline" href="https://artificialanalysis.ai/es" target="_blank" rel="noreferrer">Artificial Analysis (ES)</a>{catalog?.pagination.hasMore ? ` · página ${catalog.pagination.page ?? 1} de ${catalog.pagination.totalPages ?? "varias"}` : ""}.</p></div>
    </div>
  </section>;
}
