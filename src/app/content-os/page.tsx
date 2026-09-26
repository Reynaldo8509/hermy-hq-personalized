"use client";

/* ───────────────────────────────────────────────────────────
   Content OS — X pipeline board for Hermy HQ
   A growth-engine view over existing tweet drafts.
   Read-first: cards link to /x-content for editing.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Lightbulb,
  CheckCircle2,
  CalendarClock,
  Send,
  Trophy,
  ArrowUpRight,
  Flame,
  RefreshCw,
} from "lucide-react";
import {
  Panel,
  SectionHeader,
  Pill,
  EmptyState,
  Skeleton,
  Eyebrow,
} from "@/components/ui/kit";

// ── Types (mirrors the /api/x-content shape) ────────────────
interface Draft {
  id: string;
  text: string;
  title?: string | null;
  model?: string;
  type?: string;
  status: "pending" | "approved" | "scheduled" | "posted" | "rejected" | string;
  category?: string | null;
  hookType?: string | null;
  viralScore?: number | Record<string, unknown> | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  createdAt?: string;
  postedAt?: string | null;
  tweetUrl?: string | null;
  postedUrl?: string | null;
  tweetId?: string | null;
  views?: number | null;
  metrics?: Record<string, unknown> | null;
}

// ── Helpers ─────────────────────────────────────────────────
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

/** Highest view count across flat or checkpoint-shaped metrics. */
function bestViews(d: Draft): number {
  if (typeof d.views === "number") return d.views;
  const m = d.metrics;
  if (!m || typeof m !== "object") return 0;
  if (typeof (m as Record<string, unknown>).views === "number") {
    return (m as Record<string, number>).views;
  }
  let best = 0;
  for (const v of Object.values(m)) {
    if (v && typeof v === "object") {
      const n = Number((v as Record<string, unknown>).views) || 0;
      if (n > best) best = n;
    }
  }
  return best;
}

/** Normalize viralScore (number, {score}, {bookmarkScore}, or null) to 0–100. */
function scoreOf(vs: Draft["viralScore"]): number | null {
  if (vs == null) return null;
  let raw: number | null = null;
  if (typeof vs === "number") raw = vs;
  else if (typeof vs === "object") {
    const o = vs as Record<string, unknown>;
    if (typeof o.score === "number") raw = o.score;
    else if (typeof o.bookmarkScore === "number") raw = o.bookmarkScore;
  }
  if (raw == null || Number.isNaN(raw)) return null;
  // Some scores are stored on a 0–10 scale, others 0–100. Lift small ones.
  const norm = raw <= 10 ? raw * 10 : raw;
  return Math.max(0, Math.min(100, Math.round(norm)));
}

function scoreTone(score: number): "up" | "warn" | "neutral" {
  if (score >= 70) return "up";
  if (score >= 40) return "warn";
  return "neutral";
}

function isTweet(d: Draft): boolean {
  const t = (d.type || "tweet").toLowerCase();
  return t !== "idea" && t !== "content idea" && t !== "industry idea";
}

function withinDays(iso: string | null | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 86_400_000;
}

// ── Column config ───────────────────────────────────────────
type ColKey = "ideas" | "approved" | "scheduled" | "posted";
const COLS: {
  key: ColKey;
  label: string;
  icon: typeof Lightbulb;
  accent: string;
}[] = [
  { key: "ideas", label: "Ideas", icon: Lightbulb, accent: "var(--warn)" },
  { key: "approved", label: "Approved", icon: CheckCircle2, accent: "var(--up)" },
  { key: "scheduled", label: "Scheduled", icon: CalendarClock, accent: "var(--accent)" },
  { key: "posted", label: "Posted", icon: Send, accent: "var(--accent)" },
];

const CAP = 60; // max cards rendered per column (count in header shows the true total)

// ── Viral score badge ───────────────────────────────────────
function ScoreBadge({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <Pill tone={tone} className="num">
      {tone === "up" && <Flame className="w-3 h-3" strokeWidth={2.25} />}
      {score}
    </Pill>
  );
}

// ── Pipeline card (stretched-link: whole card → /x-content) ──
function PipelineCard({ draft }: { draft: Draft }) {
  const score = scoreOf(draft.viralScore);
  const views = bestViews(draft);
  const posted = draft.status === "posted";
  const tweetUrl = draft.tweetUrl || draft.postedUrl || null;
  const preview = draft.text?.trim() || (posted ? "Posted directly on X" : "Untitled draft");

  return (
    <div
      className="panel panel-interactive relative p-3.5"
      style={{ borderLeft: `2px solid color-mix(in srgb, ${
        posted ? "var(--accent)" : "var(--line-strong)"
      } 55%, transparent)` }}
    >
      {/* stretched overlay link → composer */}
      <a
        href="/x-content"
        aria-label="Open in composer"
        className="absolute inset-0 z-0 rounded-[inherit]"
      />

      <div className="relative z-10 pointer-events-none space-y-2.5">
        {/* text preview */}
        <p
          className={`text-[13px] leading-snug text-[var(--text)] whitespace-pre-wrap ${
            draft.text?.trim() ? "" : "italic text-[var(--text-3)]"
          }`}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {preview}
        </p>

        {/* chips row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {score != null && <ScoreBadge score={score} />}
          {draft.category && (
            <span className="text-[10.5px] px-2 py-0.5 rounded-full font-medium text-[var(--text-3)] border border-[var(--line)]">
              {draft.category}
            </span>
          )}
          {draft.hookType && (
            <span className="text-[10.5px] px-2 py-0.5 rounded-full font-medium text-[var(--text-3)] border border-[var(--line)]">
              {draft.hookType}
            </span>
          )}
        </div>

        {/* scheduled slot */}
        {draft.status === "scheduled" || (draft.status === "approved" && draft.scheduledDate) ? (
          draft.scheduledDate && (
            <div className="num text-[11px] flex items-center gap-1.5" style={{ color: "var(--accent)" }}>
              <CalendarClock className="w-3.5 h-3.5" />
              {draft.scheduledDate}
              {draft.scheduledTime ? ` · ${draft.scheduledTime}` : ""}
            </div>
          )
        ) : null}

        {/* posted metrics */}
        {posted && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] pt-2 mt-1">
            <span className="num text-[12px] font-semibold text-[var(--text-2)]">
              {fmt(views)}
              <span className="text-[var(--text-3)] font-normal"> views</span>
            </span>
            {tweetUrl && (
              <a
                href={tweetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto num text-[11px] font-medium inline-flex items-center gap-0.5 text-[var(--accent)] hover:brightness-110"
              >
                View on X
                <ArrowUpRight className="w-3 h-3" strokeWidth={2.25} />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pipeline column ─────────────────────────────────────────
function Column({
  col,
  drafts,
}: {
  col: (typeof COLS)[number];
  drafts: Draft[];
}) {
  const Icon = col.icon;
  const shown = drafts.slice(0, CAP);
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-2 px-1 pb-3">
        <Icon className="w-4 h-4" style={{ color: col.accent }} strokeWidth={2} />
        <span className="text-[13px] font-semibold text-[var(--text)]">{col.label}</span>
        <span className="num text-[11px] text-[var(--text-3)] ml-auto">{drafts.length}</span>
      </div>
      <div
        className="flex flex-col gap-2.5 overflow-y-auto pr-1 -mr-1"
        style={{ maxHeight: "min(70vh, 720px)" }}
      >
        {shown.length === 0 ? (
          <div className="rounded-[var(--r-md)] border border-dashed border-[var(--line)] py-10 text-center text-[12px] text-[var(--text-3)]">
            Nothing here yet
          </div>
        ) : (
          shown.map((d) => <PipelineCard key={d.id} draft={d} />)
        )}
        {drafts.length > CAP && (
          <a
            href="/x-content"
            className="text-center text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)] py-2"
          >
            + {drafts.length - CAP} more in composer →
          </a>
        )}
      </div>
    </div>
  );
}

// ── Summary stat chip ───────────────────────────────────────
function StatChip({ label, value, tone = "neutral" }: { label: string; value: string; tone?: string }) {
  const color =
    tone === "up" ? "var(--up)" : tone === "accent" ? "var(--accent)" : tone === "warn" ? "var(--warn)" : "var(--text-2)";
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-2.5">
      <div className="num text-[20px] font-semibold leading-none" style={{ color }}>
        {value}
      </div>
      <div className="eyebrow mt-1.5">{label}</div>
    </div>
  );
}

// ── Top performers ──────────────────────────────────────────
function TopPerformers({ posted }: { posted: Draft[] }) {
  const ranked = useMemo(
    () =>
      [...posted]
        .map((d) => ({ d, views: bestViews(d), score: scoreOf(d.viralScore) }))
        .filter((r) => r.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, 6),
    [posted]
  );

  return (
    <>
      <SectionHeader
        label="What worked"
        title="Top performers"
        action={<span className="num text-[11px] text-[var(--text-3)]">by views</span>}
      />
      {ranked.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<Trophy className="w-6 h-6" />}
            title="No view data yet"
            hint="Posted tweets with metrics will rank here — the feedback loop for what to make more of."
          />
        </Panel>
      ) : (
        <Panel className="p-2">
          <div className="divide-y divide-[var(--line)]">
            {ranked.map((r, i) => {
              const tweetUrl = r.d.tweetUrl || r.d.postedUrl || null;
              const preview = r.d.text?.trim() || "Posted directly on X";
              return (
                <div key={r.d.id} className="flex items-start gap-3.5 px-3.5 py-3">
                  <span
                    className="num text-[15px] font-semibold w-6 shrink-0 text-center"
                    style={{ color: i === 0 ? "var(--accent)" : "var(--text-3)" }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-[13px] leading-snug ${r.d.text?.trim() ? "text-[var(--text)]" : "italic text-[var(--text-3)]"}`}
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {preview}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="num text-[12px] font-semibold text-[var(--text-2)]">
                        {fmt(r.views)}
                        <span className="text-[var(--text-3)] font-normal"> views</span>
                      </span>
                      {r.score != null && <ScoreBadge score={r.score} />}
                      {tweetUrl && (
                        <a
                          href={tweetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="num text-[11px] font-medium inline-flex items-center gap-0.5 text-[var(--accent)] hover:brightness-110 ml-auto"
                        >
                          View
                          <ArrowUpRight className="w-3 h-3" strokeWidth={2.25} />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </>
  );
}

// ── Page ────────────────────────────────────────────────────
export default function ContentOSPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      // NOTE: the API treats ?status=all as a literal filter (matches nothing but
      // injected posted tweets), so we fetch unfiltered to populate every column.
      const res = await fetch("/api/x-content", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setDrafts(Array.isArray(data) ? data : (data?.drafts ?? []));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // ── Derive pipeline buckets ──
  const { ideas, approved, scheduled, posted, stats } = useMemo(() => {
    const tweets = drafts.filter(isTweet);
    const ideas = tweets
      .filter((d) => d.status === "pending")
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const approved = tweets
      .filter((d) => d.status === "approved" && !d.scheduledDate)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const scheduled = tweets
      .filter((d) => d.status === "scheduled" || (d.status === "approved" && d.scheduledDate))
      .sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));
    const posted = tweets
      .filter((d) => d.status === "posted")
      .sort((a, b) => bestViews(b) - bestViews(a));

    const postedThisWeek = posted.filter((d) => withinDays(d.postedAt || d.createdAt, 7));
    const viewsThisWeek = postedThisWeek.reduce((sum, d) => sum + bestViews(d), 0);

    return {
      ideas,
      approved,
      scheduled,
      posted,
      stats: {
        pending: ideas.length,
        scheduled: scheduled.length,
        postedThisWeek: postedThisWeek.length,
        viewsThisWeek,
      },
    };
  }, [drafts]);

  const byCol: Record<ColKey, Draft[]> = { ideas, approved, scheduled, posted };

  return (
    <>
      <div className="relative z-10 w-full mx-auto pb-16">
        {/* Header */}
        <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <Eyebrow>Content OS</Eyebrow>
            <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
              X Pipeline
            </h1>
            <p className="mt-3 text-[14px] text-[var(--text-2)]">
              Every tweet from idea to impact.
            </p>
          </div>
          <button
            type="button"
            onClick={manualRefresh}
            aria-label="Refresh"
            className="btn-ghost inline-flex items-center justify-center w-9 h-9"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Summary chips */}
        <div className="hq-rise flex flex-wrap gap-3">
          <StatChip label="In ideas" value={loaded ? String(stats.pending) : "—"} tone="warn" />
          <StatChip label="Scheduled" value={loaded ? String(stats.scheduled) : "—"} tone="accent" />
          <StatChip label="Posted this week" value={loaded ? String(stats.postedThisWeek) : "—"} tone="up" />
          <StatChip label="Views this week" value={loaded ? fmt(stats.viewsThisWeek) : "—"} tone="accent" />
        </div>

        {/* Error */}
        {error && loaded && drafts.length === 0 && (
          <div className="mt-8">
            <Panel className="p-2">
              <EmptyState
                title="Couldn't load the pipeline"
                hint={error === "401" ? "Session expired — sign back in." : `Error ${error}. It will retry automatically.`}
                action={
                  <button onClick={manualRefresh} className="btn-ghost px-4 py-2 text-[13px]">
                    Retry
                  </button>
                }
              />
            </Panel>
          </div>
        )}

        {/* Pipeline board */}
        <section className="mt-12">
          <SectionHeader label="Pipeline" title="The board" />
          {!loaded ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
              {COLS.map((c) => (
                <div key={c.key} className="flex flex-col gap-2.5">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-28" />
                  <Skeleton className="h-28" />
                  <Skeleton className="h-28" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
              {COLS.map((c) => (
                <Column key={c.key} col={c} drafts={byCol[c.key]} />
              ))}
            </div>
          )}
        </section>

        {/* Top performers */}
        <section className="mt-14">
          {!loaded ? (
            <>
              <SectionHeader label="What worked" title="Top performers" />
              <Skeleton className="h-64" />
            </>
          ) : (
            <TopPerformers posted={posted} />
          )}
        </section>
      </div>
    </>
  );
}
