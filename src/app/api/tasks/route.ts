import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { agentForKind, buildTaskRequest, dependenciesAreDone, taskActionAllowed } from "@/lib/phase2-domain.mjs";
import { classifyDispatchRisk, safeReadOnlyOperation } from "@/lib/command-center-domain.mjs";
import { requireHumanActor } from "@/lib/human-auth";
import { assertDependenciesExist, createQueueRequest, QueueRequestError, readIdempotencyKey, writeActionApproval } from "@/lib/queue-request";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  try {
    const query = new URL(req.url).searchParams;
    const failedOnly = query.get("status") === "failed";
    const defaultLimit = failedOnly ? 50 : 250;
    const maxLimit = failedOnly ? 100 : 250;
    const limitParam = query.get("limit");
    const requestedLimit = limitParam ? Number(limitParam) : defaultLimit;
    const take = Number.isSafeInteger(requestedLimit)
      ? Math.min(maxLimit, Math.max(1, requestedLimit))
      : defaultLimit;
    const requestedOffset = Number(query.get("offset"));
    const skip = Number.isSafeInteger(requestedOffset)
      ? Math.min(100000, Math.max(0, requestedOffset))
      : 0;
    const where = failedOnly ? { status: "failed" } : {};
    const [requests, totalRequests] = await Promise.all([
      prisma.agentRequest.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        skip,
        take,
      }),
      prisma.agentRequest.count({ where }),
    ]);
    const dependencyIds = [...new Set(requests.flatMap((row) => Array.isArray(row.dependsOn) ? row.dependsOn.map(String) : []))];
    const [dependencyRows, events] = await Promise.all([
      dependencyIds.length ? prisma.agentRequest.findMany({
        where: { id: { in: dependencyIds } },
        select: { id: true, title: true, status: true, result: true, error: true },
      }) : Promise.resolve([]),
      prisma.agentEvent.findMany({ orderBy: { createdAt: "desc" }, take: 500 }),
    ]);
    const byId = new Map(dependencyRows.map((row) => [row.id, row]));
    const eventMap = new Map<string, typeof events>();
    for (const event of events) {
      const requestId = String((event.meta as Record<string, unknown> | null)?.requestId || "");
      if (!requestId) continue;
      const current = eventMap.get(requestId) || [];
      if (current.length < 12) current.push(event);
      eventMap.set(requestId, current);
    }
    const normalized = requests.map((row) => {
      const dependencies = (Array.isArray(row.dependsOn) ? row.dependsOn : []).map((id) => byId.get(String(id)) || { id: String(id), status: "missing" });
      const done = dependenciesAreDone(dependencies.map((item) => String(item.id)), byId);
      const durationMs = row.startedAt ? Math.max(0, (row.finishedAt || new Date()).getTime() - row.startedAt.getTime()) : null;
      return {
        ...row,
        agentId: agentForKind(row.kind, row.origin),
        dependencies,
        blockedByDependencies: dependencies.length > 0 && !done,
        durationMs,
        activity: eventMap.get(row.id) || [],
      };
    });
    return NextResponse.json(
      {
        requests: normalized,
        pagination: { filter: failedOnly ? "failed" : "recent", offset: skip, limit: take, total: totalRequests },
        source: "hermy-agent-request",
        syncedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Tasks API error:", error);
    return NextResponse.json({ error: "No se pudo cargar la cola real de Hermy HQ" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const agentId = String(body.agentId || "max").trim().toLowerCase();
    const dependencies = Array.isArray(body.dependsOn) ? body.dependsOn.map(String) : [];
    let spec;
    try {
      spec = buildTaskRequest(agentId, String(body.name || body.title || ""), String(body.prompt || body.description || ""), body.requiresApproval === true, dependencies);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Tarea no válida" }, { status: 400 });
    }
    const operation = safeReadOnlyOperation(spec.kind);
    const decision = classifyDispatchRisk({ kind: spec.kind, action: operation?.action, capability: operation?.capability, clientFlag: spec.sideEffecting || body.requiresApproval === true, prompt: String(body.prompt || body.description || "") });
    spec.sideEffecting = decision.requiresApproval;
    spec.status = decision.requiresApproval ? "awaiting_approval" : "queued";
    const key = readIdempotencyKey(req, body);
    const created = await createQueueRequest({
      key, actor: auth.actor, origin: spec.origin, kind: spec.kind, title: spec.title,
      prompt: spec.prompt, sideEffecting: spec.sideEffecting, status: spec.status, dependsOn: spec.dependsOn, action: decision.action, capability: decision.capability,
      clientRequestedApproval: body.requiresApproval === true,
    });
    return NextResponse.json({ request: created.request, duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof QueueRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && ["Agente desconocido", "Indica un título y una descripción"].includes(error.message)) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Create task error:", error);
    return NextResponse.json({ error: "No se pudo crear la solicitud" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = String(body.id || "").trim();
  const action = String(body.action || "").trim();
  if (!id || !["cancel", "retry", "assign"].includes(action)) return NextResponse.json({ error: "Indica id y action cancel|retry|assign" }, { status: 400 });

  try {
    const existing = await prisma.agentRequest.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Tarea no encontrada" }, { status: 404 });

    if (action === "cancel" && existing.status === "cancelled") return NextResponse.json({ request: existing, duplicate: true });
    if (action === "assign") {
      const agentId = String(body.agentId || "").trim().toLowerCase();
      if (!taskActionAllowed(action, existing.status, existing.sideEffecting)) {
        return NextResponse.json({ error: "Solo se puede reasignar una tarea segura que siga en cola" }, { status: 409 });
      }
      let spec;
      try {
        spec = buildTaskRequest(agentId, String(body.title || existing.title), String(existing.prompt || existing.title), false, Array.isArray(existing.dependsOn) ? existing.dependsOn.map(String) : []);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Agente desconocido" }, { status: 400 });
      }
      const operation = safeReadOnlyOperation(spec.kind);
      const decision = classifyDispatchRisk({ kind: spec.kind, action: operation?.action, capability: operation?.capability, clientFlag: spec.sideEffecting || existing.sideEffecting, prompt: String(existing.prompt || existing.title) });
      spec.sideEffecting = decision.requiresApproval;
      spec.status = decision.requiresApproval ? "awaiting_approval" : "queued";
      if (existing.kind === spec.kind && existing.title === spec.title && existing.action === decision.action && existing.capability === decision.capability) return NextResponse.json({ request: existing, duplicate: true });
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.agentRequest.updateMany({
          where: { id, status: "queued", sideEffecting: false },
          data: { kind: spec.kind, origin: spec.origin, title: spec.title, prompt: spec.prompt, sideEffecting: spec.sideEffecting, action: decision.action, capability: decision.capability, status: spec.status, updatedAt: new Date() },
        });
        if (!changed.count) return null;
        const row = await tx.agentRequest.findUniqueOrThrow({ where: { id } });
        if (decision.requiresApproval) await writeActionApproval(tx, row, auth.actor);
        await tx.agentEvent.create({ data: { kind: "run", title: "Tarea reasignada: " + row.title, agent: agentId, level: decision.requiresApproval ? "warn" : "info", meta: { requestId: id, action: "assign", actor: auth.actor, assignedAgent: agentId, requiresApproval: decision.requiresApproval } } });
        return row;
      });
      return updated ? NextResponse.json({ request: updated }) : NextResponse.json({ error: "La tarea cambió de estado antes de reasignarla" }, { status: 409 });
    }

    if (action === "cancel") {
      if (!taskActionAllowed(action, existing.status, existing.sideEffecting)) return NextResponse.json({ error: "La tarea ya está en ejecución; cancelación no segura" }, { status: 409 });
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.agentRequest.updateMany({
          where: { id, status: { in: ["queued", "approved", "awaiting_approval", "awaiting_destructive_confirmation"] } },
          data: { status: "cancelled", error: "Cancelada desde Action Center por " + auth.actor, finishedAt: new Date(), updatedAt: new Date() },
        });
        if (!changed.count) return null;
        await tx.$executeRawUnsafe(
          'UPDATE "ActionApproval" SET status=\'rejected\', decision=\'rejected\', approved_by=NULL, rejected_by=$1, resolved_by=$1, result=\'cancelled; action not executed\', reason=$4, resolved_at=now() WHERE id=$2 AND request_id=$3 AND status IN (\'pending\',\'rejected\')',
          auth.actor, "approval-" + id, id, "Solicitud cancelada antes de ejecución por " + auth.actor,
        );
        await tx.agentEvent.create({ data: { kind: "run", title: "Tarea cancelada: " + existing.title, agent: agentForKind(existing.kind, existing.origin), level: "warn", meta: { requestId: id, action: "cancel", actor: auth.actor } } });
        return tx.agentRequest.findUniqueOrThrow({ where: { id } });
      });
      return updated ? NextResponse.json({ request: updated }) : NextResponse.json({ error: "La tarea comenzó antes de la cancelación" }, { status: 409 });
    }

    const retryEvents = await prisma.agentEvent.findMany({
      where: { kind: "run", agent: agentForKind(existing.kind, existing.origin) },
      orderBy: { createdAt: "desc" },
      take: 250,
      select: { meta: true },
    });
    const retryCount = retryEvents.filter((event) => {
      const meta = event.meta as Record<string, unknown> | null;
      return meta?.requestId === id && meta?.action === "retry";
    }).length;
    if (!taskActionAllowed(action, existing.status, existing.sideEffecting, retryCount)) {
      return NextResponse.json({ error: "Solo se puede reintentar dos veces una tarea fallida sin efectos laterales" }, { status: 409 });
    }
    const dependencyIds = Array.isArray(existing.dependsOn) ? existing.dependsOn.map(String) : [];
    await assertDependenciesExist(dependencyIds);
    const dependencies = dependencyIds.length ? await prisma.agentRequest.findMany({ where: { id: { in: dependencyIds } }, select: { id: true, status: true } }) : [];
    if (!dependenciesAreDone(dependencyIds, new Map(dependencies.map((row) => [row.id, row])))) {
      return NextResponse.json({ error: "Las dependencias deben completarse antes del reintento" }, { status: 409 });
    }
    const operation = safeReadOnlyOperation(existing.kind);
    const decision = classifyDispatchRisk({
      kind: existing.kind,
      action: operation?.action,
      capability: operation?.capability,
      clientFlag: existing.sideEffecting,
      prompt: String(existing.prompt || existing.title),
    });
    const retryStatus = decision.requiresApproval ? "awaiting_approval" : "queued";
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.agentRequest.updateMany({
        where: { id, status: "failed", sideEffecting: false },
        data: {
          status: retryStatus,
          sideEffecting: decision.requiresApproval,
          action: decision.action,
          capability: decision.capability,
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          decidedAt: null,
          updatedAt: new Date(),
        },
      });
      if (!changed.count) return null;
      const row = await tx.agentRequest.findUniqueOrThrow({ where: { id } });
      if (decision.requiresApproval) await writeActionApproval(tx, row, auth.actor);
      await tx.agentEvent.create({ data: { kind: "run", title: "Reintento controlado: " + existing.title, agent: agentForKind(existing.kind, existing.origin), level: decision.requiresApproval ? "warn" : "info", meta: { requestId: id, action: "retry", actor: auth.actor, retryNo: retryCount + 1, requiresApproval: decision.requiresApproval, riskReasons: decision.reasons } } });
      return row;
    });
    return updated ? NextResponse.json({ request: updated }) : NextResponse.json({ error: "La tarea cambió de estado antes del reintento" }, { status: 409 });
  } catch (error) {
    console.error("Task operation failed:", error);
    return NextResponse.json({ error: "No se pudo completar la operación de tarea" }, { status: 500 });
  }
}
