import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch("http://127.0.0.1:8123/", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    const reachable = response.ok;
    return NextResponse.json({
      reachable,
      summary: reachable ? "Home Assistant responde desde el VPS." : `Home Assistant respondió HTTP ${response.status}.`,
      checkedAt,
    }, {
      status: reachable ? 200 : 503,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch {
    return NextResponse.json(
      { reachable: false, summary: "Home Assistant no responde desde el VPS.", checkedAt },
      { status: 503, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  }
}
