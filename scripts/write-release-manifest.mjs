import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const lock = await readFile(path.join(root, "package-lock.json"));
const distDir = process.env.NEXT_DIST_DIR || ".next";
let nextBuildId = null;
try {
  nextBuildId = (await readFile(path.join(root, distDir, "BUILD_ID"), "utf8")).trim() || null;
} catch {}

const dirtyLines = run(["status", "--porcelain", "--untracked-files=all"]).split(String.fromCharCode(10));
const manifest = {
  git_sha: run(["rev-parse", "HEAD"]),
  git_dirty: dirtyLines.some((line) => line.trim() && !line.slice(3).endsWith("release_manifest.json")),
  build_timestamp_utc: new Date().toISOString(),
  source_path: root,
  package_lock_sha256: createHash("sha256").update(lock).digest("hex"),
  next_build_id: nextBuildId,
  release_name: process.env.HERMYHQ_RELEASE_NAME || path.basename(root),
};

await writeFile(path.join(root, "release_manifest.json"), JSON.stringify(manifest, null, 2) + String.fromCharCode(10), { mode: 0o600 });
console.log(JSON.stringify(manifest));
