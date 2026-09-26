"use client";

import { useEffect, useState, useCallback } from "react";
import { EmptyState } from "@/components/ui/kit";

interface Signal {
  id: string;
  handle: string;
  likes: number;
  ageMinutes: number;
  summary: string;
  url: string;
  draft: string;
  detectedAt: string;
}

interface WatchlistData {
  signals: Signal[];
  lastUpdated: string | null;
}

function timeAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function SignalCard({ signal }: { signal: Signal }) {
  const [copied, setCopied] = useState(false);
  const [sniped, setSniped] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(signal.draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSnipe = async () => {
    setSniped(true);
    try {
      await fetch("/api/x-content", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": "296cfa48ad6963eb21ac9deb4981ad0c982cff51631bda9cf43fd0fa7217088b",
        },
        body: JSON.stringify({
          text: signal.draft,
          model: "radar",
          type: "tweet",
          status: "pending",
          quoteUrl: signal.url,
        }),
      });
    } catch { /* silent */ }
    setTimeout(() => setSniped(false), 2000);
  };

  return (
    <div className="panel panel-interactive overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-[var(--line)] flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold text-[var(--text)]">@{signal.handle}</span>
          <span className="num text-[12px] text-[var(--text-3)]">{timeAgo(signal.ageMinutes)}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="num text-[13px] font-semibold text-[var(--text-2)]">
            {signal.likes >= 1000 ? `${(signal.likes / 1000).toFixed(1)}k` : signal.likes}
          </span>
          <span className="text-[11px] text-[var(--text-3)]">likes</span>
        </div>
      </div>

      {/* Tweet summary */}
      <div className="px-5 py-4">
        <p className="text-[13px] text-[var(--text-2)] leading-relaxed">{signal.summary}</p>
      </div>

      {/* Draft tweet box */}
      {signal.draft && (
        <div className="mx-5 mb-4 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Draft tweet</span>
            <button onClick={handleCopy}
              className="text-[11px] font-medium transition-colors"
              style={{ color: copied ? "var(--up)" : "var(--text-3)" }}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[12px] text-[var(--text)] leading-relaxed whitespace-pre-line">{signal.draft}</p>
        </div>
      )}

      {/* Actions */}
      <div className="mt-auto px-5 pb-4 flex gap-2">
        <a href={signal.url} target="_blank" rel="noopener noreferrer"
          className="btn-ghost flex-1 justify-center py-2 text-[12px] font-medium text-center">
          View on X
        </a>
        <button onClick={handleSnipe}
          className="flex-1 py-2 rounded-[var(--r-sm)] text-[12px] font-semibold transition-colors text-center inline-flex items-center justify-center gap-1"
          style={sniped
            ? { color: "var(--up)", background: "color-mix(in srgb, var(--up) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--up) 24%, transparent)" }
            : { color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)" }}>
          {sniped ? "Saved to drafts" : "Snipe"}
        </button>
      </div>
    </div>
  );
}

export default function WatchlistRadarPage() {
  const [data, setData] = useState<WatchlistData>({ signals: [], lastUpdated: null });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/watchlist-radar", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const lastUpdatedMins = data.lastUpdated
    ? Math.floor((Date.now() - new Date(data.lastUpdated).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-5 pt-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-1">
          <div className="text-[12px] text-[var(--text-2)]">
            Monitoring 14 accounts <span className="text-[var(--text-4)]">·</span> updates every 15 min <span className="text-[var(--text-4)]">·</span> threshold 80 likes
          </div>
          {lastUpdatedMins !== null && (
            <div className="num text-[12px] text-[var(--text-3)]">Last scan {timeAgo(lastUpdatedMins)}</div>
          )}
        </div>
        <button onClick={load} className="btn-ghost px-3 py-1.5 text-[12px] font-medium">
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <div key={i} className="sk h-56 rounded-[var(--r-lg)]" />)}
        </div>
      ) : data.signals.length === 0 ? (
        <EmptyState
          title="No signals in the last 3 hours"
          hint="Radar checks every 15 min across your watchlist."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.signals.map((s, i) => (
            <div key={s.id} className="hq-rise" style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }}>
              <SignalCard signal={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
