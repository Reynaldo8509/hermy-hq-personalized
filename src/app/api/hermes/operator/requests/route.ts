import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  TRUSTED_CODEX_OPERATOR_ID,
  TRUSTED_OPERATOR_APPROVAL_METHOD,
  TRUSTED_OPERATOR_AUTH_SOURCE,
  TRUSTED_OPERATOR_KIND,
  loadTrustedOperatorIdentity,
  operatorTaskFingerprint,
  reconstructOperatorPayload,
  readBoundedRequestBody,
  validateOperatorTask,
  verifyOperatorSignature,
} from "@/lib/trusted-operator.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function signed(req: Request, rawBody: string) {
  const identity = loadTrustedOperatorIdentity();
  const url = new URL(req.url);
  return verifyOperatorSignature({
    headers: req.headers,
    method: req.method,
    pathAndQuery: url.pathname + url.search,
    rawBody,
    identity,
  });
}

function authFailure() {
  return NextResponse.json({ error: "trusted_operator_authentication_failed" }, { status: 401 });
}

function duplicateMatches(row: any, fingerprint: string) {
  if (row?.origin !== TRUSTED_CODEX_OPERATOR_ID || row?.kind !== TRUSTED_OPERATOR_KIND
      || row?.requestedBy !== TRUSTED_CODEX_OPERATOR_ID || row?.authSource !== TRUSTED_OPERATOR_AUTH_SOURCE) return false;
  const payload = reconstructOperatorPayload(row);
  return Boolean(payload && operatorTaskFingerprint(payload) === fingerprint);
}

export async function POST(req: Request) {
  const read = await readBoundedRequestBody(req);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 413 });
  const rawBody = read.rawBody;
  const auth = signed(req, rawBody);
  if (!auth.ok) return authFailure();
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const task = validateOperatorTask(body, {
    releasesRoot: process.env.HERMY_OPERATOR_RELEASES_ROOT,
    checkpointsRoot: process.env.HERMY_OPERATOR_CHECKPOINTS_ROOT,
    operatorScopes: auth.scopes,
  });
  if (!task.ok) return NextResponse.json({ error: task.reason }, { status: task.status });

  try {
    const created = await prisma.$transaction(async (tx) => {
      const prior = await tx.agentRequest.findUnique({ where: { idempotencyKey: task.normalized.idempotencyKey } });
      if (prior) {
        if (!duplicateMatches(prior, task.fingerprint)) {
          return { ok: false as const, status: 409, error: "idempotency_key_conflict" };
        }
        return { ok: true as const, duplicate: true, request: prior };
      }

      const request = await tx.agentRequest.create({
        data: {
          origin: TRUSTED_CODEX_OPERATOR_ID,
          kind: TRUSTED_OPERATOR_KIND,
          title: task.normalized.title,
          prompt: task.normalized.prompt,
          sideEffecting: true,
          action: "execute",
          capability: task.capability,
          contractVersion: 3,
          executionMode: task.executionMode,
          scope: task.scope as Prisma.InputJsonValue,
          privacyClass: "LOCAL_ONLY",
          requestedBy: TRUSTED_CODEX_OPERATOR_ID,
          authSource: TRUSTED_OPERATOR_AUTH_SOURCE,
          riskReasons: ["trusted_operator_self_approval", task.normalized.operation],
          // The database trigger creates the pending ActionApproval row for
          // side-effecting requests. We resolve that row below, then advance
          // the request inside this same transaction.
          status: "awaiting_approval",
          idempotencyKey: task.normalized.idempotencyKey,
          dependsOn: [],
        },
      });
      const approvalId = `approval-${request.id}`;
      const snapshot = JSON.stringify({
        requestId: request.id,
        operation: task.normalized.operation,
        scope: task.scope,
        requestFingerprint: task.fingerprint,
        operatorId: auth.operatorId,
        operatorFingerprint: auth.fingerprint,
        approvalMethod: TRUSTED_OPERATOR_APPROVAL_METHOD,
      });
      const approvalUpdated = await tx.$executeRawUnsafe(`
        UPDATE "ActionApproval"
        SET status='approved',requested_by=$3,approved_by=$3,rejected_by=NULL,resolved_by=$3,
            decision='approved',approval_method=$4,reason=$5,result=$6,
            resolved_at=clock_timestamp(),expires_at=NULL,parameters_snapshot=$7::jsonb
        WHERE id=$1 AND request_id=$2 AND status='pending'
      `, approvalId, request.id, TRUSTED_CODEX_OPERATOR_ID, TRUSTED_OPERATOR_APPROVAL_METHOD,
      "Solicitud autenticada y autoaprobada por la identidad administrativa persistente de trusted operator.",
      "approved; awaiting local trusted operator execution", snapshot);
      if (approvalUpdated !== 1) throw new Error("trusted_operator_pending_approval_missing");
      const requestUpdated = await tx.agentRequest.updateMany({
        where: { id: request.id, status: "awaiting_approval", origin: TRUSTED_CODEX_OPERATOR_ID,
          requestedBy: TRUSTED_CODEX_OPERATOR_ID, authSource: TRUSTED_OPERATOR_AUTH_SOURCE },
        data: { status: "approved", decidedAt: new Date() },
      });
      if (requestUpdated.count !== 1) throw new Error("trusted_operator_request_transition_conflict");

      await tx.$executeRawUnsafe(`
        INSERT INTO "DelegatedApprovalAudit"
          (id,actor,event,request_id,approval_id,request_fingerprint,detail)
        VALUES ($1,$2,'trusted_operator_self_approved',$3,$4,$5,$6::jsonb)
      `, randomUUID(), TRUSTED_CODEX_OPERATOR_ID, request.id, approvalId, task.fingerprint,
      JSON.stringify({ approvalMethod: TRUSTED_OPERATOR_APPROVAL_METHOD, operatorFingerprint: auth.fingerprint,
        operation: task.normalized.operation, scope: task.scope, oneUseRequestKey: task.normalized.idempotencyKey }));

      await tx.agentEvent.create({ data: {
        kind: "approval", title: "Solicitud autoaprobada por operador trusted operator",
        detail: `${TRUSTED_CODEX_OPERATOR_ID} · ${task.normalized.operation} · ${request.id}`,
        agent: "codex", level: "info",
        meta: { requestId: request.id, approvalId, operatorId: TRUSTED_CODEX_OPERATOR_ID,
          operatorFingerprint: auth.fingerprint, approvalMethod: TRUSTED_OPERATOR_APPROVAL_METHOD,
          operation: task.normalized.operation, requestFingerprint: task.fingerprint },
      } });
      const approvedRequest = await tx.agentRequest.findUnique({ where: { id: request.id } });
      if (!approvedRequest) throw new Error("trusted_operator_request_disappeared");
      return { ok: true as const, duplicate: false, request: approvedRequest, approvalId };
    }, { isolationLevel: "Serializable" });
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });
    return NextResponse.json({ request: created.request, approvalId: created.approvalId || `approval-${created.request.id}`,
      approvedBy: TRUSTED_CODEX_OPERATOR_ID, approvalMethod: TRUSTED_OPERATOR_APPROVAL_METHOD,
      duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
  } catch (error) {
    if (String((error as { code?: unknown })?.code || "") === "P2002") {
      const raced = await prisma.agentRequest.findUnique({ where: { idempotencyKey: task.normalized.idempotencyKey } });
      if (raced && duplicateMatches(raced, task.fingerprint)) {
        return NextResponse.json({ request: raced, approvalId: `approval-${raced.id}`,
          approvedBy: TRUSTED_CODEX_OPERATOR_ID, approvalMethod: TRUSTED_OPERATOR_APPROVAL_METHOD,
          duplicate: true }, { status: 200 });
      }
      return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
    }
    console.error("trusted operator request failed:", error);
    return NextResponse.json({ error: "trusted_operator_request_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const auth = signed(req, "");
  if (!auth.ok) return authFailure();
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const allowedStatuses = ["approved", "running", "done", "failed", "cancelled"];
  if (status && !allowedStatuses.includes(status)) {
    return NextResponse.json({ error: "operator_status_not_allowlisted" }, { status: 400 });
  }
  const requests = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT r.id,r.title,r.prompt,r.status,r.result,r.error,r.capability,r."executionMode",r.scope,
           r."createdAt",r."startedAt",r."finishedAt",
           (SELECT jsonb_build_object('id',a.id,'status',a.status,'requested_by',a.requested_by,
             'approved_by',a.approved_by,'resolved_by',a.resolved_by,'decision',a.decision,
             'approval_method',a.approval_method,'resolved_at',a.resolved_at)
            FROM "ActionApproval" a WHERE a.request_id=r.id ORDER BY a.created_at DESC LIMIT 1) AS approval,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',d.actor,'event',d.event,
             'created_at',d.created_at,'detail',d.detail) ORDER BY d.created_at)
            FROM "DelegatedApprovalAudit" d WHERE d.request_id=r.id),'[]'::jsonb) AS audit
    FROM "AgentRequest" r
    WHERE r.origin=$1 AND r.kind=$2 AND r."requestedBy"=$1 AND r."authSource"=$3
      AND ($4::text IS NULL OR r.status=$4)
    ORDER BY r."createdAt" DESC LIMIT 50
  `, TRUSTED_CODEX_OPERATOR_ID, TRUSTED_OPERATOR_KIND, TRUSTED_OPERATOR_AUTH_SOURCE, status);
  return NextResponse.json({ operatorId: auth.operatorId, requests });
}
