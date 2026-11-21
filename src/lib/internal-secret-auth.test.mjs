import test from "node:test";
import assert from "node:assert/strict";
import { internalSecretMatches } from "./internal-secret-auth.mjs";

test("compares configured internal secrets exactly and in constant time", () => {
  assert.equal(internalSecretMatches("synthetic-secret", "synthetic-secret"), true);
  assert.equal(internalSecretMatches("synthetic-secret", "synthetic-secreu"), false);
  assert.equal(internalSecretMatches("short", "synthetic-secret"), false);
  assert.equal(internalSecretMatches("synthetic-secret", ""), false);
  assert.equal(internalSecretMatches(null, "synthetic-secret"), false);
});

test("accepts only the rotated credential and rejects the previous, missing, and wrong values", () => {
  const previous = `previous-${"p".repeat(48)}`;
  const current = `rotated-${"r".repeat(48)}`;

  assert.equal(internalSecretMatches(current, current), true);
  assert.equal(internalSecretMatches(previous, current), false);
  assert.equal(internalSecretMatches(undefined, current), false);
  assert.equal(internalSecretMatches("incorrect", current), false);
  assert.equal(internalSecretMatches(current, undefined), false);
});

test("internal routes share the canonical env contract and contain no legacy fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const routes = [
    "src/proxy.ts",
    "src/lib/human-auth.ts",
    "src/app/api/cache/clear/route.ts",
    "src/app/api/trends/update/route.ts",
    "src/app/api/watchlist-radar/update/route.ts",
    "src/app/api/youtube/ideas/route.ts",
    "src/app/api/milo/access-token/route.ts",
    "src/app/api/milo/report/route.ts",
  ];

  for (const route of routes) {
    const source = await readFile(resolve(root, route), "utf8");
    assert.match(source, /internalSecretMatches/, `${route} must use the shared authenticator`);
    assert.doesNotMatch(source, /process\.env\.INTERNAL_SECRET\b/, `${route} must not use the legacy variable`);
    assert.doesNotMatch(source, /\bSECRET\s*=\s*["'][a-f0-9]{40,}["']/i, `${route} must not define a literal fallback`);
  }
});
