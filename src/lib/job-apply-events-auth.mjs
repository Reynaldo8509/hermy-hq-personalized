import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CREDENTIAL_NAME = "job-apply-events-token";

export function authorizeJobApplyEventsToken(supplied, credentialDirectory = process.env.CREDENTIALS_DIRECTORY) {
  if (typeof supplied !== "string" || supplied.length === 0) {
    return { status: 401, error: "unauthorized" };
  }
  if (supplied.length > 256 || !credentialDirectory) {
    return { status: credentialDirectory ? 403 : 503, error: credentialDirectory ? "forbidden" : "authorization_unavailable" };
  }

  let expected;
  try {
    const credentialPath = join(credentialDirectory, CREDENTIAL_NAME);
    const metadata = lstatSync(credentialPath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0
        || metadata.size < 32 || metadata.size > 512) {
      return { status: 503, error: "authorization_unavailable" };
    }
    expected = readFileSync(credentialPath, "utf8").trim();
  } catch {
    return { status: 503, error: "authorization_unavailable" };
  }
  if (expected.length < 32 || expected.length > 256) {
    return { status: 503, error: "authorization_unavailable" };
  }

  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return { status: 403, error: "forbidden" };
  }
  return { status: 200, error: null };
}
