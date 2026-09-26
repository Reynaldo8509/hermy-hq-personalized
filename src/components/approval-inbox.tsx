"use client";

/* ───────────────────────────────────────────────────────────
   Hermy HQ · Approval inbox
   "Everything that needs your tap" queue.
   Self-contained: polls /api/hermes/requests, one-tap
   approve / reject / edit via PATCH. Calm Luxury.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { Check, X, Pencil, Inbox } from "lucide-react";
import {
  Panel,
  Pill,
  EmptyState,
  Eyebrow,
} from "@/components/ui/kit";

// ── Types ─────────────────────────────────────────────────
interface Req {
  id: string;
  origin: string;
  kind: string;
  title: string;
  prompt: string | null;
  sideEffecting: boolean;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
}
interface Approval { id: string; request_id: string; status: string; action: string; requested_by: string; approved_by: string | null; reason: string | null; created_at: string; resolved_at: string | null; expires_at: string; title: string | null; request_status: string | null; request_result: string | null; request_error: string | null; }
interface Incident { id: string; incident: string; evidence: string; cause: string; hypothesis: string; remediation: string; validation: string; limitations: string; next_action: string; provider: string | null; model: string | null; duration_ms: number | null; status: string; agent: string | null; request_id: string | null; updated_at: string; }
interface Attempt { id: string; request_id: string; attempt_no: number; provider: string; model: string; status: string; reason: string | null; duration_ms: number | null; created_at: string; finished_at: string | null; }

// ── Helpers ───────────────────────────────────────────────
function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── Card ──────────────────────────────────────────────────
function InboxCard({
  req,
  compact,
  onAction,
}: {
  req: Req;
  compact: boolean;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(req.title);
  const [draftPrompt, setDraftPrompt] = useState(req.prompt ?? "");
  const [actionError, setActionError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const destructive = req.status === "awaiting_destructive_confirmation";
  const expiresIn = Math.max(0, 10 - Math.floor((Date.now() - new Date(req.createdAt).getTime()) / 60000));
  const confirmationValue = confirmation.trim();
  const confirmationIsValid = confirmationValue === req.id || confirmationValue === `AUTORIZO ${req.id}`;

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const endpoint = body.action === "confirm_destructive" ? `/api/codex/tasks/${req.id}` : `/api/hermes/requests/${req.id}`;
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(String(payload.error || `Request failed (${response.status})`));
      }
      // optimistic: card fades, parent refetches
      onAction();
    } catch (error) {
      setBusy(false);
      setEditing(false);
      setActionError(error instanceof Error ? error.message : "No se pudo procesar la tarea");
    }
  };

  const pad = compact ? "p-4" : "p-5";

  return (
    <Panel className={`${pad} ${busy ? "opacity-50 pointer-events-none" : ""}`}>
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="neutral">{req.kind}</Pill>
          {req.sideEffecting && <Pill tone="warn">side-effecting</Pill>}
          {destructive && <Pill tone="down">DESTRUCTIVE · root</Pill>}
        </div>
        <span className="num text-[10.5px] text-[var(--text-3)] shrink-0 mt-1">
          {timeAgo(req.createdAt)}
        </span>
      </div>

      {editing ? (
        <div className="space-y-2.5">
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="w-full bg-transparent text-[14px] font-medium text-[var(--text)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
          />
          <textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            rows={3}
            className="w-full bg-transparent text-[13px] text-[var(--text-2)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] resize-y"
          />
        </div>
      ) : (
        <>
          <h3 className="text-[15px] font-medium text-[var(--text)] leading-snug">
            {req.title}
          </h3>
          {req.prompt && (
            <p className="mt-1.5 text-[13px] text-[var(--text-2)] leading-snug line-clamp-2">
              {req.prompt}
            </p>
          )}
        </>
      )}

      {destructive && !editing && <div className="mt-4 rounded-[8px] p-3 space-y-2" style={{ border: "1px solid color-mix(in srgb, var(--down) 45%, transparent)", background: "color-mix(in srgb, var(--down) 8%, transparent)" }}><p className="text-xs text-[var(--down)]">Root execution blocked. Expires in {expiresIn} min. Escribe el ID de la tarea o <code>AUTORIZO {req.id}</code> para confirmar.</p><input value={confirmation} onChange={e => setConfirmation(e.target.value)} placeholder={req.id} className="w-full bg-transparent text-xs px-3 py-2 rounded-[8px] border border-[var(--line)]" /><button type="button" disabled={!confirmationIsValid} onClick={() => patch({ action: "confirm_destructive", confirmation: `AUTORIZO ${req.id}` })} className="rounded-full px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40" style={{ color: "var(--down)", border: "1px solid color-mix(in srgb, var(--down) 45%, transparent)" }}>Aprobar tarea</button>{actionError && <p className="text-xs text-[var(--down)]">{actionError}</p>}</div>}
      <div className="flex items-center gap-2 mt-4">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() =>
                patch({
                  action: "edit",
                  title: draftTitle.trim(),
                  prompt: draftPrompt,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
              style={{
                color: "var(--accent)",
                border:
                  "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              }}
            >
              <Check className="w-3.5 h-3.5" />
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraftTitle(req.title);
                setDraftPrompt(req.prompt ?? "");
              }}
              className="btn-ghost inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium"
            >
              Cancel
            </button>
          </>
        ) : destructive ? (
          <button type="button" onClick={() => patch({ action: "reject" })} className="btn-ghost px-3.5 py-1.5 text-[12px]">Reject</button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => patch({ action: "approve" })}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
              style={{
                color: "var(--up)",
                border: "1px solid color-mix(in srgb, var(--up) 30%, transparent)",
                background: "color-mix(in srgb, var(--up) 10%, transparent)",
              }}
            >
              <Check className="w-3.5 h-3.5" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => patch({ action: "reject" })}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors text-[var(--text-2)] hover:text-[var(--down)]"
              style={{ border: "1px solid var(--line)" }}
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors text-[var(--text-2)] hover:text-[var(--text)]"
              style={{ border: "1px solid var(--line)" }}
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}

// ── Main ──────────────────────────────────────────────────
export function ApprovalInbox({ compact = false }: { compact?: boolean }) {
  const [requests, setRequests] = useState<Req[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<{ approvals: Approval[]; incidents: Incident[]; attempts: Attempt[] }>({ approvals: [], incidents: [], attempts: [] });
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState({ q: "", status: "", agent: "", provider: "" });

  const load = useCallback(async () => {
    const data = await getJSON<{ requests: Req[]; pending: number }>(
      "/api/hermes/requests?status=awaiting_approval,awaiting_destructive_confirmation&take=50"
    );
    if (data) {
      setRequests(data.requests ?? []);
      setPending(data.pending ?? data.requests?.length ?? 0);
    }
    const approvalData = await getJSON<{ approvals: Approval[] }>('/api/hermes/approvals');
    if (approvalData) setApprovals(approvalData.approvals ?? []);
    const params = new URLSearchParams({ take: "40", ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
    const historyData = await getJSON<{ approvals: Approval[]; incidents: Incident[]; attempts: Attempt[] }>(`/api/hermes/history?${params}`);
    if (historyData) setHistory({ approvals: historyData.approvals ?? [], incidents: historyData.incidents ?? [], attempts: historyData.attempts ?? [] });
    setLoaded(true);
  }, [filters]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 6000);
    return () => clearInterval(iv);
  }, [load]);

  // optimistic removal, then refetch to reconcile
  const handleAction = useCallback(
    (id: string) => {
      setRequests((prev) => prev.filter((r) => r.id !== id));
      setPending((p) => Math.max(0, p - 1));
      load();
    },
    [load]
  );

  const count = pending || requests.length;
  const visible = compact ? requests.slice(0, 3) : requests;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <Eyebrow>Approval inbox</Eyebrow>
        <Pill tone={count > 0 ? "accent" : "neutral"}>
          {count} pending
        </Pill>
      </div>

      {loaded && requests.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<Check className="w-6 h-6" style={{ color: "var(--up)" }} />}
            title="Nothing needs you right now — you're clear."
            hint="Side-effecting work waiting on your call will land here."
          />
        </Panel>
      ) : requests.length === 0 ? (
        // pre-load: keep it calm, mirror empty framing
        <Panel className="p-2">
          <EmptyState
            icon={<Inbox className="w-6 h-6" />}
            title="Checking the queue…"
          />
        </Panel>
      ) : (
        <div className={`flex flex-col ${compact ? "gap-2.5" : "gap-4"}`}>
          {visible.map((req) => (
            <div key={req.id}>
              <InboxCard req={req} compact={compact} onAction={() => handleAction(req.id)} />
              {(() => { const a = approvals.find((x) => x.request_id === req.id); return a ? <p className="mt-1 px-2 text-[10px] text-[var(--text-3)]">Approval: {a.status} · requested by {a.requested_by}{a.reason ? ` · ${a.reason}` : ""}</p> : null; })()}
            </div>
          ))}
          {compact && count > 3 && (
            <a
              href="/hermes"
              className="inline-flex items-center gap-1 self-start text-[12.5px] font-medium transition-colors"
              style={{ color: "var(--accent)" }}
            >
              View all in Hermes →
            </a>
          )}
        </div>
      )}

      {!compact && loaded && <div className="mt-8 space-y-4">
        <Eyebrow>Historical record</Eyebrow>
        <Panel className="p-4"><div className="grid grid-cols-1 md:grid-cols-4 gap-2"><input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="Search incidents, requests, reasons…" className="rounded-lg px-3 py-2 text-xs bg-[var(--surface-2)]" /><select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="rounded-lg px-3 py-2 text-xs bg-[var(--surface-2)]"><option value="">All statuses</option><option value="resolved">resolved</option><option value="blocked">blocked</option><option value="approved">approved</option><option value="rejected">rejected</option><option value="expired">expired</option></select><input value={filters.agent} onChange={(e) => setFilters((f) => ({ ...f, agent: e.target.value }))} placeholder="Agent" className="rounded-lg px-3 py-2 text-xs bg-[var(--surface-2)]" /><input value={filters.provider} onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))} placeholder="Provider" className="rounded-lg px-3 py-2 text-xs bg-[var(--surface-2)]" /></div></Panel>
        <Panel className="p-4">
          <h3 className="text-sm font-medium">Approval history</h3>
          <div className="mt-3 space-y-2">
            {history.approvals.length === 0 ? <p className="text-xs text-[var(--text-3)]">No approval history.</p> : history.approvals.map((a) => <div key={a.id} className="rounded-lg p-3 text-xs" style={{ background: "var(--surface-2)" }}>
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{a.title || a.request_id}</span><Pill tone={a.status === "approved" ? "accent" : a.status === "rejected" ? "down" : "neutral"}>{a.status}</Pill></div>
              <p className="mt-1 text-[var(--text-3)]">{a.action} · requested by {a.requested_by} · {a.approved_by ? `resolved by ${a.approved_by} · ` : ""}expires {new Date(a.expires_at).toLocaleString()}</p>
              {a.reason && <p className="mt-1 text-[var(--text-2)]">Reason: {a.reason}</p>}
              {a.request_result && <p className="mt-1 text-[var(--up)]">Result: {a.request_result}</p>}
              {a.request_error && <p className="mt-1 text-[var(--down)]">Error: {a.request_error}</p>}
            </div>)}
          </div>
        </Panel>
        <Panel className="p-4">
          <h3 className="text-sm font-medium">Incident memory</h3>
          <div className="mt-3 space-y-2">
            {history.incidents.length === 0 ? <p className="text-xs text-[var(--text-3)]">No incident history.</p> : history.incidents.map((i) => <div key={i.id} className="rounded-lg p-3 text-xs" style={{ background: "var(--surface-2)" }}>
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{i.incident}</span><Pill tone={i.status === "resolved" ? "accent" : "down"}>{i.status}</Pill></div>
              <p className="mt-1 text-[var(--text-3)]">{i.agent || "unknown agent"} · {i.provider || "—"}/{i.model || "—"}{i.duration_ms == null ? "" : ` · ${i.duration_ms} ms`}</p>
              <dl className="mt-2 grid gap-1 text-[var(--text-2)]"><div><dt className="inline font-medium">Cause: </dt><dd className="inline">{i.cause}</dd></div><div><dt className="inline font-medium">Hypothesis: </dt><dd className="inline">{i.hypothesis}</dd></div><div><dt className="inline font-medium">Remediation: </dt><dd className="inline">{i.remediation}</dd></div><div><dt className="inline font-medium">Validation: </dt><dd className="inline">{i.validation}</dd></div><div><dt className="inline font-medium">Limitations: </dt><dd className="inline">{i.limitations}</dd></div><div><dt className="inline font-medium">Next action: </dt><dd className="inline">{i.next_action}</dd></div></dl>
            </div>)}
          </div>
        </Panel>
        <Panel className="p-4">
          <h3 className="text-sm font-medium">Inference attempts</h3>
          <div className="mt-3 space-y-2">{history.attempts.length === 0 ? <p className="text-xs text-[var(--text-3)]">No inference attempts.</p> : history.attempts.map((a) => <div key={a.id} className="flex flex-wrap justify-between gap-2 rounded-lg p-3 text-xs" style={{ background: "var(--surface-2)" }}><span>#{a.attempt_no} · {a.provider}/{a.model} · {a.request_id}</span><span className={a.status === "success" ? "text-[var(--up)]" : "text-[var(--down)]"}>{a.status}{a.duration_ms == null ? "" : ` · ${a.duration_ms} ms`}{a.reason ? ` · ${a.reason}` : ""}</span></div>)}</div>
        </Panel>
      </div>}
    </div>
  );
}
