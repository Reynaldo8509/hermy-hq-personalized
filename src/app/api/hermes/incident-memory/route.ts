import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requestActor } from "@/lib/human-auth";

export const dynamic = "force-dynamic";

const STOPWORDS = new Set(["para", "como", "donde", "desde", "sobre", "entre", "esta", "este", "estos", "estas", "solo", "todo", "toda", "cada", "porque", "cual", "puede", "quiero", "necesito", "debe", "deben", "hacer", "usar", "que", "con", "sin", "por", "del", "las", "los", "una", "uno", "unos", "unas", "sus"]);

function searchTerms(value: string) {
  const original = value.toLocaleLowerCase("es").match(/[\p{L}\p{N}_./:-]{3,}/gu) || [];
  const terms = new Set<string>();
  for (const token of original) {
    if (STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    terms.add(token);
    const plain = token.normalize("NFD").replace(/\p{M}/gu, "");
    if (plain !== token) terms.add(plain);
  }
  return [...terms].slice(0, 12);
}

// Internal read endpoint used by Hermes/Codex. It returns only bounded,
// sanitized incident context; query terms are evidence, never instructions.
export async function GET(req: Request) {
  const auth = await requestActor(req, "hermes");
  if (auth.response) return auth.response;
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 1200);
  const terms = searchTerms(query);
  const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
  if (agent && !["max", "codex", "atlas", "aegis", "ledger", "milo", "pulse", "domus", "hermes"].includes(agent)) {
    return NextResponse.json({ error: "Agente de memoria no válido" }, { status: 400 });
  }
  const patterns = terms.map((term) => "%" + term + "%");
  const where = !query
    ? Prisma.sql`TRUE`
    : !patterns.length
      ? Prisma.sql`FALSE`
      : Prisma.sql`(incident ILIKE ANY(ARRAY[${Prisma.join(patterns)}]::text[]) OR evidence ILIKE ANY(ARRAY[${Prisma.join(patterns)}]::text[]))`;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, fingerprint, incident, evidence, cause, hypothesis, remediation, validation,
           limitations, next_action, provider, model, duration_ms, invalid_duration_ms, cause_confirmed, status, agent, request_id,
           created_at, updated_at, closed_at
    FROM "IncidentMemory"
    WHERE ${where} ${agent ? Prisma.sql`AND lower(agent) = ${agent}` : Prisma.empty}
    ORDER BY updated_at DESC
    LIMIT 50`;
  return NextResponse.json({ incidents: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value instanceof Date ? value.toISOString() : value,
  ]))) });
}
