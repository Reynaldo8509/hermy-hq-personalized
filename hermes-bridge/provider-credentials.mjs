import fs from "node:fs";
import path from "node:path";

export const PROVIDER_CREDENTIAL_NAME = "provider-env";
export const PROVIDER_CREDENTIAL_KEYS = Object.freeze([
  "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
  "LLAMA_API_KEY", "TOKENHARBOR_API_KEY", "FREELLMAPI_API_KEY", "OPENCODE_ZEN_API_KEY",
]);
export const ROUTER_PROVIDER_KEYS = Object.freeze(["TOKENHARBOR_API_KEY", "OPENROUTER_API_KEY"]);
const BRIDGE_ONLY_SECRET_KEYS = Object.freeze(["INTERNAL_API_SECRET"]);

function safeCredentialError(code) {
  return Object.assign(new Error(code), { code, transportAttempted: false });
}

export function readProviderCredential(name, { env = process.env, fsImpl = fs } = {}) {
  if (!ROUTER_PROVIDER_KEYS.includes(String(name || ""))) throw safeCredentialError("credential_name_not_allowlisted");
  const directory = String(env?.CREDENTIALS_DIRECTORY || "");
  if (!path.isAbsolute(directory)) throw safeCredentialError("credential_directory_unavailable");
  const file = path.join(directory, PROVIDER_CREDENTIAL_NAME);
  let fd;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
      throw safeCredentialError("credential_file_rejected");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid() && stat.uid !== 0) {
      throw safeCredentialError("credential_owner_rejected");
    }
    const text = fsImpl.readFileSync(fd, "utf8");
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Z][A-Z0-9_]{1,63})=([^\r\n]*)$/);
      if (!match || !PROVIDER_CREDENTIAL_KEYS.includes(match[1]) || values.has(match[1])) {
        throw safeCredentialError("credential_file_format_rejected");
      }
      const value = match[2];
      if (!value || value !== value.trim() || /[\s"'`$\\]/.test(value)) {
        throw safeCredentialError("credential_value_format_rejected");
      }
      values.set(match[1], value);
    }
    const value = values.get(name);
    if (!value) throw safeCredentialError("credential_value_unavailable");
    return value;
  } catch (error) {
    if (String(error?.code || "").startsWith("credential_")) throw error;
    throw safeCredentialError("credential_read_failed");
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

export function sanitizeProviderEnvironment(source = {}) {
  const env = { ...source };
  for (const key of PROVIDER_CREDENTIAL_KEYS) delete env[key];
  for (const key of BRIDGE_ONLY_SECRET_KEYS) delete env[key];
  // systemd's credential directory is a path, not a secret. Keep it for the
  // Hermes CLI child so the pinned privacy transport profile can read one
  // authorized key without exposing provider or Bridge-to-HQ credentials in
  // the child environment.
  return env;
}
