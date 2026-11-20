import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const raw = await readFile(path.join(process.cwd(), "release_manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    const safe = {
      git_sha: typeof manifest.git_sha === "string" ? manifest.git_sha : null,
      git_dirty: typeof manifest.git_dirty === "boolean" ? manifest.git_dirty : null,
      build_timestamp_utc: typeof manifest.build_timestamp_utc === "string" ? manifest.build_timestamp_utc : null,
      package_lock_sha256: typeof manifest.package_lock_sha256 === "string" ? manifest.package_lock_sha256 : null,
      next_build_id: typeof manifest.next_build_id === "string" ? manifest.next_build_id : null,
      release_name: typeof manifest.release_name === "string" ? manifest.release_name : null,
    };
    return NextResponse.json(safe, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return NextResponse.json({ error: "release manifest unavailable" }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
