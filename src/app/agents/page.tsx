"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { signIn } from "next-auth/react";
import OfficeView from "@/components/OfficeView";

interface AgentActivity {
  timestamp: string;
  action: string;
  result?: string;
}

interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  status: "idle" | "working" | "error" | "offline" | "online" | "active" | "mixed" | "paused";
  currentTask?: string;
  lastActive?: string;
  tasksCompleted: number;
  totalCost: number;
  recentActivity: AgentActivity[];
  provider?: string;
  model?: string;
  selection?: string;
  runtimeProvider?: string;
  circuit?: { open?: boolean; activeAgent?: string; reason?: string; openedAt?: number; failoverAt?: number; nextProbeAt?: number; taskId?: string; taskTitle?: string; fallbackFailed?: boolean };
}

interface AgentChatResponse {
  reply?: string;
  requestId?: string;
}

interface AgentRequestStatus {
  request: { status: string; result?: string | null; error?: string | null };
}

const statusConfig: Record<string, { color: string; dot: string; label: string; pulse?: boolean }> = {
  idle: { color: "var(--warn)", dot: "var(--warn)", label: "Idle" },
  working: { color: "var(--accent)", dot: "var(--accent)", label: "Working", pulse: true },
  error: { color: "var(--down)", dot: "var(--down)", label: "Error" },
  offline: { color: "var(--text-3)", dot: "var(--text-4)", label: "Offline" },
  online: { color: "var(--up)", dot: "var(--up)", label: "Online", pulse: true },
  active: { color: "var(--up)", dot: "var(--up)", label: "Active", pulse: true },
  mixed: { color: "var(--warn)", dot: "var(--warn)", label: "Partial" },
  paused: { color: "var(--text-3)", dot: "var(--text-4)", label: "Paused" },
};

const roleColors: Record<string, string> = {
  max: "from-amber-500/20 to-amber-600/5 border-amber-500/20",
  codex: "from-blue-500/20 to-blue-600/5 border-blue-500/20",
  atlas: "from-sky-500/20 to-sky-600/5 border-sky-500/20",
  aegis: "from-emerald-500/20 to-emerald-600/5 border-emerald-500/20",
  milo: "from-violet-500/20 to-violet-600/5 border-violet-500/20",
  pulse: "from-pink-500/20 to-pink-600/5 border-pink-500/5",
  ledger: "from-orange-500/20 to-orange-600/5 border-orange-500/20",
  domus: "from-teal-500/20 to-teal-600/5 border-teal-500/20",
};

const ICON_CHOICES: Record<string, string[]> = {
  max: ["🧭", "🐺", "🧠", "🎯"],
  codex: ["⚙️", "🛠️", "💻", "🔧"],
  atlas: ["🔭", "🗺️", "📚", "🧪"],
  aegis: ["🛡️", "🔐", "🛰️", "⚔️"],
  milo: ["📡", "📬", "✉️", "🕊️"],
  pulse: ["📣", "📱", "🎬", "📈"],
  ledger: ["🧰", "🔧", "🗂️", "✅"],
  domus: ["🏠", "💡", "🔊", "🌡️"],
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AgentCard({ agent, isExpanded, onToggle, onControl, onStop, onConnectMilo, onSetIcon }: {
  agent: Agent;
  isExpanded: boolean;
  onToggle: () => void;
  onControl: (agent: Agent) => void;
  onStop: (agent: Agent) => void;
  onConnectMilo: () => void;
  onSetIcon: (agent: Agent, emoji: string) => void;
}) {
  const status = statusConfig[agent.status] || statusConfig.offline;

  return (
    <div className="panel panel-interactive overflow-hidden">
      {/* Main card */}
      <div className="p-5 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start gap-3.5">
          {/* Avatar */}
          <div className="w-12 h-12 rounded-[var(--r-md)] flex items-center justify-center text-2xl shrink-0 animate-[agent-bob_1.8s_ease-in-out_infinite]"
            style={{ animationDelay: `${["max", "codex", "atlas", "aegis", "milo"].indexOf(agent.id) * 0.16}s`, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
            {agent.emoji}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="relative flex w-2 h-2 shrink-0">
                {status.pulse && <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: status.dot }} />}
                <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: status.dot }} />
              </span>
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{agent.name}</h3>
              <span className="text-[10px] font-medium" style={{ color: status.color }}>{status.label}</span>
            </div>
            <p className="text-[12px] text-[var(--text-3)] mt-1">{agent.role}</p>
            {agent.model && (
              <div className="mt-2 text-[10px] leading-4 text-[var(--text-4)]">
                <span className="text-[var(--text-3)]">Modelo:</span> {agent.model}
                {agent.provider && <> · <span className="text-[var(--text-3)]">Proveedor:</span> {agent.provider}</>}
                {agent.selection && <div className="truncate" title={agent.selection}>Selección: {agent.selection}</div>}
                {agent.runtimeProvider && <div>Worker runtime: {agent.runtimeProvider}</div>}
                {agent.id === "codex" && agent.circuit && (
                  <div className="mt-1 rounded border border-[var(--line)] px-2 py-1.5">
                    <div className={agent.circuit.open ? "text-amber-300" : "text-emerald-300"}>
                      Circuito: {agent.circuit.open ? "abierto · fallback activo" : "cerrado · primario activo"}
                    </div>
                    {agent.circuit.open && agent.circuit.reason && <div className="truncate" title={agent.circuit.reason}>Causa: {agent.circuit.reason}</div>}
                    {agent.circuit.open && agent.circuit.taskTitle && <div className="truncate" title={agent.circuit.taskTitle}>Tarea: {agent.circuit.taskTitle}</div>}
                    {agent.circuit.open && agent.circuit.nextProbeAt && <div>Próxima prueba: {new Date(agent.circuit.nextProbeAt).toLocaleString()}</div>}
                  </div>
                )}
              </div>
            )}

            {/* Current task */}
            {agent.currentTask && agent.status === "working" && (
              <p className="text-[12px] mt-2 truncate" style={{ color: "var(--accent)" }}>{agent.currentTask}</p>
            )}
          </div>

          {/* Stats */}
          <div className="text-right shrink-0">
            <div className="num text-[22px] font-semibold text-[var(--text)] leading-none">{agent.tasksCompleted}</div>
            <div className="eyebrow mt-1.5">tasks</div>
            {agent.lastActive && (
              <div className="num text-[10px] text-[var(--text-4)] mt-1">{timeAgo(agent.lastActive)}</div>
            )}
          </div>
        </div>
      </div>

      <div className="px-5 pb-4 flex items-center gap-2" style={{ borderTop: "1px solid var(--line)" }}>
        <button
          type="button"
          onClick={() => onControl(agent)}
          className="rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors"
          style={{
            color: agent.status === "paused" ? "var(--up)" : "var(--warn)",
            background: agent.status === "paused" ? "color-mix(in srgb, var(--up) 10%, transparent)" : "color-mix(in srgb, var(--warn) 10%, transparent)",
            border: `1px solid ${agent.status === "paused" ? "color-mix(in srgb, var(--up) 24%, transparent)" : "color-mix(in srgb, var(--warn) 24%, transparent)"}`,
          }}
        >
          {agent.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button type="button" onClick={(event) => { event.stopPropagation(); onStop(agent); }}
          className="rounded-full px-3 py-1.5 text-[11px] font-semibold text-red-300 transition-colors"
          style={{ background: "color-mix(in srgb, #ef4444 12%, transparent)", border: "1px solid color-mix(in srgb, #ef4444 30%, transparent)" }}>
          Detener y limpiar
        </button>
        {agent.id === "milo" && (
          <button
            type="button"
            onClick={onConnectMilo}
            className="rounded-full px-3 py-1.5 text-[11px] font-medium text-[var(--accent)] transition-colors"
            style={{ background: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)" }}
          >
            Connect Gmail
          </button>
        )}
        <select
          value={agent.emoji}
          aria-label={`Change ${agent.name} icon`}
          onChange={(event) => onSetIcon(agent, event.target.value)}
          className="ml-auto rounded-full px-2 py-1 text-[14px] bg-[var(--surface-2)] text-[var(--text)]"
          style={{ border: "1px solid var(--line)" }}
        >
          {(ICON_CHOICES[agent.id] || [agent.emoji]).map((icon) => <option key={icon} value={icon}>{icon}</option>)}
        </select>
        <span className="text-[10px] text-[var(--text-4)]">Queue bypass while paused</span>
      </div>

      {/* Expanded activity feed */}
      {isExpanded && (
        <div className="px-5 py-4 space-y-2.5" style={{ borderTop: "1px solid var(--line)" }}>
          <h4 className="eyebrow">Recent Activity</h4>
          {agent.recentActivity.length === 0 ? (
            <p className="text-[12px] text-[var(--text-3)] py-2">No activity yet</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {agent.recentActivity.slice(0, 10).map((activity, i) => (
                <div key={i} className="flex items-start gap-2.5 text-[12px]">
                  <span className="num text-[var(--text-4)] shrink-0 w-14">{timeAgo(activity.timestamp)}</span>
                  <span className="text-[var(--text-2)]">{activity.action}</span>
                  {activity.result && (
                    <span className="text-[var(--text-3)] ml-auto truncate max-w-[200px]">{activity.result}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Live Agent Chat ───────────────────────────────────────
function AgentChat({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<{ role: "user"|"assistant"; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function waitForRequest(id: string): Promise<string> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response = await fetch(`/api/hermes/requests/${id}`);
      if (!response.ok) throw new Error("Could not retrieve Max's request");
      const data = await response.json() as AgentRequestStatus;
      if (data.request.status === "done") return data.request.result || "Max completed the request without a written result.";
      if (data.request.status === "awaiting_approval") {
        return "Esta tarea espera tu aprobación en Hermes → Dispatches. No se ejecutará hasta que la apruebes.";
      }
      if (["failed", "rejected"].includes(data.request.status)) {
        return `Max could not complete this request: ${data.request.error || data.request.status}.`;
      }
    }
    return "Max is still working. Open Hermes → Dispatches to follow this request.";
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const newMsgs = [...msgs, { role: "user" as const, content: text }];
    setMsgs(newMsgs);
    setLoading(true);
    try {
      const r = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, message: text, history: msgs }),
      });
      const d = await r.json() as AgentChatResponse;
      if (!r.ok || !d.reply) throw new Error("Agent chat request failed");
      setMsgs([...newMsgs, { role: "assistant", content: d.reply }]);
      if (d.requestId) {
        const result = await waitForRequest(d.requestId);
        setMsgs(current => [...current, { role: "assistant", content: result }]);
      }
    } catch {
      setMsgs([...newMsgs, { role: "assistant", content: "Sorry, something went wrong. Try again." }]);
    }
    setLoading(false);
  }

  const agentColor = roleColors[agent.id]?.split(" ")[0]?.replace("from-","text-")?.replace("/20","") || "text-[var(--text-3)]";

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="elevated w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="text-2xl">{agent.emoji}</div>
          <div>
            <div className="text-[14px] font-semibold text-[var(--text)]">{agent.name}</div>
            <div className="text-[12px] text-[var(--text-3)]">{agent.role}</div>
          </div>
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)] transition-colors text-xl leading-none">×</button>
        </div>
        {/* Messages */}
        <div className="h-80 overflow-y-auto p-4 space-y-3 flex flex-col" style={{ background: "var(--surface-1)" }}>
          {msgs.length === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[var(--text-3)] text-[13px] text-center">
                {agent.id === "max"
                  ? "Ask Max to prioritize, coordinate, delegate, or execute work through Hermes."
                  : agent.id === "codex"
                    ? "Describe an engineering change for Codex. It will wait for your approval before execution."
                    : agent.id === "aegis"
                      ? "Describe an authorized security task. It will wait for your approval before execution."
                  : agent.id === "pulse"
                    ? "Ask Pulse for social-media and YouTube strategy, trends, SEO, or content plans."
                    : "Ask Atlas for technical research, evidence, or an implementation plan."}
              </p>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[80%] rounded-[var(--r-md)] px-3.5 py-2 text-[13px] leading-relaxed"
                style={m.role === "user"
                  ? { background: "var(--surface-3)", color: "var(--text)" }
                  : { background: "var(--surface-2)", border: "1px solid var(--line)", color: "var(--text-2)" }}>
                {m.role === "assistant" && <span className="text-xs mr-1">{agent.emoji}</span>}
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-[var(--r-md)] px-3.5 py-2" style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                <span className="text-[var(--text-3)] text-[13px]">{agent.emoji} thinking…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {/* Input */}
        <div className="flex gap-2 p-3" style={{ borderTop: "1px solid var(--line)" }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={`Message ${agent.name}…`}
            className="flex-1 rounded-full px-4 py-2 text-[13px] text-[var(--text)] focus:outline-none transition-colors"
            style={{ background: "var(--surface-1)", border: "1px solid var(--line)" }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="btn-primary px-4 py-2 text-[13px]"
          >Send</button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [view, setView] = useState<"cards" | "office">("office");
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  const connectMilo = useCallback(() => {
    void signIn("google", { callbackUrl: "/agents?milo=connected" }, {
      scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "consent",
    });
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch {}
    setLoading(false);
  }, []);

  const controlAgent = useCallback(async (agent: Agent) => {
    await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, action: agent.status === "paused" ? "resume" : "pause" }),
    });
    loadAgents();
  }, [loadAgents]);

  const stopAgent = useCallback(async (agent: Agent) => {
    if (!window.confirm(`¿Cancelar y limpiar las tareas pendientes y en curso de ${agent.name}?`)) return;
    setControlBusy(true);
    try {
      const result = await fetch("/api/agents/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop_agent", agentId: agent.id }) });
      if (!result.ok) window.alert("No se pudo detener el agente. Revisa el estado e inténtalo otra vez.");
    } finally { setControlBusy(false); await loadAgents(); }
  }, [loadAgents]);

  const emergencyReset = useCallback(async () => {
    if (!window.confirm("Parada de emergencia: cancelar todas las tareas pendientes y en curso de todos los bots, incluidas las recibidas de Hermes. Los bots quedarán disponibles. ¿Continuar?")) return;
    setControlBusy(true);
    try {
      const result = await fetch("/api/agents/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "emergency_reset" }) });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) window.alert(data.error || "No se pudo completar la parada de emergencia.");
      else window.alert(`Parada completada: ${data.cancelled} tarea(s) cancelada(s).`);
    } finally { setControlBusy(false); await loadAgents(); }
  }, [loadAgents]);

  const setAgentIcon = useCallback(async (agent: Agent, emoji: string) => {
    await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, action: "set_icon", emoji }),
    });
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    loadAgents();
    const interval = setInterval(loadAgents, 10000); // poll every 10s
    return () => clearInterval(interval);
  }, [loadAgents]);

  if (loading) {
    return (
      <div className="relative min-h-screen p-8">
        <div className="relative z-10 w-full mx-auto grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="sk h-32 rounded-[var(--r-lg)]" />)}
        </div>
      </div>
    );
  }

  const maxAgent = agents.find(a => a.id === "max");
  const teamAgents = agents.filter(a => a.id !== "max");
  const online = agents.filter(a => !["offline", "paused"].includes(a.status)).length;
  const working = agents.filter(a => a.status === "working").length;
  const totalTasks = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);

  return (
    <>
      <div className="relative z-10 w-full mx-auto text-[var(--text)] p-8 pb-16 space-y-8">
      {/* Header */}
      <div className="hq-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2.5">Agent HQ</div>
          <h1 className="text-[32px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Your AI Team</h1>
          <p className="text-[13px] text-[var(--text-3)] mt-3">Working 24/7</p>
          <div className="flex flex-wrap gap-3 mt-4 text-[11px] text-[var(--text-3)]" aria-label="Agent status legend">
            {(["working", "idle", "online", "offline", "error"] as const).map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: statusConfig[key].dot }} />
                {statusConfig[key].label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" disabled={controlBusy} onClick={emergencyReset}
            className="rounded-full px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50"
            style={{ background: "#b91c1c", border: "1px solid #ef4444" }}>
            {controlBusy ? "Procesando…" : "Parada de Emergencia"}
          </button>
          <div className="flex items-center gap-6">
          {/* Stats */}
          <div className="flex gap-7 text-center">
            <div>
              <div className="num text-[22px] font-semibold leading-none" style={{ color: "var(--up)" }}>{online}<span className="text-[var(--text-4)]">/{agents.length}</span></div>
              <div className="eyebrow mt-1.5">Online</div>
            </div>
            <div>
              <div className="num text-[22px] font-semibold leading-none" style={{ color: "var(--accent)" }}>{working}</div>
              <div className="eyebrow mt-1.5">Working</div>
            </div>
            <div>
              <div className="num text-[22px] font-semibold leading-none text-[var(--text)]">{totalTasks}</div>
              <div className="eyebrow mt-1.5">Total Tasks</div>
            </div>
          </div>
          </div>
          {/* View toggle */}
          <div className="flex rounded-full p-1 gap-1" style={{ border: "1px solid var(--line)" }}>
            <button
              onClick={() => setView("office")}
              className={`px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                view === "office"
                  ? "bg-white/[0.08] text-[var(--text)]"
                  : "text-[var(--text-3)] hover:text-[var(--text-2)]"
              }`}
            >
              Office
            </button>
            <button
              onClick={() => setView("cards")}
              className={`px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                view === "cards"
                  ? "bg-white/[0.08] text-[var(--text)]"
                  : "text-[var(--text-3)] hover:text-[var(--text-2)]"
              }`}
            >
              Cards
            </button>
          </div>
        </div>
      </div>

      {/* Live Agent Chat Modal */}
      {chatAgent && <AgentChat agent={chatAgent} onClose={() => setChatAgent(null)} />}

      {/* Office View */}
      {view === "office" && (
        <>
          <OfficeView agents={agents} />
          {/* Chat quick-launch strip */}
          <div className="flex flex-wrap gap-2 pt-2">
            {agents.filter(a => a.id !== "max" && a.status !== "paused").map(a => (
              <button key={a.id} onClick={() => setChatAgent(a)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12px] text-[var(--text-2)] transition-colors panel-interactive"
                style={{ background: "var(--surface-1)", border: "1px solid var(--line)" }}>
                <span>{a.emoji}</span> Chat with {a.name}
              </button>
            ))}
            {agents.find(a => a.id === "max") && (
              <button onClick={() => setChatAgent(agents.find(a => a.id === "max")!)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12px] transition-colors"
                style={{ color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)" }}>
                🐺 Chat with Max
              </button>
            )}
          </div>
        </>
      )}

      {/* Cards View */}
      {view === "cards" && (
        <>
          {/* Chief of Staff (Max) — full width */}
          {maxAgent && (
            <AgentCard
              agent={maxAgent}
              isExpanded={expandedAgent === maxAgent.id}
              onToggle={() => setExpandedAgent(expandedAgent === maxAgent.id ? null : maxAgent.id)}
              onControl={controlAgent}
              onStop={stopAgent}
              onConnectMilo={connectMilo}
              onSetIcon={setAgentIcon}
            />
          )}

          {/* Team grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {teamAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isExpanded={expandedAgent === agent.id}
                onToggle={() => setExpandedAgent(expandedAgent === agent.id ? null : agent.id)}
              onControl={controlAgent}
              onStop={stopAgent}
                onConnectMilo={connectMilo}
                onSetIcon={setAgentIcon}
              />
            ))}
          </div>

          {/* Org chart visual */}
          <div className="pt-6" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="eyebrow mb-5">Team Structure</div>
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2.5 rounded-[var(--r-md)] px-4 py-2.5"
                style={{ background: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)" }}>
                <span className="text-xl">🐺</span>
                <div>
                  <div className="text-[13px] font-semibold text-[var(--text)]">Max</div>
                  <div className="text-[10px] text-[var(--text-3)]">Chief of Staff · Orchestrator</div>
                </div>
              </div>
              <div className="w-px h-6" style={{ background: "var(--line-strong)" }} />
              <div className="flex items-center gap-0">
                <div className="w-32 h-px" style={{ background: "var(--line-strong)" }} />
                <div className="w-px h-4" style={{ background: "var(--line-strong)" }} />
                <div className="w-32 h-px" style={{ background: "var(--line-strong)" }} />
                <div className="w-px h-4" style={{ background: "var(--line-strong)" }} />
                <div className="w-32 h-px" style={{ background: "var(--line-strong)" }} />
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                {teamAgents.map(agent => (
                  <div key={agent.id} className="flex items-center gap-2.5 rounded-[var(--r-md)] px-3.5 py-2.5"
                    style={{ background: "var(--surface-1)", border: "1px solid var(--line)", opacity: agent.status === "offline" ? 0.5 : 1 }}>
                    <span className="text-lg">{agent.emoji}</span>
                    <div>
                      <div className="text-[12px] font-semibold text-[var(--text)]">{agent.name}</div>
                      <div className="text-[10px] text-[var(--text-3)]">{agent.role}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    </>
  );
}
