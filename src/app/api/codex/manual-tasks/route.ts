import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { isEmergencyStopActive } from "@/lib/agent-dispatch";
import { QueueRequestError, readIdempotencyKey, writeActionApproval } from "@/lib/queue-request";
import { sameRequestPayload } from "@/lib/phase2-domain.mjs";
import { codexManualOverrideKey, codexManualOverrideRecord } from "@/lib/codex-manual-override.mjs";
import { codexManualTaskPayload } from "@/lib/codex-manual-task-contract.mjs";
import { codexTaskPolicy } from "../../../../../hermes-bridge/codex-task-contract.mjs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  if (await isEmergencyStopActive()) return NextResponse.json({ error: "Emergency stop activo; no se admiten nuevas tareas de Codex" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const mode = body.mode === "change" ? "change" : body.mode === "audit" ? "audit" : "";
  const title = String(body.title || "").trim().slice(0, 200);
  const payload = String(body.prompt || "").trim().slice(0, 12000);
  if (!mode || title.length < 3 || !payload) return NextResponse.json({ error: "Elige auditoría o cambio e indica título e instrucciones" }, { status: 400 });

  const requestPayload = codexManualTaskPayload({ mode, title, prompt: payload });
  const sideEffecting = requestPayload.sideEffecting;
  const status = requestPayload.status;
  let key: string;
  try { key = readIdempotencyKey(req, body); }
  catch (error) {
    if (error instanceof QueueRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Idempotency-Key no válida" }, { status: 400 });
  }
  const temporaryTask = { id: "pending", ...requestPayload };
  if (!codexTaskPolicy(temporaryTask, status, true).eligible && mode === "audit") {
    return NextResponse.json({ error: "La tarea marcada solo lectura contiene instrucciones incompatibles con una auditoría" }, { status: 400 });
  }

  const existing = await prisma.agentRequest.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (!sameRequestPayload(existing, { ...requestPayload, dependsOn: [] })) return NextResponse.json({ error: "La clave de idempotencia ya se usó para otra tarea" }, { status: 409 });
    return NextResponse.json({ request: existing, duplicate: true, overrideScope: "hermy_hq_priority_and_frequency_only" });
  }

  try {
    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.agentRequest.create({
        data: { idempotencyKey: key, ...requestPayload, dependsOn: [] },
      });
      const override = codexManualOverrideRecord(created, auth.actor, "owner_dispatch");
      await tx.dataStore.create({ data: { key: codexManualOverrideKey(created.id), data: override } });
      if (requestPayload.sideEffecting) await writeActionApproval(tx, created, auth.actor);
      await tx.agentEvent.create({
        data: {
          kind: sideEffecting ? "approval" : "run",
          title: sideEffecting ? "Tarea manual Codex espera aprobación" : "Tarea manual asignada a Codex",
          detail: "Asignación autenticada desde el panel. Override limitado a prioridad y frecuencia internas de Hermy HQ; no omite ActionApproval, emergencia, límites del proveedor ni controles del worker.",
          agent: "codex", level: sideEffecting ? "warn" : "info",
          meta: { requestId: created.id, actor: auth.actor, source: "owner-manual-codex-dispatch", manualPolicyOverride: true, overrideScope: override.scope, action: requestPayload.action, capability: requestPayload.capability },
        },
      });
      return created;
    });
    return NextResponse.json({ request, duplicate: false, overrideScope: "hermy_hq_priority_and_frequency_only" }, { status: 201 });
  } catch (error) {
    const raced = await prisma.agentRequest.findUnique({ where: { idempotencyKey: key } }).catch(() => null);
    if (raced && sameRequestPayload(raced, { ...requestPayload, dependsOn: [] })) return NextResponse.json({ request: raced, duplicate: true, overrideScope: "hermy_hq_priority_and_frequency_only" });
    console.error("Manual Codex dispatch failed:", error);
    return NextResponse.json({ error: "No se pudo crear la tarea manual de Codex" }, { status: 500 });
  }
}
