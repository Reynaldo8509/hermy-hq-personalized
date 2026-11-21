import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildTaskRequest, incidentResolutionError } from "@/lib/phase2-domain.mjs";
import { requireHumanActor } from "@/lib/human-auth";
import { createQueueRequest, QueueRequestError, readIdempotencyKey } from "@/lib/queue-request";
import { classifyDispatchRisk, safeReadOnlyOperation } from "@/lib/command-center-domain.mjs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ fingerprint: string }> }) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const { fingerprint } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  if (!["diagnose", "delegate"].includes(action)) return NextResponse.json({ error: "action debe ser diagnose|delegate" }, { status: 400 });

  try {
    const incidents = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT id, fingerprint, incident, evidence, cause, hypothesis, remediation FROM \"IncidentMemory\" WHERE fingerprint=$1 AND status NOT IN ('resolved','closed') ORDER BY updated_at DESC LIMIT 1",
      fingerprint,
    );
    const incident = incidents[0];
    if (!incident) return NextResponse.json({ error: "La incidencia no está activa o no existe" }, { status: 404 });

    const agentId = action === "diagnose" ? "max" : String(body.agentId || "");
    const title = String(body.title || ((action === "diagnose" ? "Diagnóstico · " : "Delegación · ") + String(incident.incident || fingerprint))).slice(0, 200);
    const prompt = action === "diagnose"
      ? "Diagnóstico de solo lectura. No ejecutes cambios, comandos administrativos ni acciones externas.\nIncidente: " + incident.incident + "\nFingerprint: " + fingerprint + "\nEvidencia registrada: " + incident.evidence + "\nCausa previa: " + incident.cause + "\nHipótesis previa: " + incident.hypothesis + "\nDevuelve evidencia, causa confirmada o incertidumbre, validación y siguiente paso."
      : String(body.prompt || "").trim() + "\n\nContexto de incidencia " + fingerprint + ":\n" + String(incident.evidence || "");
    let spec;
    try {
      spec = buildTaskRequest(agentId, title, prompt, body.requiresApproval === true, Array.isArray(body.dependsOn) ? body.dependsOn.map(String) : []);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Tarea no válida" }, { status: 400 });
    }
    const operation = safeReadOnlyOperation(spec.kind);
    const decision = classifyDispatchRisk({ kind: spec.kind, action: operation?.action, capability: operation?.capability, clientFlag: spec.sideEffecting || body.requiresApproval === true, prompt: action === "diagnose" ? "read-only incident diagnosis" : String(body.prompt || "") });
    spec.sideEffecting = decision.requiresApproval;
    spec.status = decision.requiresApproval ? "awaiting_approval" : "queued";
    const key = readIdempotencyKey(req, body);
    const queued = await createQueueRequest({
      key, actor: auth.actor, origin: spec.origin, kind: spec.kind, title: spec.title,
      prompt: spec.prompt, sideEffecting: spec.sideEffecting, status: spec.status, dependsOn: spec.dependsOn, action: decision.action, capability: decision.capability,
      clientRequestedApproval: body.requiresApproval === true,
    });

    if (!queued.duplicate) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "UPDATE \"IncidentMemory\" SET request_id=$1, agent=$2, status=CASE WHEN status='open' THEN 'investigating' ELSE status END, updated_at=now() WHERE fingerprint=$3 AND status NOT IN ('resolved','closed')",
          queued.request.id, agentId, fingerprint,
        );
        await tx.agentEvent.create({
          data: { kind: "incident", title: action === "diagnose" ? "Diagnóstico solicitado" : "Tarea delegada para incidencia", detail: String(incident.incident || fingerprint), agent: agentId, level: "info", meta: { requestId: queued.request.id, incidentFingerprint: fingerprint, action, actor: auth.actor } },
        });
      });
    }
    return NextResponse.json({ request: queued.request, duplicate: queued.duplicate, action, agentId }, { status: queued.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof QueueRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && ["Agente desconocido", "Indica un título y una descripción"].includes(error.message)) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Incident task creation failed:", error);
    return NextResponse.json({ error: "No se pudo crear la tarea de incidencia" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ fingerprint: string }> }) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const { fingerprint } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const evidence = String(body.evidence || "").trim().slice(0, 4000);
  const validation = String(body.validation || "").trim().slice(0, 4000);
  const problem = incidentResolutionError(evidence, validation);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const requestId = String(body.requestId || "").trim();
  if (requestId) {
    const request = await prisma.agentRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "done" || !request.result?.trim()) {
      return NextResponse.json({ error: "El resultado enlazado no tiene evidencia terminada; agrega validación independiente" }, { status: 409 });
    }
  }
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      "SELECT id FROM \"IncidentMemory\" WHERE fingerprint=$1 LIMIT 1",
      fingerprint,
    );
    const changed = await tx.$executeRawUnsafe(
      "UPDATE \"IncidentMemory\" SET status='resolved', validation=COALESCE(validation,'') || E'\\nValidación humana: ' || $1 || E'\\nEvidencia: ' || $2, closed_at=now(), updated_at=now() WHERE fingerprint=$3 AND status NOT IN ('resolved','closed')",
      validation, evidence, fingerprint,
    );
    if (!changed) return existing.length ? -1 : 0;
    await tx.agentEvent.create({
      data: { kind: "incident", title: "Incidencia validada y resuelta", detail: evidence, agent: "hermes", level: "up", meta: { incidentFingerprint: fingerprint, requestId: requestId || null, actor: auth.actor, validation } },
    });
    return changed;
  });
  if (!result) return NextResponse.json({ error: "La incidencia no existe" }, { status: 404 });
  if (result < 0) return NextResponse.json({ ok: true, duplicate: true, fingerprint, rowsResolved: 0 });
  return NextResponse.json({ ok: true, fingerprint, rowsResolved: result, actor: auth.actor, requestId: requestId || null });
}
