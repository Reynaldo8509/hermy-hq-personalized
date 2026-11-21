import { timingSafeEqual } from "node:crypto";

export function internalSecretMatches(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string" || !supplied || !expected) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}
