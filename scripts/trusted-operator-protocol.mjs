import { createHash, createPublicKey } from "node:crypto";

export const TRUSTED_CODEX_OPERATOR_ID = process.env.HERMY_TRUSTED_OPERATOR_ID || "codex-trusted-operator";

export function operatorFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const digest = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  return `sha256:${digest}`;
}

export function canonicalOperatorMessage({ operatorId, method, pathAndQuery, timestamp, nonce, rawBody }) {
  const bodyDigest = createHash("sha256").update(Buffer.from(rawBody || "", "utf8")).digest("hex");
  return Buffer.from([
    "hermy-trusted-operator-v1",
    String(operatorId),
    String(method).toUpperCase(),
    String(pathAndQuery),
    String(timestamp),
    String(nonce),
    bodyDigest,
  ].join("\n"), "utf8");
}
