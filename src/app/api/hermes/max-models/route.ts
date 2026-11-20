import { NextResponse } from "next/server";
import { requireHumanActor } from "@/lib/human-auth";
import { fetchMaxExcelntModels } from "@/lib/max-hermes-catalog.mjs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const auth = await requireHumanActor();
  if (auth.response) return NextResponse.json(await auth.response.json(), { status: auth.response.status });
  try {
    const models = await fetchMaxExcelntModels();
    return NextResponse.json({ provider: "excelnt", models }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudo leer el catálogo autenticado de EXCELNT desde Hermes." }, { status: 503 });
  }
}
