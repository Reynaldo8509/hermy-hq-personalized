import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAllowlistedActor } from "@/lib/phase2-domain.mjs";

export async function requireHumanActor(): Promise<{ actor: string; response?: never } | { actor?: never; response: NextResponse }> {
  const session = await getServerSession(authOptions);
  const email = String(session?.user?.email || "").trim().toLowerCase();
  if (!email) {
    return { response: NextResponse.json({ error: "Se requiere una sesión humana autenticada" }, { status: 401 }) };
  }
  if (!isAllowlistedActor(email, process.env.ALLOWED_EMAILS || "")) {
    return { response: NextResponse.json({ error: "La cuenta no está autorizada para operaciones" }, { status: 403 }) };
  }
  return { actor: email };
}

export async function requestActorWithProvenance(request: Request, internalActor = "hermes"): Promise<
  { actor: string; authSource: "hermy_hq_internal_secret" | "nextauth_allowlisted_human"; response?: never }
  | { actor?: never; authSource?: never; response: NextResponse }
> {
  const supplied = request.headers.get("x-internal-secret");
  if (supplied && process.env.INTERNAL_API_SECRET && supplied === process.env.INTERNAL_API_SECRET) {
    return { actor: internalActor, authSource: "hermy_hq_internal_secret" } as const;
  }
  const human = await requireHumanActor();
  if (human.response) return human;
  return { actor: human.actor, authSource: "nextauth_allowlisted_human" } as const;
}

export async function requestActor(request: Request, internalActor = "hermes"): Promise<{ actor: string; response?: never } | { actor?: never; response: NextResponse }> {
  const result = await requestActorWithProvenance(request, internalActor);
  if (result.response) return result;
  return { actor: result.actor } as const;
}
