import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { approvalParameters, sameRequestPayload } from "@/lib/phase2-domain.mjs";
import { classifyQueueRequestRisk } from "@/lib/command-center-domain.mjs";
import { ATLAS_POLICY_ACTION, createAtlasRemoteFreePolicyCapability } from "@/lib/atlas-remote-free-consent.mjs";
import { buildStructuredRequestContract, maybeIssueDelegatedDecision } from "@/lib/delegated-approval-engine";
import { evaluateMaxOwnerNotificationPolicy, issueMaxOwnerNotificationPolicyApproval } from "@/lib/max-owner-notification-policy.mjs";

export class QueueRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "QueueRequestError";
    this.status = status;
  }
}

export function readIdempotencyKey(request: Request, body: Record<string, unknown>) {
  const key = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
  if (key && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new QueueRequestError("Idempotency-Key debe tener entre 8 y 128 caracteres seguros");
  return key || randomUUID();
}

export async function assertDependenciesExist(ids: string[]) {
  if (!ids.length) return;
  const rows = await prisma.agentRequest.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new QueueRequestError("No existen estas dependencias: " + missing.join(", "), 404);
  const failed = ids.filter((id) => ["failed", "cancelled", "rejected"].includes(byId.get(id)?.status || ""));
  if (failed.length) throw new QueueRequestError("No se puede depender de tareas fallidas o canceladas: " + failed.join(", "), 409);
}

export async function writeActionApproval(tx: Prisma.TransactionClient, request: any, actor: string) {
  const snapshot = JSON.stringify(approvalParameters(request));
  const id = "approval-" + request.id;
  await tx.$executeRawUnsafe(
    'INSERT INTO "ActionApproval" (id, request_id, action, status, requested_by, approved_by, rejected_by, resolved_by, decision, reason, created_at, resolved_at, expires_at, parameters_snapshot) VALUES ($1,$2,\'execute\',\'pending\',$3,NULL,NULL,NULL,NULL,$4,now(),NULL,now() + interval \'24 hours\',$5::jsonb) ON CONFLICT (id) DO UPDATE SET action=EXCLUDED.action, status=\'pending\', requested_by=EXCLUDED.requested_by, approved_by=NULL, rejected_by=NULL, resolved_by=NULL, decision=NULL, result=NULL, incident_id=NULL, reason=EXCLUDED.reason, created_at=now(), resolved_at=NULL, expires_at=EXCLUDED.expires_at, parameters_snapshot=EXCLUDED.parameters_snapshot',
    id, request.id, actor, "Aprobación individual requerida para esta solicitud de AgentRequest.", snapshot,
  );
  return id;
}

export async function createQueueRequest(input: {
  key: string; actor: string; origin: string; kind: string; title: string;
  prompt: string; sideEffecting: boolean; status: string; dependsOn: string[]; action?: string | null; capability?: string | null; writeEvent?: boolean;
  executionMode?: string | null; riskPrompt?: string; actionSideEffecting?: boolean; clientRequestedApproval?: boolean; authSource?: string; hasOwnerNotificationOverrides?: boolean; scopeMetadata?: Record<string, Prisma.InputJsonValue>;
}) {
  const decision = classifyQueueRequestRisk({
    kind: input.kind, action: input.action, capability: input.capability,
    clientRequestedApproval: input.clientRequestedApproval, sideEffecting: input.sideEffecting,
    executionMode: input.executionMode,
    actionSideEffecting: input.actionSideEffecting,
    prompt: input.riskPrompt ?? input.prompt,
  });
  const ownerNotificationPolicy = evaluateMaxOwnerNotificationPolicy({
    origin: input.origin, kind: input.kind, action: decision.action, capability: decision.capability,
    executionMode: input.executionMode ?? null, actor: input.actor, authSource: input.authSource || "unknown",
    hasOverrides: input.hasOwnerNotificationOverrides === false ? false : true,
    prompt: input.riskPrompt ?? input.prompt,
  });
  const sideEffecting = decision.requiresApproval || input.sideEffecting === true || input.actionSideEffecting === true;
  const approvalRequired = decision.requiresApproval && !ownerNotificationPolicy.autoAuthorized;
  const status = approvalRequired ? "awaiting_approval" : input.status;
  const structured = buildStructuredRequestContract({
    origin: input.origin, kind: input.kind, action: decision.action, capability: decision.capability,
    executionMode: input.executionMode ?? null, actor: input.actor, authSource: input.authSource || "unknown",
    riskReasons: decision.reasons,
  });
  const scope = ownerNotificationPolicy.applies
    ? { ...(structured.scope ?? {}), ...(input.scopeMetadata ?? {}), ...ownerNotificationPolicy.scope }
    : input.scopeMetadata
      ? { ...(structured.scope ?? {}), ...input.scopeMetadata }
      : structured.scope;
  const payload = {
    origin: input.origin, kind: input.kind, title: input.title, prompt: input.prompt,
    sideEffecting, action: decision.action, capability: decision.capability, dependsOn: input.dependsOn,
    ...structured, scope,
  };
  const existing = await prisma.agentRequest.findUnique({ where: { idempotencyKey: input.key } });
  if (existing) {
    if (!sameRequestPayload(existing, payload)) throw new QueueRequestError("La clave de idempotencia ya se usó con parámetros distintos", 409);
    return { request: existing, duplicate: true };
  }
  await assertDependenciesExist(input.dependsOn || []);

  try {
    const request = await prisma.$transaction(async (tx) => {
      let created = await tx.agentRequest.create({
        data: {
          idempotencyKey: input.key, origin: input.origin, kind: input.kind,
          title: input.title, prompt: input.prompt, sideEffecting,
          action: decision.action, capability: decision.capability,
          status, dependsOn: input.dependsOn, ...structured,
          scope: scope === null ? Prisma.DbNull : scope,
        },
      });
      if (approvalRequired) {
        const approvalId = await writeActionApproval(tx, created, input.actor);
        const delegated = await maybeIssueDelegatedDecision(tx, created, approvalId, process.env.ALLOWED_EMAILS || "");
        if (delegated.decision === "approve") {
          created = await tx.agentRequest.findUniqueOrThrow({ where: { id: created.id } });
        }
      } else if (ownerNotificationPolicy.autoAuthorized) {
        // Keep sideEffecting=true and satisfy the existing DB action gate with a
        // policy-issued ActionApproval for this exact authenticated request only.
        created = await issueMaxOwnerNotificationPolicyApproval(tx, created, ownerNotificationPolicy);
      }
      const atlasPolicyCapability = input.authSource
        ? createAtlasRemoteFreePolicyCapability(created, { actor: input.actor, authSource: input.authSource })
        : null;
      if (atlasPolicyCapability) {
        const issued = await tx.$executeRaw`
          INSERT INTO "ActionApproval"
            (id,request_id,action,status,requested_by,approved_by,decision,reason,created_at,resolved_at,expires_at,parameters_snapshot)
          VALUES
            (${atlasPolicyCapability.approvalId},${created.id},${ATLAS_POLICY_ACTION},'issued',${input.actor},NULL,
             'server_policy_issued','Authenticated public Atlas read-only request; FREE-only single-use capability',
             ${new Date(atlasPolicyCapability.issuedAtMs)},NULL,${new Date(atlasPolicyCapability.expiresAtMs)},
             ${JSON.stringify(atlasPolicyCapability)}::jsonb)
          ON CONFLICT (id) DO NOTHING`;
        if (issued !== 1) throw new QueueRequestError("No se pudo emitir una capability Atlas de un solo uso", 409);
        await tx.agentEvent.create({
          data: { kind: "activity", title: "Capability Atlas FREE emitida por política", agent: "atlas", level: "info",
            detail: "Permiso efímero y de un solo uso para una investigación pública read-only.",
            meta: { requestId: created.id, action: ATLAS_POLICY_ACTION, authSource: atlasPolicyCapability.authSource,
              expiresAt: new Date(atlasPolicyCapability.expiresAtMs).toISOString(), routePolicy: "FREE_ONLY" } },
        });
      }
      if (input.writeEvent !== false) await tx.agentEvent.create({
        data: {
          kind: "run", title: "Solicitud creada: " + created.title,
          agent: input.kind.split(".")[0] || "max", level: sideEffecting ? "warn" : "info",
          meta: { requestId: created.id, source: "action-center", requiresApproval: approvalRequired, sideEffecting, policyAuthorization: ownerNotificationPolicy.policyId, ...(ownerNotificationPolicy.applies ? { authSource: input.authSource || "unknown" } : {}), executionMode: input.executionMode || null, actionSideEffecting: input.actionSideEffecting ?? null, idempotencyKey: input.key, action: decision.action, capability: decision.capability, riskReasons: decision.reasons },
        },
      });
      return created;
    });
    return { request, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.agentRequest.findUnique({ where: { idempotencyKey: input.key } });
      if (raced && sameRequestPayload(raced, payload)) return { request: raced, duplicate: true };
      if (raced) throw new QueueRequestError("La clave de idempotencia ya se usó con parámetros distintos", 409);
    }
    throw error;
  }
}

export async function expirePendingApprovals() {
  const expired = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; request_id: string; action: string }>>(
      'UPDATE "ActionApproval" SET status=\'expired\', decision=\'expired\', resolved_by=\'system:approval-expiry\', result=\'expired without execution\', resolved_at=now() WHERE status=\'pending\' AND COALESCE(expires_at, created_at + interval \'24 hours\') <= now() RETURNING id, request_id, action'
    );
    if (rows.length) {
      await tx.agentRequest.updateMany({
        where: { id: { in: rows.map((row) => row.request_id) }, status: "awaiting_approval" },
        data: { status: "rejected", error: "Approval expired", decidedAt: new Date() },
      });
      await tx.agentEvent.createMany({
        data: rows.map((row) => ({
          kind: "approval", title: "Aprobación expirada: " + row.action,
          detail: "Solicitud: " + row.request_id, agent: "hermy-hq", level: "warn",
          meta: { approvalId: row.id, requestId: row.request_id, action: row.action, decision: "expired", actor: "system:approval-expiry" },
        })),
      });
    }
    await tx.$executeRawUnsafe(`
      UPDATE "ActionApproval" a
      SET result = CASE r.status
            WHEN 'done' THEN 'execution completed; detailed result remains on linked request'
            WHEN 'failed' THEN 'execution failed; detailed error remains on linked request'
            WHEN 'cancelled' THEN 'execution cancelled; no action result'
            ELSE 'execution rejected; no action result'
          END,
          incident_id = COALESCE(a.incident_id, (
            SELECT i.id FROM "IncidentMemory" i
            WHERE i.request_id = a.request_id
            ORDER BY i.updated_at DESC LIMIT 1
          ))
      FROM "AgentRequest" r
      WHERE r.id = a.request_id AND a.status = 'approved'
        AND r.status IN ('done','failed','cancelled','rejected')
        AND (a.result IS NULL OR a.incident_id IS NULL)
    `);
    return rows;
  });
  return expired.length;
}
