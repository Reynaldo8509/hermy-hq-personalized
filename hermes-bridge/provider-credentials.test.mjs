import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROVIDER_CREDENTIAL_KEYS, readProviderCredential, sanitizeProviderEnvironment } from "./provider-credentials.mjs";

test("credential reader returns only allowlisted keys from the systemd credential directory", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hermy-credential-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "provider-env"), "TOKENHARBOR_API_KEY=synthetic-th\nOPENROUTER_API_KEY=synthetic-or\n", { mode: 0o600 });
  const env = { CREDENTIALS_DIRECTORY: directory, TOKENHARBOR_API_KEY: "ambient-value" };
  assert.equal(readProviderCredential("TOKENHARBOR_API_KEY", { env }), "synthetic-th");
  assert.equal(readProviderCredential("OPENROUTER_API_KEY", { env }), "synthetic-or");
  assert.throws(() => readProviderCredential("GROQ_API_KEY", { env }), /credential_name_not_allowlisted/);
  assert.throws(() => readProviderCredential("TOKENHARBOR_API_KEY", { env: { TOKENHARBOR_API_KEY: "ambient-value" } }), /credential_directory_unavailable/);
  const sanitized = sanitizeProviderEnvironment({ ...env, OPENROUTER_API_KEY: "ambient", CREDENTIALS_DIRECTORY: directory, SAFE: "ok" });
  assert.equal(sanitized.OPENROUTER_API_KEY, undefined);
  assert.equal(sanitized.TOKENHARBOR_API_KEY, undefined);
  assert.equal(sanitized.CREDENTIALS_DIRECTORY, directory);
  assert.equal(sanitized.SAFE, "ok");
});

test("credential reader rejects duplicates, loose permissions, and symlinks", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hermy-credential-deny-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "provider-env");
  const env = { CREDENTIALS_DIRECTORY: directory };
  writeFileSync(file, "TOKENHARBOR_API_KEY=one\nTOKENHARBOR_API_KEY=two\n", { mode: 0o600 });
  assert.throws(() => readProviderCredential("TOKENHARBOR_API_KEY", { env }), /credential_file_format_rejected/);
  writeFileSync(file, "TOKENHARBOR_API_KEY=synthetic\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => readProviderCredential("TOKENHARBOR_API_KEY", { env }), /credential_file_rejected/);
  rmSync(file);
  const target = path.join(directory, "target");
  writeFileSync(target, "TOKENHARBOR_API_KEY=synthetic\n", { mode: 0o600 });
  symlinkSync(target, file);
  assert.throws(() => readProviderCredential("TOKENHARBOR_API_KEY", { env }), /credential_read_failed/);
});

test("Hermes key_cmd helper reads a synthetic systemd credential without environment keys", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hermy-key-cmd-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "provider-env"), "TOKENHARBOR_API_KEY=synthetic-only-token\nOPENROUTER_API_KEY=synthetic-openrouter\n", { mode: 0o600 });
  const cleanEnv = sanitizeProviderEnvironment({
    ...process.env,
    CREDENTIALS_DIRECTORY: directory,
    TOKENHARBOR_API_KEY: "ambient-token-must-not-survive",
    OPENROUTER_API_KEY: "ambient-openrouter-must-not-survive",
  });
  assert.equal(cleanEnv.CREDENTIALS_DIRECTORY, directory);
  assert.equal(Object.keys(cleanEnv).some((key) => PROVIDER_CREDENTIAL_KEYS.includes(key)), false);
  const helper = new URL("./provider-credential-command.py", import.meta.url);
  const result = spawnSync("/usr/bin/python3", [helper.pathname, "TOKENHARBOR_API_KEY"], {
    env: cleanEnv, encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "synthetic-only-token");
  assert.equal(result.stderr, "");
});

test("Hermes key_cmd helper fails closed when a supplied systemd credential is missing", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hermy-key-cmd-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = new URL("./provider-credential-command.py", import.meta.url);
  const result = spawnSync("/usr/bin/python3", [helper.pathname, "TOKENHARBOR_API_KEY"], {
    env: { PATH: process.env.PATH, CREDENTIALS_DIRECTORY: directory, TOKENHARBOR_API_KEY: "ambient-must-not-be-used" },
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "credential_open_failed");
});
