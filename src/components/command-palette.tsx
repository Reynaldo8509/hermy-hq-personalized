"use client";

/* ───────────────────────────────────────────────────────────
   Hermy HQ · Command Palette (⌘K / Ctrl-K)
   Globally mounted. Fuzzy nav + dispatch-to-Hermes fallback.
   Calm Luxury tokens, no external deps beyond lucide-react.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commandRequiresApproval, dispatchConfirmation, dispatchPresentation } from "@/lib/command-center-domain.mjs";
import {
  Activity,
  LayoutDashboard,
  Bot,
  ListChecks,
  BookOpen,
  CalendarClock,
  Network,
  Sparkles,
  Compass,
  Cpu,
  Telescope,
  ShieldCheck,
  Mail,
  Share2,
  House,
  Wrench,
  CornerDownLeft,
  Search,
  Check,
  AlertTriangle,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { label: "Overview / Command Center", href: "/", icon: LayoutDashboard },
  { label: "Action Center", href: "/action-center", icon: Activity },
  { label: "Memory", href: "/memory-center", icon: BookOpen },
  { label: "Automations", href: "/automations", icon: CalendarClock },
  { label: "Security & Network", href: "/security-center", icon: Network },
  { label: "Agents", href: "/agents", icon: Bot },
  { label: "Infrastructure", href: "/infrastructure", icon: Cpu },
  { label: "Models & Performance", href: "/infrastructure#model-performance", icon: Cpu },
  { label: "Max", href: "/operations?panel=max", icon: Compass },
  { label: "Atlas", href: "/operations?panel=atlas", icon: Telescope },
  { label: "Aegis", href: "/operations?panel=aegis", icon: ShieldCheck },
  { label: "Milo", href: "/operations?panel=milo", icon: Mail },
  { label: "Pulse", href: "/operations?panel=pulse", icon: Share2 },
  { label: "Ledger", href: "/operations?panel=ledger", icon: Wrench },
  { label: "Domus", href: "/operations?panel=domus", icon: House },
  { label: "Codex", href: "/operations?panel=codex", icon: Cpu },
  { label: "Home Assistant", href: "/operations?panel=home", icon: House },
  { label: "Tasks", href: "/tasks", icon: ListChecks },
  { label: "Hermes", href: "/hermes", icon: Sparkles },
  { label: "Settings", href: "/settings", icon: Wrench },
];

type Row =
  | { kind: "nav"; item: NavItem }
  | { kind: "dispatch"; query: string };

type DispatchView = { state: "idle" | "sending" | "queued" | "approval" | "running" | "completed" | "failed" | "error"; message: string; requestId?: string; href?: string; query?: string };

function makeIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dispatchView, setDispatchView] = useState<DispatchView>({ state: "idle", message: "" });
  const dispatchInFlight = useRef(false);
  const idempotency = useRef<{ query: string; key: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── global open/close hotkey ──────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── reset + focus when opening ────────────────────────────
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setDispatchView({ state: "idle", message: "" });
      idempotency.current = null;
      // focus after paint so the trap works reliably
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ── lock scroll while open ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ── fuzzy (case-insensitive substring) nav filter ─────────
  const navMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter(
      (n) => n.label.toLowerCase().includes(q) || n.href.toLowerCase().includes(q),
    );
  }, [query]);

  // Build the flat row list. Dispatch shows as the last option whenever
  // there's a query, or as the sole option when nothing matches nav.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = navMatches.map((item) => ({ kind: "nav", item }));
    if (query.trim()) out.push({ kind: "dispatch", query: query.trim() });
    return out;
  }, [navMatches, query]);

  // keep highlight in range as rows shrink/grow
  useEffect(() => {
    setActive((a) => (rows.length === 0 ? 0 : Math.min(a, rows.length - 1)));
  }, [rows.length]);

  const close = useCallback(() => setOpen(false), []);

  const runDispatch = useCallback(async (q: string) => {
    // Route anything that acts on the outside world to the Approval Inbox
    // instead of running it immediately.
    const sideEffecting = commandRequiresApproval(q);
    const key = idempotency.current?.query === q ? idempotency.current.key : makeIdempotencyKey();
    idempotency.current = { query: q, key };
    const response = await fetch("/api/hermes/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ kind: "oneshot", title: q, prompt: q, sideEffecting }),
      });
    const payload = await response.json().catch(() => ({}));
    return dispatchConfirmation(response.status, payload);
  }, []);

  const run = useCallback(
    async (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "nav") {
        close();
        router.push(row.item.href);
        return;
      }
      if (dispatchInFlight.current) return;
      if (dispatchView.requestId && dispatchView.query === row.query) return;
      dispatchInFlight.current = true;
      setDispatchView({ state: "sending", message: "Enviando solicitud a la cola existente…", query: row.query });
      try {
        const result = await runDispatch(row.query);
        const presentation = dispatchPresentation(result.request);
        setDispatchView({
          ...presentation,
          requestId: result.request.id,
          query: row.query,
        });
        idempotency.current = null;
      } catch (cause) {
        setDispatchView({ state: "error", message: cause instanceof Error ? cause.message : "No se pudo confirmar la solicitud.", query: row.query });
      } finally {
        dispatchInFlight.current = false;
      }
    },
    [close, dispatchView, router, runDispatch],
  );

  // ── keyboard nav within the palette ───────────────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(rows[active]);
    }
  };

  // scroll the active row into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const navRows = rows.filter((r) => r.kind === "nav") as Extract<Row, { kind: "nav" }>[];
  const dispatchRow = rows.find((r) => r.kind === "dispatch") as
    | Extract<Row, { kind: "dispatch" }>
    | undefined;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-start justify-center px-4 pt-[18vh] motion-safe:animate-[hq-rise_0.18s_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
            aria-label="Paleta de comandos"
        className="elevated w-full max-w-[560px] overflow-hidden"
        style={{ borderRadius: "var(--r-md)" }}
        onKeyDown={onKeyDown}
      >
        {/* input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--line)]">
          <Search className="w-4 h-4 text-[var(--text-3)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setDispatchView({ state: "idle", message: "" });
              idempotency.current = null;
            }}
            aria-label="Buscar una sección o escribir una solicitud para Hermes"
            placeholder="Buscar una sección o solicitar a Hermes…"
            spellCheck={false}
            autoComplete="off"
            className="num flex-1 bg-transparent border-0 outline-none text-[15px] text-[var(--text)] placeholder-[var(--text-3)]"
          />
        </div>

        {/* results */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {navRows.length > 0 && (
            <div className="px-2 pb-1">
              <div className="eyebrow px-3 py-1.5">Navigate</div>
              {navRows.map((r) => {
                const idx = rows.indexOf(r);
                return (
                  <PaletteRow
                    key={r.item.href}
                    idx={idx}
                    active={active === idx}
                    onHover={() => setActive(idx)}
                    onSelect={() => run(r)}
                    icon={<r.item.icon className="w-4 h-4" />}
                  >
                    <span className="text-[var(--text)]">{r.item.label}</span>
                    <span className="num ml-auto text-[11px] text-[var(--text-4)]">
                      {r.item.href}
                    </span>
                  </PaletteRow>
                );
              })}
            </div>
          )}

          {dispatchRow && (
            <div className="px-2 pt-1">
              <div className="eyebrow px-3 py-1.5">Nueva solicitud para Hermes</div>
              {(() => {
                const idx = rows.indexOf(dispatchRow);
                return (
                  <PaletteRow
                    idx={idx}
                    active={active === idx}
                    onHover={() => setActive(idx)}
                    onSelect={() => run(dispatchRow)}
                    icon={
                      dispatchView.state === "sending" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : dispatchView.state === "error" || dispatchView.state === "failed" ? <AlertTriangle className="h-4 w-4 text-red-300" aria-hidden="true" />
                          : dispatchView.state !== "idle" ? <Check className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                            : <Sparkles className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                    }
                  >
                    {dispatchView.state === "sending" ? <span className="text-[var(--text-2)]">Enviando solicitud…</span> : (
                      <span className="text-[var(--text)] truncate">
                        Solicitar a Hermes:{" "}
                        <span className="text-[var(--text-2)]">
                          &ldquo;{dispatchRow.query}&rdquo;
                        </span>
                      </span>
                    )}
                  </PaletteRow>
                );
              })()}
            </div>
          )}

          {rows.length === 0 && (
            <div className="px-5 py-8 text-center text-[13px] text-[var(--text-3)]">
              No matches.
            </div>
          )}
        </div>

        {dispatchView.state !== "idle" && <div aria-live="polite" role={dispatchView.state === "error" ? "alert" : "status"} className={`border-t px-4 py-3 text-xs ${dispatchView.state === "error" ? "border-red-500/30 text-red-200" : "border-[var(--line)] text-[var(--text-2)]"}`}>
          <p>{dispatchView.message}</p>
          {dispatchView.requestId && <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="num text-[10px] text-[var(--text-3)]">ID · {dispatchView.requestId}</span><button type="button" onClick={() => { close(); router.push(dispatchView.href || "/tasks"); }} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs hover:bg-[var(--surface-1)]">Ver seguimiento</button></div>}
        </div>}

        {/* hint bar */}
        <div className="flex items-center gap-4 px-4 py-2.5 border-t border-[var(--line)] text-[11px] num text-[var(--text-3)]">
          <span className="inline-flex items-center gap-1.5">
            <CornerDownLeft className="w-3 h-3" /> abrir / enviar
          </span>
          <span aria-hidden>·</span>
          <span>Esc para cerrar</span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <kbd className="rounded px-1.5 py-0.5 bg-[var(--surface-1)] border border-[var(--line)]">
              ↑↓
            </kbd>
            to move
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  idx,
  active,
  onHover,
  onSelect,
  icon,
  children,
}: {
  idx: number;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-idx={idx}
      onMouseMove={onHover}
      onClick={onSelect}
      className="relative flex w-full items-center gap-3 rounded-[var(--r-sm)] px-3 py-2 text-left text-[13.5px] transition-colors"
      style={active ? { background: "var(--surface-1)" } : undefined}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2.5px] rounded-full"
          style={{ background: "var(--accent)" }}
        />
      )}
      <span className="text-[var(--text-3)] shrink-0">{icon}</span>
      <span className="flex flex-1 items-center gap-2 min-w-0">{children}</span>
    </button>
  );
}
