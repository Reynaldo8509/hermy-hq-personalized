import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface AgentChatRequest {
  agentId: string;
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

interface AgentChatResponse {
  reply: string;
  agentId: string;
  requestId?: string;
  status?: string;
}

const MAX_CHIEF_OF_STAFF_PROMPT = `You are Max, the user's Chief of Staff and operational lead for the Hermy HQ team.

Own the request from assessment through completion. Prioritize the user's real goals, turn ambiguity into a short plan, and use the Hermes tools and delegation capability when they materially help. Track outcomes, blockers, and concrete next actions. For operational or technical tasks, inspect the real system before claiming a result.

Codex is quota-limited and is a last resort. You alone may delegate to Codex, only when the user explicitly requested a concrete source-code, configuration, database, or infrastructure change that cannot be handled by another specialist. Never use Codex for read-only research, diagnosis, routine operations, Home Assistant, or advice. State the specific technical change and why no other specialist can do it. Do not use direct Codex queue commands or APIs. Delegate research to Atlas with hermy-hq post /api/hermes/dispatch and delegate approved defensive security work to Aegis; never delegate Codex through that API. Do not claim a task is complete until its result is visible.

Delegate research to Atlas with hermy-hq post /api/hermes/dispatch '{"kind":"atlas.research","title":"short title","prompt":"precise read-only research request","sideEffecting":false}'. Delegate an authorized security task to Aegis with the same command and kind "aegis.security", but set sideEffecting to true so example-user must approve it first. Do not claim that Atlas or Aegis finished until their report appears in your inbox.

Respond in Spanish, lead with the outcome, and use this concise structure when useful: Summary, Work completed/delegated, Decisions or blockers, Next action.

User request:`;

const SPECIALIST_CONFIG = {
  atlas: {
    name: "Atlas",
    emoji: "🗺️",
    role: "Technical Research · Evidence & Plans",
    kind: "atlas.research",
    sideEffecting: false,
    prompt: `You are Atlas, the rigorous technical-research specialist on example-user's Hermy HQ team. Produce a substantial Spanish report that supports a real decision, never a vague short answer. Define scope and method; prefer primary authoritative sources; record exact URLs, titles, and access dates for sources actually consulted; distinguish CONFIRMED FACTS, INFERENCES, RECOMMENDATIONS, and UNVERIFIED/CONTRADICTORY points; reconcile conflicts; and include executive conclusion, detailed evidence-backed findings, implications, prioritized recommendation, limitations, and a source register. Do not modify files, services, settings, data, or remote systems. Consult local procedures, manuals, prior decisions, or project context only when necessary, using the bounded read-only search python3 $HOME/.hermes/tools/atlas_local_search.py with a focused query. The canonical library is $HOME/.hermes/knowledge-base, mapped to the second microSD at /mnt/hermes_data/Hermes-Documents. Read only matching text/PDF excerpts and exclude images, video, audio, binaries, and base64 by default. Verify every cited path/URL was actually consulted and state unavailable evidence explicitly. You report to Max, the Chief of Staff.

User request:`,
  },
  aegis: {
    name: "Aegis",
    emoji: "🛡️",
    role: "Cybersecurity · Authorized Defense",
    kind: "aegis.security",
    sideEffecting: true,
    prompt: `You are Aegis, the cybersecurity specialist on example-user's Hermy HQ team. Work only on systems, networks, accounts, and software that the user owns or has explicitly authorized, and stay within the stated target and scope. Favor defensive assessment, hardening, evidence, and reversible recommendations. Do not target third parties, evade controls, steal credentials, disrupt services, or provide harmful exploitation. This request passed the required human approval gate; if the target or authorization is still unclear, stop and ask for it. Finish in Spanish with: scope, evidence, risk, recommended remediation, and blockers. You report to Max, the Chief of Staff.\n\nApproved user request:`,
  },
  pulse: {
    name: "Pulse",
    emoji: "📣",
    role: "Social Media & YouTube Strategy",
    kind: "pulse.social",
    sideEffecting: false,
    prompt: "Pulse social-media and YouTube strategy specialist. Analyze trends, content opportunities, calendars, SEO, and performance using verified context. Never invent metrics. Produce recommendations and drafts only; never publish, send, delete, schedule, or change external accounts. Any external side effect requires Hermy HQ approval. Report in Spanish with opportunity, evidence, recommended action, draft/plan, and blockers.",
  },
  ledger: {
    name: "Ledger", emoji: "🧰", role: "Operations & Continuity · Backups, Git, Health", kind: "ledger.operations", sideEffecting: false,
    prompt: "You are Ledger, the operations and continuity specialist. Supervise scheduled backups, backup freshness and recoverability, Git repository errors, commits, branches and main-branch health, and recurring operational errors from every Hermy HQ agent. Inspect only verified system context. You may autonomously repair only local, reversible, low-risk service failures and must report the evidence and validation. Never delete data, mutate backups, commit or push Git, install/update software, change credentials/access/network policy, or reboot a host without explicit user approval. Do not discuss, calculate, or execute finance, trading, investment, PnL, markets, or risk-management work; explicitly refuse those requests as out of scope. Produce an evidence-based Spanish report with status, evidence, impact, remediation performed, validation, and blockers.",
  },
  domus: {
    name: "Domus", emoji: "🏠", role: "Home Automation · Home Assistant & Alexa", kind: "domus.home", sideEffecting: false,
    prompt: "You are Domus, the home-automation specialist and supervisor of Home Assistant, Alexa, and connected household services. Review integration health, devices, automations, scenes, routines, and safe home-status information using verified context. Never invent device state. Read-only audits and recommendations are allowed. Never unlock, disarm, purchase, change security settings, or actuate a physical device without explicit Hermy HQ approval; any such action must be separately queued for approval. Report in Spanish with status, evidence, recommended action, safety note, and blockers. You report to Max.",
  },
  codex: {
    name: "Codex",
    emoji: "🛠️",
    role: "Privileged VPS Engineering Worker · Autonomous Execution",
    kind: "codex.engineering",
    sideEffecting: false,
    prompt: "",
  },
} as const;

type SpecialistId = keyof typeof SPECIALIST_CONFIG;

async function queueSpecialist(agentId: SpecialistId, message: string) {
  const specialist = SPECIALIST_CONFIG[agentId];
  const title = `${specialist.name} · ${message.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  const now = new Date();
  const pulseSideEffect = agentId === "pulse" &&
    /\b(publicar|public|publish|send|enviar|post|tweet|programar|schedule|subir|upload|borrar|delete|remove)\b/i.test(message);
  const operationalSideEffect = agentId === "domus" &&
    /\b(turn on|turn off|encender|apagar|unlock|desbloquear|disarm|desarmar|buy|comprar|activate|activar|deactivate|desactivar|set temperature|cambiar temperatura)\b/i.test(message);
  const sideEffecting = specialist.sideEffecting || pulseSideEffect || operationalSideEffect;
  const status = sideEffecting ? "awaiting_approval" : "queued";
  const prompt = agentId === "codex"
    ? message.trim()
    : `${specialist.prompt}\n\n${message.trim()}`;
  const request = await prisma.agentRequest.create({
    data: {
      origin: agentId,
      kind: specialist.kind,
      title,
      prompt,
      sideEffecting,
      status,
    },
  });

  const existing = await prisma.agentState.findUnique({ where: { id: agentId } });
  const recentActivity = (existing?.recentActivity as Array<{ timestamp: string; action: string }>) || [];
    const awaiting = sideEffecting;
  await prisma.$transaction([
    prisma.agentEvent.create({
      data: {
        kind: "run",
        title: `${specialist.name} task ${awaiting ? "awaiting approval" : "queued"}: ${title}`,
        agent: agentId,
        level: "info",
        meta: { requestId: request.id, requiresApproval: awaiting },
      },
    }),
    prisma.agentState.upsert({
      where: { id: agentId },
      update: {
        status: awaiting ? "idle" : "working",
        currentTask: awaiting ? `Awaiting approval: ${title}` : title,
        lastActive: now,
        recentActivity: [{ timestamp: now.toISOString(), action: awaiting ? "Awaiting human approval" : "Queued through Hermes" }, ...recentActivity.slice(0, 19)],
      },
      create: {
        id: agentId,
        name: specialist.name,
        emoji: specialist.emoji,
        role: specialist.role,
        status: awaiting ? "idle" : "working",
        currentTask: awaiting ? `Awaiting approval: ${title}` : title,
        lastActive: now,
        tasksCompleted: 0,
        totalCost: 0,
        recentActivity: [{ timestamp: now.toISOString(), action: awaiting ? "Awaiting human approval" : "Queued through Hermes" }],
      },
    }),
  ]);
  return request;
}

async function readMaxInbox() {
  const messages = await prisma.agentBusMessage.findMany({
    where: { toAgent: "max", read: false },
    orderBy: { timestamp: "asc" },
    take: 10,
  });
  if (!messages.length) return "";

  await prisma.agentBusMessage.updateMany({
    where: { id: { in: messages.map((entry) => entry.id) } },
    data: { read: true },
  });

  return messages
    .map((entry) => "[" + entry.fromAgent + " · " + entry.type + "] " + entry.content)
    .join("\n\n");
}

async function queueMax(message: string) {
  const title = `Max · ${message.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  const now = new Date();
  const inbox = await readMaxInbox();
  const request = await prisma.agentRequest.create({
    data: {
      origin: "max",
      kind: "max.chief-of-staff",
      title,
      prompt: MAX_CHIEF_OF_STAFF_PROMPT +
        (inbox ? "\n\nUnread reports delivered to you:\n" + inbox : "") +
        "\n\n" + message.trim(),
      sideEffecting: false,
      status: "queued",
    },
  });

  await prisma.agentState.upsert({
    where: { id: "max" },
    update: { status: "working", currentTask: title, lastActive: now },
    create: {
      id: "max",
      name: "Max",
      emoji: "🐺",
      role: "CEO Corner · Chief of Staff",
      status: "working",
      currentTask: title,
      lastActive: now,
      tasksCompleted: 0,
      totalCost: 0,
      recentActivity: [],
    },
  });
  return request;
}

export async function POST(request: NextRequest): Promise<NextResponse<AgentChatResponse | { error: string }>> {
  try {
    const body: AgentChatRequest = await request.json();
    const { agentId, message, history = [] } = body;

    if (!agentId || !message?.trim()) {
      return NextResponse.json({ error: "Missing agentId or message" }, { status: 400 });
    }

    if (agentId === "max") {
      const queued = await queueMax(message);
      return NextResponse.json({
        agentId,
        requestId: queued.id,
        status: queued.status,
        reply: "Estoy coordinando esta solicitud con Hermes. Te mostraré el resultado cuando termine.",
      });
    }

    if (agentId === "codex") {
      return NextResponse.json({ error: "Codex solo puede ser delegado por Max cuando un cambio técnico concreto lo haga estrictamente necesario" }, { status: 403 });
    }

    if (!(agentId in SPECIALIST_CONFIG)) {
      return NextResponse.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }
    const queued = await queueSpecialist(agentId as SpecialistId, message);
    const waitsForApproval = queued.status === "awaiting_approval";
    return NextResponse.json({
      agentId,
      requestId: queued.id,
      status: queued.status,
      reply: waitsForApproval
        ? `Registré la tarea de ${SPECIALIST_CONFIG[agentId as SpecialistId].name}. Requiere tu aprobación antes de ejecutarse; podrás aprobarla en Hermes → Dispatches.`
        : `${SPECIALIST_CONFIG[agentId as SpecialistId].name} está trabajando con Hermes. Te mostraré el informe cuando termine.`,
    });
  } catch (error) {
    console.error("Agent chat error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
