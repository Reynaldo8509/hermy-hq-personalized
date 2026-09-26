"use client";

import { useEffect, useState } from "react";
import { SectionHeader, EmptyState } from "@/components/ui/kit";

interface Tweet {
  id: string;
  text: string;
  views: number;
  likes: number;
  bookmarks: number;
  replies: number;
  retweets: number;
  engRate: number;
  postedAt: string;
  tweetUrl: string | null;
}

interface HeatCell {
  day: number;
  hour: number;
  avgViews: number;
  count: number;
}

interface AnalyticsData {
  tweets: Tweet[];
  heatmap: HeatCell[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function XAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({ tweets: [], heatmap: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/x-analytics")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const { tweets, heatmap } = data;

  const totalViews = tweets.reduce((s, t) => s + t.views, 0);
  const avgEng = tweets.length
    ? Math.round((tweets.reduce((s, t) => s + t.engRate, 0) / tweets.length) * 100) / 100
    : 0;
  const topViews = tweets[0]?.views || 0;

  // Heatmap cell color
  const allAvgViews = heatmap.map((h) => h.avgViews).filter((v) => v > 0).sort((a, b) => a - b);
  const q1 = allAvgViews[Math.floor(allAvgViews.length * 0.25)] || 0;
  const q2 = allAvgViews[Math.floor(allAvgViews.length * 0.5)] || 0;
  const q3 = allAvgViews[Math.floor(allAvgViews.length * 0.75)] || 0;

  // Sequential intensity scale built on the single semantic "up" token.
  const HEAT_EMPTY = "var(--surface-2)";
  function cellColor(avg: number): string {
    if (!avg) return HEAT_EMPTY;
    if (avg >= q3) return "color-mix(in srgb, var(--up) 100%, transparent)";
    if (avg >= q2) return "color-mix(in srgb, var(--up) 66%, var(--surface-1))";
    if (avg >= q1) return "color-mix(in srgb, var(--up) 40%, var(--surface-1))";
    return "color-mix(in srgb, var(--up) 20%, var(--surface-1))";
  }
  const HEAT_LEGEND = [
    HEAT_EMPTY,
    "color-mix(in srgb, var(--up) 20%, var(--surface-1))",
    "color-mix(in srgb, var(--up) 40%, var(--surface-1))",
    "color-mix(in srgb, var(--up) 66%, var(--surface-1))",
    "color-mix(in srgb, var(--up) 100%, transparent)",
  ];

  const heatmapLookup: Record<string, HeatCell> = {};
  for (const h of heatmap) heatmapLookup[`${h.day}-${h.hour}`] = h;

  const engColor = (r: number) =>
    r >= 3 ? "var(--up)" : r >= 1 ? "var(--warn)" : "var(--text-3)";

  const stats = [
    { label: "Tweets Tracked", value: tweets.length.toString() },
    { label: "Total Views", value: fmt(totalViews) },
    { label: "Avg Eng Rate", value: `${avgEng}%` },
    { label: "Top Tweet", value: fmt(topViews) + " views" },
  ];

  return (
    <div className="space-y-10 pb-8">
      {/* Header */}
      <SectionHeader label="X Analytics" title="Tweet performance & posting insights" />

      {loading ? (
        <div className="space-y-10">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="sk h-24 rounded-[var(--r-lg)]" />)}
          </div>
          <div className="sk h-72 rounded-[var(--r-lg)]" />
          <div className="sk h-56 rounded-[var(--r-lg)]" />
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((s, i) => (
              <div key={s.label} className="panel p-5 hq-rise" style={{ animationDelay: `${i * 45}ms` }}>
                <p className="eyebrow">{s.label}</p>
                <p className="num text-[32px] font-semibold tracking-[-0.02em] leading-none text-[var(--text)] mt-3">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Main content */}
          <div className="flex flex-col lg:flex-row gap-5">
            {/* Tweet performance table */}
            <div className="flex-[3] panel overflow-hidden">
              <div className="p-5 border-b border-[var(--line)]">
                <span className="eyebrow">Tweet Performance</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[10px] text-[var(--text-3)] uppercase tracking-[0.12em] border-b border-[var(--line)]">
                      <th className="text-left px-5 py-3 font-medium">Tweet</th>
                      <th className="text-right px-5 py-3 font-medium">Views</th>
                      <th className="text-right px-5 py-3 font-medium">Likes</th>
                      <th className="text-right px-5 py-3 font-medium">Bookmarks</th>
                      <th className="text-right px-5 py-3 font-medium">Eng Rate</th>
                      <th className="text-right px-5 py-3 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tweets.map((t) => (
                      <tr key={t.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface-2)] transition-colors">
                        <td className="px-5 py-3 max-w-xs">
                          {t.tweetUrl ? (
                            <a
                              href={t.tweetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={t.text}
                              className="text-[var(--text-2)] hover:text-[var(--text)] truncate block transition-colors"
                            >
                              {t.text.slice(0, 80)}{t.text.length > 80 ? "…" : ""}
                            </a>
                          ) : (
                            <span title={t.text} className="text-[var(--text-2)] truncate block">
                              {t.text.slice(0, 80)}{t.text.length > 80 ? "…" : ""}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right num font-semibold text-[var(--text)]">{fmt(t.views)}</td>
                        <td className="px-5 py-3 text-right num text-[var(--text-2)]">{t.likes.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right num text-[var(--text-2)]">{t.bookmarks.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right num font-semibold" style={{ color: engColor(t.engRate) }}>{t.engRate}%</td>
                        <td className="px-5 py-3 text-right num text-[var(--text-3)] text-[12px]">{t.postedAt ? fmtDate(t.postedAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Top 10 */}
            <div className="flex-[2] panel overflow-hidden">
              <div className="p-5 border-b border-[var(--line)]">
                <span className="eyebrow">Top 10 Tweets</span>
              </div>
              <div>
                {tweets.slice(0, 10).map((t, i) => (
                  <div key={t.id} className="flex items-start gap-3 px-5 py-3 border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface-2)] transition-colors">
                    <span className="num text-[13px] font-semibold w-6 shrink-0" style={{ color: i < 3 ? "var(--up)" : "var(--text-3)" }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-[var(--text-2)] truncate">{t.text.slice(0, 60)}{t.text.length > 60 ? "…" : ""}</p>
                    </div>
                    <span className="num text-[13px] font-semibold shrink-0" style={{ color: i < 3 ? "var(--up)" : "var(--text)" }}>
                      {fmt(t.views)}
                    </span>
                  </div>
                ))}
                {tweets.length === 0 && (
                  <EmptyState title="No tweet data yet" hint="Performance shows up here once tweets are tracked." />
                )}
              </div>
            </div>
          </div>

          {/* Heatmap */}
          <div className="panel overflow-hidden">
            <div className="p-5 border-b border-[var(--line)]">
              <span className="eyebrow">Best Posting Times</span>
              <p className="text-[12px] text-[var(--text-3)] mt-1.5">Average views by day and hour posted (UTC)</p>
            </div>
            <div className="p-5 overflow-x-auto">
              <div className="inline-block min-w-full">
                {/* Hour labels */}
                <div className="flex items-center mb-1 ml-10">
                  {Array.from({ length: 24 }).map((_, h) => (
                    <div key={h} className="w-5 shrink-0 text-center">
                      {[0, 6, 12, 18, 23].includes(h) ? (
                        <span className="num text-[9px] text-[var(--text-3)]">{h}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
                {/* Grid */}
                {DAYS.map((day, d) => (
                  <div key={d} className="flex items-center gap-1 mb-1">
                    <span className="text-[10px] text-[var(--text-3)] w-8 shrink-0 text-right pr-2">{day}</span>
                    {Array.from({ length: 24 }).map((_, h) => {
                      const cell = heatmapLookup[`${d}-${h}`];
                      return (
                        <div
                          key={h}
                          className="w-5 h-5 rounded-sm shrink-0"
                          style={{ background: cellColor(cell?.avgViews || 0) }}
                          title={cell ? `${cell.count} tweet${cell.count > 1 ? "s" : ""}, avg ${fmt(cell.avgViews)} views` : "No data"}
                        />
                      );
                    })}
                  </div>
                ))}
                {/* Legend */}
                <div className="flex items-center gap-2 mt-3 ml-10">
                  <span className="text-[10px] text-[var(--text-3)]">Less</span>
                  {HEAT_LEGEND.map((c) => (
                    <div key={c} className="w-4 h-4 rounded-sm" style={{ background: c }} />
                  ))}
                  <span className="text-[10px] text-[var(--text-3)]">More</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
