import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COLLECTION_PATH = "/api/mcp/restart-requests";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

function readServiceCredential(name, credentialDirectory = process.env.CREDENTIALS_DIRECTORY) {
  if (!credentialDirectory || !/^[a-z0-9-]{1,80}$/.test(name) || typeof process.getuid !== "function") return null;
  let fd;
  try {
    const directory = lstatSync(credentialDirectory);
    if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) return null;
    const path = join(credentialDirectory, name);
    const before = lstatSync(path);
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 ||
        (before.mode & 0o077) !== 0 || before.size < 32 || before.size > 4096) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const after = fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.uid !== process.getuid() || (after.mode & 0o077) !== 0 || after.size !== before.size) return null;
    const value = readFileSync(fd, "utf8");
    if (Buffer.byteLength(value, "utf8") !== after.size) return null;
    return value;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Do not turn a completed read into an authorization error. */ }
    }
  }
}

function matchesRequest(method, requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.includes("?") || requestUrl.includes("#")) return false;
  try {
    const url = new URL(requestUrl);
    if (url.search || url.hash || url.username || url.password) return false;
    if (method === "POST") return url.pathname === COLLECTION_PATH;
    if (method === "GET") return /^\/api\/mcp\/restart-requests\/[A-Za-z0-9_-]{1,80}$/.test(url.pathname);
    return false;
  } catch {
    return false;
  }
}

function equalSecret(supplied, expected) {
  if (typeof supplied !== "string" || !TOKEN_PATTERN.test(supplied) ||
      typeof expected !== "string" || !TOKEN_PATTERN.test(expected)) return false;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeMcpRestartRequest(method, requestUrl, supplied, credentialDirectory) {
  if (!matchesRequest(method, requestUrl)) {
    const pathname = (() => { try { return new URL(requestUrl).pathname; } catch { return ""; } })();
    const underCollection = pathname === COLLECTION_PATH || pathname.startsWith(`${COLLECTION_PATH}/`);
    return { status: underCollection ? 405 : 403, error: underCollection ? "method_or_path_not_allowed" : "forbidden" };
  }
  if (typeof supplied !== "string" || !TOKEN_PATTERN.test(supplied)) {
    return { status: 401, error: "unauthorized" };
  }
  const expected = readServiceCredential("mcp-restart-request-token", credentialDirectory);
  if (!expected || !TOKEN_PATTERN.test(expected)) return { status: 503, error: "authorization_unavailable" };
  return equalSecret(supplied, expected)
    ? { status: 200, error: null }
    : { status: 403, error: "forbidden" };
}

export function isMcpRestartCredentialPath(pathname) {
  return typeof pathname === "string" &&
    (pathname === COLLECTION_PATH || pathname.startsWith(`${COLLECTION_PATH}/`));
}
