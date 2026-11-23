import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizeMcpRestartRequest, isMcpRestartCredentialPath } from "./mcp-restart-service-auth.mjs";

const token = "a".repeat(43);
const requestId = "0123456789abcdef0123456789abcdef01234567";

function withCredentials(run) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-restart-auth-test-"));
  chmodSync(directory, 0o700);
  const tokenPath = join(directory, "mcp-restart-request-token");
  writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });
  try { return run({ directory, tokenPath }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("accepts only the dedicated create and dynamic status routes", () => {
  withCredentials(({ directory }) => {
    assert.deepEqual(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", token, directory),
      { status: 200, error: null });
    assert.deepEqual(authorizeMcpRestartRequest("GET", `https://hq.invalid/api/mcp/restart-requests/${requestId}`, token, directory),
      { status: 200, error: null });
    assert.equal(isMcpRestartCredentialPath("/api/mcp/restart-requests"), true);
    assert.equal(isMcpRestartCredentialPath(`/api/mcp/restart-requests/${requestId}`), true);
    assert.equal(isMcpRestartCredentialPath("/api/mcp/restart-requests-extra"), false);
  });
});

test("rejects missing, incorrect, and malformed credentials", () => {
  withCredentials(({ directory }) => {
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", undefined, directory).status, 401);
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", "b".repeat(43), directory).status, 403);
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", "short", directory).status, 401);
  });
});

test("fails closed for methods, paths, query strings, and fragments", () => {
  withCredentials(({ directory }) => {
    for (const [method, url, status] of [
      ["PATCH", `https://hq.invalid/api/mcp/restart-requests/${requestId}`, 405],
      ["POST", `https://hq.invalid/api/mcp/restart-requests/${requestId}`, 405],
      ["GET", `https://hq.invalid/api/mcp/restart-requests/${requestId}?debug=1`, 405],
      ["GET", `https://hq.invalid/api/mcp/restart-requests/${requestId}#fragment`, 405],
      ["GET", "https://hq.invalid/api/hermes/activity", 403],
    ]) {
      const result = authorizeMcpRestartRequest(method, url, token, directory);
      assert.equal(result.status, status, `${method} ${url}`);
    }
  });
});

test("rejects missing or insecure credential sources", () => {
  assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", token, join(tmpdir(), "missing-mcp-credentials")).status, 503);
  withCredentials(({ directory, tokenPath }) => {
    chmodSync(tokenPath, 0o644);
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", token, directory).status, 503);
  });
  const directory = mkdtempSync(join(tmpdir(), "mcp-restart-auth-link-test-"));
  chmodSync(directory, 0o700);
  const target = join(directory, "target");
  const tokenPath = join(directory, "mcp-restart-request-token");
  writeFileSync(target, token, { mode: 0o600 });
  symlinkSync(target, tokenPath);
  try {
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", token, directory).status, 503);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const insecureDirectory = mkdtempSync(join(tmpdir(), "mcp-restart-auth-mode-test-"));
  chmodSync(insecureDirectory, 0o755);
  writeFileSync(join(insecureDirectory, "mcp-restart-request-token"), token, { mode: 0o600 });
  try {
    assert.equal(authorizeMcpRestartRequest("POST", "https://hq.invalid/api/mcp/restart-requests", token, insecureDirectory).status, 503);
  } finally { rmSync(insecureDirectory, { recursive: true, force: true }); }
});
