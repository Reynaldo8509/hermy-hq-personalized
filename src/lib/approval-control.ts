import { prisma } from "@/lib/prisma";
import { approvalMatches, approvalTransition } from "@/lib/phase2-domain.mjs";
import { writeActionApproval } from "@/lib/queue-request";
import { approvalDecisionAudit } from "@/lib/approval-audit-domain.mjs";
import { codexManualOverrideKey, codexManualOverrideRecord } from "@/lib/codex-manual-override.mjs";

type Decision = "approve" | "reject";
type ApprovalRow = {
  id: string; request_id: string; action: string; status: string;
  requested_by: string; approved_by: string | null; reason: string | null;
  created_at: Date; resolved_at: Date | null; expires_at: Date | null;
  parameters_snapshot: Record<string, unknown> | null;
};

export async function decideApprovalById(id: string, decision: Decision, actor: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<ApprovalRow[]>(
      "SELECT id, request_id, action, status, requested_by, approved_by, reason, created_at, resolved_at, expires_at, parameters_snapshot FROM \"ActionApproval\" WHERE id=$1 FOR UPDATE",
      id,
    );
    const approval = rows[0];
    if (!approval) return { ok: false as const, status: 404, error: "Solicitud de aprobación no encontrada" };
    const transition = approvalTransition(approval, decision, Date.now());
    if (!transition.ok) {
      if (transition.expired) {
        await tx.$executeRawUnsafe("UPDATE \"ActionApproval\" SET status='expired', decision='expired', resolved_by='system:approval-expiry', result='expired without execution', resolved_at=now() WHERE id=$1 AND status='pending'", id);
        await tx.agentRequest.updateMany({
          where: { id: approval.request_id, status: "awaiting_approval" },
          data: { status: "rejected", error: "Approval expired", decidedAt: new Date() },
        });
        await tx.agentEvent.create({ data: { kind: "approval", title: "Aprobación expirada: " + approval.action, detail: "Solicitud: " + approval.request_id, agent: "hermy-hq", level: "warn", meta: { approvalId: approval.id, requestId: approval.request_id, action: approval.action, decision: "expired", actor: "system:approval-expiry" } } });
      }
      return { ok: false as const, status: transition.status, error: transition.error };
    }
    const wanted = transition.status;
    if (transition.duplicate) return { ok: true as const, duplicate: true, id, requestId: approval.request_id, status: wanted };

    if (!approval.parameters_snapshot) return { ok: false as const, status: 409, error: "La aprobación no tiene parámetros exactos guardados; solicita una nueva aprobación" };
    let request: any = null;
    if (["execute", "execute_agent_request"].includes(approval.action)) {
      request = await tx.agentRequest.findUnique({ where: { id: approval.request_id } });
      if (!request || !approvalMatches(approval, request)) {
        return { ok: false as const, status: 409, error: "Los parámetros de la tarea cambiaron; requiere una aprobación nueva" };
      }
      if (request.status !== "awaiting_approval") {
        return { ok: false as const, status: 409, error: "La tarea ya no está esperando aprobación" };
      }
    }

    if (["execute", "execute_agent_request"].includes(approval.action)) {
      await tx.agentRequest.update({
        where: { id: approval.request_id },
        data: { status: wanted === "approved" ? "approved" : "rejected", decidedAt: new Date(), ...(wanted === "rejected" ? { error: "Rejected by " + actor } : {}) },
      });
      if (wanted === "approved" && request?.kind?.startsWith("codex.")) {
        const override = codexManualOverrideRecord(request, actor, "human_approval");
        await tx.dataStore.upsert({ where: { key: codexManualOverrideKey(request.id) }, update: { data: override }, create: { key: codexManualOverrideKey(request.id), data: override } });
      }
    }
    const audit = approvalDecisionAudit(wanted, actor);
    await tx.$executeRawUnsafe(
      "UPDATE \"ActionApproval\" SET status=$1, decision=$1, approved_by=$2, rejected_by=$3, resolved_by=$4, result=$5, resolved_at=now() WHERE id=$6",
      audit.decision, audit.approved_by, audit.rejected_by, audit.resolved_by, wanted === "approved" ? "approved; execution gated by linked request" : "rejected; execution blocked", id,
    );
    await tx.agentEvent.create({
      data: {
        kind: "approval", title: "Aprobación " + wanted + ": " + approval.action,
        detail: "Actor: " + actor + ". Solicitud: " + approval.request_id,
        agent: request?.kind?.split(".")[0] || "hermy-hq",
        level: wanted === "approved" ? "up" : "warn",
        meta: { approvalId: id, requestId: approval.request_id, action: approval.action, decision: wanted, actor },
      },
    });
    return { ok: true as const, duplicate: false, id, requestId: approval.request_id, status: wanted, actor };
  });
}

export async function decideAgentRequest(requestId: string, decision: Decision, actor: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({ where: { id: requestId } });
    if (!request) return { ok: false as const, status: 404, error: "Solicitud no encontrada" };
    const wanted = decision === "approve" ? "approved" : "rejected";
    if (request.status === wanted) return { ok: true as const, duplicate: true, request };
    if (!["awaiting_approval", "awaiting_destructive_confirmation", "queued"].includes(request.status)) {
      return { ok: false as const, status: 409, error: "No se puede decidir una tarea en estado " + request.status };
    }
    if (request.status === "awaiting_destructive_confirmation" && decision === "approve") {
      return { ok: false as const, status: 409, error: "La tarea destructiva requiere el control AUTORIZO específico de CODEX" };
    }

    let approval: ApprovalRow | undefined;
    if (request.sideEffecting || request.status === "awaiting_approval") {
      const rows = await tx.$queryRawUnsafe<ApprovalRow[]>(
        "SELECT id, request_id, action, status, requested_by, approved_by, reason, created_at, expires_at, resolved_at, parameters_snapshot FROM \"ActionApproval\" WHERE request_id=$1 AND action IN ('execute','execute_agent_request') AND status='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        requestId,
      );
      approval = rows[0];
      if (!approval) return { ok: false as const, status: 409, error: "ACTION_APPROVAL_REQUIRED: no existe una aprobación individual pendiente para esta tarea" };
      const transition = approvalTransition(approval, decision, Date.now());
      if (!transition.ok) {
        if (transition.expired) {
          await tx.$executeRawUnsafe("UPDATE \"ActionApproval\" SET status='expired', decision='expired', resolved_by='system:approval-expiry', result='expired without execution', resolved_at=now() WHERE id=$1 AND status='pending'", approval.id);
          await tx.agentRequest.update({ where: { id: requestId }, data: { status: "rejected", error: "Approval expired", decidedAt: new Date() } });
          await tx.agentEvent.create({ data: { kind: "approval", title: "Aprobación expirada: " + approval.action, detail: "Solicitud: " + requestId, agent: "hermy-hq", level: "warn", meta: { approvalId: approval.id, requestId, action: approval.action, decision: "expired", actor: "system:approval-expiry" } } });
        }
        return { ok: false as const, status: transition.status, error: transition.error };
      }
      if (!approvalMatches(approval, request)) return { ok: false as const, status: 409, error: "Los parámetros cambiaron y deben aprobarse nuevamente" };
    }

    const changed = await tx.agentRequest.updateMany({
      where: { id: requestId, status: request.status },
      data: { status: wanted, decidedAt: new Date(), ...(decision === "reject" ? { error: "Rejected by " + actor } : {}) },
    });
    if (!changed.count) return { ok: false as const, status: 409, error: "La solicitud cambió de estado" };
    if (wanted === "approved" && request.kind.startsWith("codex.")) {
      const override = codexManualOverrideRecord(request, actor, "human_approval");
      await tx.dataStore.upsert({ where: { key: codexManualOverrideKey(request.id) }, update: { data: override }, create: { key: codexManualOverrideKey(request.id), data: override } });
    }
    if (approval) {
      const audit = approvalDecisionAudit(wanted, actor);
      await tx.$executeRawUnsafe(
        "UPDATE \"ActionApproval\" SET status=$1, decision=$1, approved_by=$2, rejected_by=$3, resolved_by=$4, result=$5, resolved_at=now() WHERE id=$6",
        audit.decision, audit.approved_by, audit.rejected_by, audit.resolved_by, wanted === "approved" ? "approved; execution gated by linked request" : "rejected; execution blocked", approval.id,
      );
    }
    await tx.agentEvent.create({
      data: {
        kind: "approval", title: "Tarea " + wanted + ": " + request.title,
        detail: "Actor: " + actor,
        agent: request.kind.split(".")[0] || "hermy-hq",
        level: wanted === "approved" ? "up" : "warn",
        meta: { requestId, action: "execute_agent_request", decision: wanted, actor, approvalId: approval?.id || null },
      },
    });
    return { ok: true as const, duplicate: false, request: { ...request, status: wanted }, actor };
  });
}

export async function editAgentRequest(requestId: string, title: string, prompt: string, actor: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.agentRequest.findUnique({ where: { id: requestId } });
    if (!existing) return { ok: false as const, status: 404, error: "Solicitud no encontrada" };
    if (!["awaiting_approval", "queued"].includes(existing.status)) {
      return { ok: false as const, status: 409, error: "Solo se puede editar una solicitud aún no ejecutada" };
    }
    const sideEffecting = existing.sideEffecting;
    const status = sideEffecting ? "awaiting_approval" : "queued";
    if (sideEffecting) {
      await tx.$executeRawUnsafe(
        "UPDATE \"ActionApproval\" SET status='rejected', decision='rejected', approved_by=NULL, rejected_by=$1, resolved_by=$1, result='invalidated; execution blocked pending new approval', reason='Parámetros modificados; aprobación anterior invalidada', resolved_at=now() WHERE request_id=$2 AND status='pending'",
        actor, requestId,
      );
    }
    const updated = await tx.agentRequest.update({
      where: { id: requestId },
      data: { title, prompt, status, decidedAt: null, updatedAt: new Date() },
    });
    if (sideEffecting) await writeActionApproval(tx, updated, actor);
    await tx.agentEvent.create({
      data: { kind: "approval", title: "Parámetros de tarea actualizados", agent: updated.kind.split(".")[0], level: "warn", meta: { requestId, action: "edit", actor, reapprovalRequired: sideEffecting } },
    });
    return { ok: true as const, request: updated, reapprovalRequired: sideEffecting };
  });
}

export async function recordDestructiveApproval(requestId: string, actor: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "awaiting_destructive_confirmation") {
      return { ok: false as const, status: 409, error: "La tarea no espera confirmación destructiva" };
    }
    const changed = await tx.agentRequest.updateMany({
      where: { id: requestId, status: "awaiting_destructive_confirmation" },
      data: { status: "approved", decidedAt: new Date() },
    });
    if (!changed.count) return { ok: false as const, status: 409, error: "La tarea cambió antes de autorizarse" };
    const id = "approval-" + request.id;
    const snapshot = JSON.stringify({
      requestId: request.id, origin: request.origin, kind: request.kind, title: request.title,
      prompt: request.prompt, sideEffecting: request.sideEffecting,
      dependencies: Array.isArray(request.dependsOn) ? request.dependsOn.map(String).sort() : [],
    });
    await tx.$executeRawUnsafe(
      "UPDATE \"ActionApproval\" SET action='execute', status='approved', decision='approved', approved_by=$2, rejected_by=NULL, resolved_by=$2, result='approved; exact destructive confirmation recorded', reason='AUTORIZO exacto verificado para esta tarea', resolved_at=now(), expires_at=now() + interval '10 minutes', parameters_snapshot=$3::jsonb WHERE id=$1 AND request_id=$4",
      id, actor, snapshot, requestId,
    );
    await tx.agentEvent.create({
      data: { kind: "approval", title: "Autorización destructiva individual registrada", detail: "Actor: " + actor, agent: "codex", level: "warn", meta: { approvalId: id, requestId, action: "execute_codex_destructive", actor } },
    });
    return { ok: true as const, approvalId: id, requestId, actor };
  });
}
