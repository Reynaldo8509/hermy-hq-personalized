import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractExcelntModels } from "./max-hermes-selection.mjs";

export function readMaxHermesBearer({ env = process.env, readFile = readFileSync } = {}) {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) throw new Error("hermes_service_credential_unavailable");
  const token = String(readFile(join(dir, "max-hq-api-server-key"), "utf8")).trim();
  if (token.length < 16 || /[\r\n\0]/.test(token)) throw new Error("hermes_service_credential_invalid");
  return token;
}

export function maxHermesProfileBase(env = process.env) {
  const raw = env.HERMES_MAX_HQ_API_BASE_URL || "http://127.0.0.1:8642/p/max-hq";
  const url = new URL(raw);
  if (!(["127.0.0.1", "::1", "localhost"].includes(url.hostname)) || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("hermes_api_must_be_loopback");
  }
  return raw.replace(/\/$/, "");
}

export async function fetchMaxExcelntModels({ env = process.env, fetchImpl = fetch, readFile = readFileSync } = {}) {
  const token = readMaxHermesBearer({ env, readFile });
  const url = `${maxHermesProfileBase(env)}/api/model/options`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error(`hermes_model_options_http_${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("hermes_model_options_invalid_json"); }
  return extractExcelntModels(payload);
}
