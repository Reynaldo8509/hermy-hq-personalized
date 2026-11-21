import { NextResponse } from "next/server";
import { requireHumanActor } from "@/lib/human-auth";
import { normalizeAACatalog } from "@/lib/artificial-analysis.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const API_URL = "https://artificialanalysis.ai/api/v2/language/models/free?page=1";
const CACHE_SECONDS = 6 * 60 * 60;
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

function safeFailure(status: number) {
  if (status === 401) return { code: "invalid_key", message: "La clave del servidor fue rechazada por Artificial Analysis." };
  if (status === 403) return { code: "plan_unavailable", message: "La cuenta no tiene acceso a este conjunto de datos." };
  if (status === 429) return { code: "rate_limited", message: "Se agotó la cuota de Artificial Analysis; se respetará su ventana de restablecimiento." };
  return { code: "provider_unavailable", message: "Artificial Analysis no está respondiendo ahora." };
}

export async function GET() {
  const auth = await requireHumanActor();
  if (auth.response) return auth.response;

  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: { code: "not_configured", message: "Configura ARTIFICIAL_ANALYSIS_API_KEY en el entorno privado de Hermy HQ." } }, { status: 503, headers: PRIVATE_NO_STORE });
  }

  try {
    const upstream = await fetch(API_URL, {
      headers: { accept: "application/json", "x-api-key": apiKey },
      next: { revalidate: CACHE_SECONDS },
      signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) {
      const error = safeFailure(upstream.status);
      const rateLimitReset = Number(upstream.headers.get("x-ratelimit-reset"));
      return NextResponse.json({ error, rateLimitReset: Number.isFinite(rateLimitReset) && rateLimitReset > 0 ? rateLimitReset : null }, {
        status: upstream.status === 429 ? 429 : 503,
        headers: PRIVATE_NO_STORE,
      });
    }

    const payload: unknown = await upstream.json();
    const catalog = normalizeAACatalog(payload);
    if (!catalog.models.length) {
      return NextResponse.json({ error: { code: "invalid_catalog", message: "La respuesta no contenía modelos utilizables." } }, { status: 502, headers: PRIVATE_NO_STORE });
    }
    const limit = Number(upstream.headers.get("x-ratelimit-limit"));
    const remaining = Number(upstream.headers.get("x-ratelimit-remaining"));
    const reset = Number(upstream.headers.get("x-ratelimit-reset"));
    return NextResponse.json({
      catalog,
      quota: {
        limit: Number.isFinite(limit) ? limit : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
        cacheSeconds: CACHE_SECONDS,
      },
    }, { headers: PRIVATE_NO_STORE });
  } catch {
    return NextResponse.json({ error: { code: "upstream_timeout", message: "No se pudo consultar el catálogo dentro del límite de espera." } }, { status: 503, headers: PRIVATE_NO_STORE });
  }
}
