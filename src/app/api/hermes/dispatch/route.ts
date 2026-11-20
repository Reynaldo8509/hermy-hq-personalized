import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requestActor, requestActorWithProvenance } from "@/lib/human-auth";
import { createQueueRequest, readIdempotencyKey, QueueRequestError } from "@/lib/queue-request";
import { classifyDispatchRequestRisk } from "@/lib/command-center-domain.mjs";
import { applyInferenceTestOverride, inferenceTestOverrideAllowed, inferenceTestOverrideKindAllowed } from "@/lib/inference-test-override.mjs";
import { evaluateMaxOwnerNotificationPolicy, hasMaxOwnerNotificationOverrides, MAX_OWNER_NOTIFICATION_KIND } from "@/lib/max-owner-notification-policy.mjs";

export const dynamic = "force-dynamic";

// POST { kind?, title, prompt?, action?, capability?, executionMode?, sideEffecting? } -> writes only to AgentRequest. Recognized read-only kinds infer their fixed capability when both action fields are omitted.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const title = String(body.title || body.prompt || "").trim().slice(0, 200);
  const prompt = String(body.prompt ?? body.title ?? "").trim().slice(0, 12000);
  const executionMode = typeof body.executionMode === "string" ? body.executionMode : null;
  if (!title || !prompt) return NextResponse.json({ error: "title or prompt required" }, { status: 400 });
  const kind = String(body.kind || "oneshot").trim().slice(0, 100);
  if (kind === MAX_OWNER_NOTIFICATION_KIND
      && !req.headers.get("idempotency-key")?.trim()
      && !String(body.idempotencyKey || "").trim()) {
    return NextResponse.json({ error: "MAX owner notification requires a stable Idempotency-Key" }, { status: 400 });
  }
  if (kind.startsWith("codex.")) {
    return NextResponse.json({ error: "Codex solo puede recibir delegaciones justificadas de Max" }, { status: 403 });
  }
  const decision = classifyDispatchRequestRisk({
    kind, action: body.action, capability: body.capability, clientFlag: body.sideEffecting,
    executionMode, prompt,
  });
  const sideEffecting = decision.requiresApproval;
  const auth = await requestActorWithProvenance(req, "max");
  if (auth.response) return auth.response;
  const actor = auth.actor;
  const testOverrideRequested = body.inferenceTestOverride !== undefined && body.inferenceTestOverride !== null && body.inferenceTestOverride !== "";
  if (testOverrideRequested && (!inferenceTestOverrideAllowed({ actor, kind, sideEffecting, action: decision.action, capability: decision.capability })
      || !inferenceTestOverrideKindAllowed(actor, String(body.inferenceTestOverride), kind))) {
    return NextResponse.json({ error: "inference test override is restricted to internal read-only routes" }, { status: 403 });
  }
  const testOverride = applyInferenceTestOverride(actor, body.inferenceTestOverride, prompt, kind);
  if (!testOverride) return NextResponse.json({ error: "unknown inference test override" }, { status: 403 });

  const hasOwnerNotificationOverrides = hasMaxOwnerNotificationOverrides(body);
  const ownerNotificationPolicy = evaluateMaxOwnerNotificationPolicy({
    origin: testOverride.origin,
    kind,
    action: decision.action,
    capability: decision.capability,
    executionMode,
    actor,
    authSource: auth.authSource,
    hasOverrides: hasOwnerNotificationOverrides,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
  });
  if (kind === MAX_OWNER_NOTIFICATION_KIND && !ownerNotificationPolicy.applies) {
    return NextResponse.json({ error: "MAX owner notification contract rejected" }, { status: 403 });
  }

  try {
    const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.map(String) : [];
    const key = readIdempotencyKey(req, body);
    const effectiveSideEffecting = sideEffecting || ownerNotificationPolicy.applies;
    const approvalRequired = decision.requiresApproval && !ownerNotificationPolicy.autoAuthorized;
    const status = approvalRequired ? "awaiting_approval" : "queued";
    const created = await createQueueRequest({
      key, actor, origin: testOverride.origin, kind, title, prompt: testOverride.prompt, sideEffecting: effectiveSideEffecting, status, dependsOn, action: decision.action, capability: decision.capability,
      clientRequestedApproval: body.sideEffecting === true,
      executionMode, riskPrompt: prompt,
      authSource: auth.authSource, hasOwnerNotificationOverrides,
    });
    return NextResponse.json({ request: created.request, duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof QueueRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Hermes dispatch failed:", error);
    return NextResponse.json({ error: "No se pudo enviar la solicitud a la cola de Hermy HQ" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const auth = await requestActor(req, "max");
  if (auth.response) return auth.response;
  const requests = await prisma.agentRequest.findMany({ where: { origin: "web" }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ requests });
}
