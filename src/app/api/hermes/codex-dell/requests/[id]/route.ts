import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CODEX_DELL_OPERATOR_ID,
  TRUSTED_OPERATOR_AUTH_SOURCE,
  TRUSTED_OPERATOR_KIND,
  loadTrustedOperatorIdentity,
  operatorTaskStatusTransition,
  readBoundedRequestBody,
  verifyOperatorSignature,
} from "@/lib/codex-dell-operator.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function auth(req: Request, rawBody: string) {
  const identity = loadTrustedOperatorIdentity();
  const url = new URL(req.url);
  return verifyOperatorSignature({ headers: req.headers, method: req.method,
    pathAndQuery: url.pathname + url.search, rawBody, identity });
}

function authFailure() {
  return NextResponse.json({ error: "trusted_operator_authentication_failed" }, { status: 401 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, context: RouteContext) {
  const read = await readBoundedRequestBody(req);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 413 });
  const rawBody = read.rawBody;
  const identity = auth(req, rawBody);
  if (!identity.ok) return authFailure();
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const action = String(body.action || "");
  if (!new Set(["claim", "complete", "fail", "cancel"]).has(action)
      || Object.keys(body).some((key) => !["action", "result", "error"].includes(key))) {
    return NextResponse.json({ error: "operator_action_not_allowlisted" }, { status: 400 });
  }
  const resultText = typeof body.result === "string" ? body.result : "";
  const errorText = typeof body.error === "string" ? body.error : "";
  if (action === "complete" && (!resultText.trim() || resultText.length > 20000)) {
    return NextResponse.json({ error: "operator_result_invalid" }, { status: 400 });
  }
  if (action === "fail" && (!errorText.trim() || errorText.length > 2000)) {
    return NextResponse.json({ error: "operator_error_invalid" }, { status: 400 });
  }
  if (["claim", "cancel"].includes(action) && (body.result !== undefined || body.error !== undefined)) {
    return NextResponse.json({ error: "unexpected_operator_result" }, { status: 400 });
  }

  const params = await context.params;
  const id = String(params.id || "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return NextResponse.json({ error: "request_id_invalid" }, { status: 400 });
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT id,origin,kind,"requestedBy","authSource",status,title,scope
        FROM "AgentRequest"
        WHERE id=$1 AND origin=$2 AND kind=$3 AND "requestedBy"=$2 AND "authSource"=$4
        FOR UPDATE
      `, id, CODEX_DELL_OPERATOR_ID, TRUSTED_OPERATOR_KIND, TRUSTED_OPERATOR_AUTH_SOURCE);
      const request = rows[0];
      if (!request) return { ok: false as const, status: 404, error: "operator_request_not_found" };
      const scope = request.scope as { id?: unknown; operation?: unknown } | null;
      if (scope?.id !== "codex-dell-g15.operator.v1" || typeof scope.operation !== "string"
          || !identity.scopes.includes(scope.operation)) {
        return { ok: false as const, status: 403, error: "operator_scope_revoked_or_invalid" };
      }
      const transition = operatorTaskStatusTransition(String(request.status), action);
      if (!transition.ok) return { ok: false as const, status: 409, error: transition.reason };

      const changed = await tx.$executeRawUnsafe(`
        UPDATE "AgentRequest"
        SET status=$2,
            "startedAt"=CASE WHEN $2='running' THEN clock_timestamp() ELSE "startedAt" END,
            "finishedAt"=CASE WHEN $2 IN ('done','failed','cancelled') THEN clock_timestamp() ELSE "finishedAt" END,
            result=CASE WHEN $2='done' THEN $3 ELSE result END,
            error=CASE WHEN $2='failed' THEN $4 WHEN $2 IN ('done','cancelled') THEN NULL ELSE error END,
            "updatedAt"=clock_timestamp()
        WHERE id=$1 AND status=$5
      `, id, transition.status, action === "complete" ? resultText : null,
      action === "fail" ? errorText : null, String(request.status));
      if (changed !== 1) return { ok: false as const, status: 409, error: "operator_task_transition_race" };

      if (action !== "claim") {
        await tx.$executeRawUnsafe(`
          UPDATE "ActionApproval"
          SET status=CASE WHEN $2='cancel' THEN 'cancelled' ELSE status END,
              decision=CASE WHEN $2='cancel' THEN 'cancelled' ELSE decision END,
              resolved_by=$3,
              result=$4,
              resolved_at=clock_timestamp()
          WHERE request_id=$1 AND requested_by=$3 AND approved_by=$3 AND approval_method='trusted_operator_self_approval'
        `, id, action, CODEX_DELL_OPERATOR_ID,
        action === "complete" ? "executed and completed by authenticated Codex Dell operator"
          : action === "fail" ? "execution failed; details retained on linked AgentRequest"
            : "cancelled by authenticated Codex Dell operator before execution");
      }

      const audit = await tx.$queryRawUnsafe<Array<{ request_fingerprint: string | null }>>(`
        SELECT request_fingerprint FROM "DelegatedApprovalAudit"
        WHERE request_id=$1 AND event='trusted_operator_self_approved' ORDER BY created_at DESC LIMIT 1
      `, id);
      await tx.$executeRawUnsafe(`
        INSERT INTO "DelegatedApprovalAudit"
          (id,actor,event,request_id,request_fingerprint,detail)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `, randomUUID(), CODEX_DELL_OPERATOR_ID, `trusted_operator_task_${action}`, id,
      audit[0]?.request_fingerprint || null,
      JSON.stringify({ action, status: transition.status, operatorFingerprint: identity.fingerprint }));
      await tx.agentEvent.create({ data: {
        kind: action === "complete" ? "run" : "approval",
        title: `Codex Dell ${action}: ${String(request.title || id)}`,
        detail: `${CODEX_DELL_OPERATOR_ID} · ${transition.status}`,
        agent: "codex", level: action === "fail" ? "warn" : "info",
        meta: { requestId: id, operatorId: CODEX_DELL_OPERATOR_ID, operatorFingerprint: identity.fingerprint,
          action, status: transition.status },
      } });
      return { ok: true as const, status: transition.status };
    }, { isolationLevel: "Serializable" });
    if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: updated.status });
    return NextResponse.json({ requestId: id, status: updated.status, actor: CODEX_DELL_OPERATOR_ID });
  } catch (error) {
    console.error("Codex Dell operator task transition failed:", error);
    return NextResponse.json({ error: "operator_task_transition_failed" }, { status: 500 });
  }
}
