// @ts-check

const office = {
  working: { glow: "shadow-[0_0_16px_3px_rgba(251,146,60,0.3)]", dot: "bg-orange-400", bg: "bg-orange-900/20 border-orange-500/30", ring: "rgba(251,146,60,0.5)" },
  idle: { glow: "shadow-[0_0_12px_2px_rgba(251,191,36,0.2)]", dot: "bg-yellow-400", bg: "bg-yellow-900/20 border-yellow-500/30" },
  error: { glow: "shadow-[0_0_12px_2px_rgba(248,113,113,0.3)]", dot: "bg-red-400", bg: "bg-red-900/20 border-red-500/30" },
  offline: { glow: "", dot: "bg-neutral-600", bg: "bg-neutral-800/20 border-neutral-700/20" },
  online: { glow: "shadow-[0_0_12px_3px_rgba(56,189,248,0.2)]", dot: "bg-sky-400", bg: "bg-sky-900/20 border-sky-500/30" },
  active: { glow: "shadow-[0_0_16px_3px_rgba(52,211,153,0.3)]", dot: "bg-emerald-400", bg: "bg-emerald-900/20 border-emerald-500/30", ring: "rgba(52,211,153,0.5)" },
  mixed: { glow: "shadow-[0_0_12px_3px_rgba(251,146,60,0.2)]", dot: "bg-orange-400", bg: "bg-orange-900/20 border-orange-500/30" },
  paused: { glow: "shadow-[0_0_12px_3px_rgba(167,139,250,0.2)]", dot: "bg-violet-400", bg: "bg-violet-900/20 border-violet-500/30" },
  unknown: { glow: "shadow-[0_0_12px_3px_rgba(244,114,182,0.2)]", dot: "bg-pink-400", bg: "bg-pink-900/20 border-pink-500/30" },
  completed: { glow: "shadow-[0_0_12px_2px_rgba(251,191,36,0.2)]", dot: "bg-yellow-400", bg: "bg-yellow-900/20 border-yellow-500/30" },
};

/** @typedef {{ color: string, dot: string, label: string, pulse?: boolean, office: { glow: string, dot: string, bg: string, ring?: string } }} AgentStatusVisual */
/** @type {Record<string, AgentStatusVisual>} */
export const AGENT_STATUS_VISUALS = {
  idle: { color: "var(--warn)", dot: "var(--warn)", label: "Idle · sin tarea", office: office.idle },
  working: { color: "#fb923c", dot: "#fb923c", label: "Working", pulse: true, office: office.working },
  error: { color: "var(--down)", dot: "var(--down)", label: "Error", office: office.error },
  offline: { color: "var(--text-3)", dot: "var(--text-4)", label: "Offline", office: office.offline },
  online: { color: "#38bdf8", dot: "#38bdf8", label: "Online", office: office.online },
  active: { color: "var(--up)", dot: "var(--up)", label: "Active", pulse: true, office: office.active },
  mixed: { color: "#fb923c", dot: "#fb923c", label: "Partial", office: office.mixed },
  paused: { color: "#a78bfa", dot: "#a78bfa", label: "Paused", office: office.paused },
  unknown: { color: "#f472b6", dot: "#f472b6", label: "Unknown", office: office.unknown },
  completed: { color: "var(--warn)", dot: "var(--warn)", label: "Completed", office: office.completed },
};

/** @param {unknown} status */
export function getAgentStatusVisual(status) {
  return typeof status === "string" && Object.hasOwn(AGENT_STATUS_VISUALS, status)
    ? AGENT_STATUS_VISUALS[/** @type {keyof typeof AGENT_STATUS_VISUALS} */ (status)]
    : AGENT_STATUS_VISUALS.unknown;
}
