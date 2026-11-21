import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHumanActor } from "@/lib/human-auth";
import { createAtlasRemoteFreeConsent } from "@/lib/atlas-remote-free-consent.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id || ""))
      || !body || body.confirmRemoteFree !== true
      || Object.keys(body).some((key) => key !== "confirmRemoteFree")) {
    return NextResponse.json({ error: "Se requiere confirmación explícita de permiso Atlas Remote FREE" }, { status: 400 });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      // This row lock serializes with the Bridge's conditional queued->running
      // status update. Bridge re-reads the approval after its CAS, so either the
      // consent commits before dispatch or the endpoint rejects a running request.
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id,origin,kind,title,prompt,"sideEffecting",action,capability,status,"dependsOn"
        FROM "AgentRequest" WHERE id=${id} FOR UPDATE`;
      const request = rows[0];
      if (!request) return { error: "request_not_found", status: 404 };
      const now = Date.now();
      const capability = createAtlasRemoteFreeConsent(request, auth.actor, { now });
      if (!capability) return { error: "request_not_eligible_for_remote_free_consent", status: 409 };
      const inserted = await tx.$executeRaw`
        INSERT INTO "ActionApproval"
          (id,request_id,action,status,requested_by,approved_by,reason,created_at,resolved_at,expires_at,parameters_snapshot)
        VALUES
          (${capability.approvalId},${capability.requestId},'atlas_remote_free_consent','approved',${auth.actor},${auth.actor},
           'Authenticated consent for one bounded Atlas public research request',
           ${new Date(capability.issuedAtMs)},${new Date(capability.issuedAtMs)},${new Date(capability.expiresAtMs)},
           ${JSON.stringify(capability)}::jsonb)
        ON CONFLICT (id) DO NOTHING`;
      if (inserted !== 1) return { error: "consent_already_exists_or_was_consumed", status: 409 };
      await tx.agentEvent.create({ data: {
        kind: "activity", title: "Permiso Atlas Remote FREE emitido", agent: "atlas", level: "info",
        detail: "Permiso de un uso, ligado a una solicitud pública read-only y con vencimiento corto.",
        meta: { requestId: capability.requestId, action: "atlas_remote_free_consent",
          actor: auth.actor, approvalId: capability.approvalId, expiresAt: new Date(capability.expiresAtMs).toISOString() },
      } });
      return { approvalId: capability.approvalId, requestId: capability.requestId,
        expiresAt: new Date(capability.expiresAtMs).toISOString(), routePolicy: "FREE_ONLY" };
    });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ consent: result }, { status: 201 });
  } catch (error) {
    console.error("Atlas remote-free consent failed", String(id).slice(0, 128), error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "No se pudo registrar el permiso Atlas Remote FREE" }, { status: 500 });
  }
}
