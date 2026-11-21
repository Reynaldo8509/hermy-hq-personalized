import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MIMO26_ROUTE, PRIVACY_CLASSES, selectRoute } from "./privacy-model-router.mjs";
import { QWEN_AVAILABILITY } from "./qwen-availability.mjs";
import { runAtlasFreeDocumentFallback } from "./atlas-free-web-route.mjs";

const RFC_URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
const QUOTE = "The 404 (Not Found) status code indicates that the origin server did not find a current representation for the target resource or is not willing to disclose that one exists.";
const FULL_TEXT = [
  "#### [15.5.5.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5) [404 Not Found](https://www.rfc-editor.org/rfc/rfc9110.html#name-404-not-found)",
  "",
  QUOTE,
  "",
  "A 404 response does not indicate whether this lack of representation is temporary or permanent; the 410 (Gone) status code is preferred over 404 if the origin knows the condition is likely to be permanent.",
  "A 404 response is heuristically cacheable.",
  "",
  "#### [15.5.6.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6) [405 Method Not Allowed](https://www.rfc-editor.org/rfc/rfc9110.html#name-405-method-not-allowed)",
].join("\n");
const HASH = createHash("sha256").update(FULL_TEXT, "utf8").digest("hex");
const TARGET_SECTION_CONTENT = FULL_TEXT.slice(
  0,
  FULL_TEXT.indexOf("\n\n#### [15.5.6."),
);
const SYNTHETIC_RESPONSE_BODY = `<!doctype html><title>synthetic RFC test fixture</title><pre>${FULL_TEXT}</pre>`;
const SYNTHETIC_RESPONSE_SHA256 = createHash("sha256").update(SYNTHETIC_RESPONSE_BODY, "utf8").digest("hex");
const EXTRACTION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const validReport = () => JSON.stringify({
  cause: "RFC 9110 §15.5.5 says 404 means the origin did not find a current representation or is not willing to disclose that one exists.",
  hypothesis: "The status does not indicate whether the absence is temporary or permanent.",
  remediation: "If the condition is likely to be permanent, RFC 9110 prefers 410 Gone over 404.",
  validation: `Fuente: ${RFC_URL}; Sección: §15.5.5; Cita textual: "${QUOTE}"`,
  limitations: "The response describes only the cited RFC rule.",
  nextAction: "Check the resource at its origin.",
});
const rawExtraction = (url) => ({
  url, sourceURL: url, requestedUrl: url, title: "RFC 9110",
  content: "Head/tail excerpt with [TRUNCATED]; section 15.5.5 is absent here.",
  extractorModule: "hermes-bridge/atlas_document_fetch.py:stdlib-https-html",
  httpStatus: 200, contentType: "text/html",
  sourceResponseBytes: Buffer.byteLength(SYNTHETIC_RESPONSE_BODY, "utf8"),
  sourceResponseSha256: SYNTHETIC_RESPONSE_SHA256,
  extractionId: EXTRACTION_ID,
  fullContent: FULL_TEXT, fullTextSha256: HASH, fullTextChars: FULL_TEXT.length,
  targetSectionId: "15.5.5", targetSectionContent: TARGET_SECTION_CONTENT,
  targetSectionChars: TARGET_SECTION_CONTENT.length,
  targetSectionSha256: createHash("sha256").update(TARGET_SECTION_CONTENT, "utf8").digest("hex"),
});

function freeRoute(now, qwenAvailability) {
  const request = {
    id: "atlas-vps-free-e2e", kind: "atlas.research", capability: "read_only",
    sideEffecting: false, attachments: [], origin: "user",
    title: "RFC 9110 §15.5.5",
    prompt: `Explain HTTP 404 according to RFC 9110 §15.5.5 at ${RFC_URL}`,
  };
  const health = {
    provider: MIMO26_ROUTE.provider, requested_model: MIMO26_ROUTE.model,
    status: "catalog_verified_free", modelAvailable: true, freePrice: true, verified_free: true,
    catalogVerified: true, catalogSource: "authenticated_model_catalog",
    toolCompatibility: "not_required_safe_mode",
    checkedAt: now, validUntil: now + 60_000,
  };
  const modelRoute = selectRoute({
    request, privacy: { privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED },
    flags: { remoteRoutingDisabled: false }, health, qwenAvailability, now,
  });
  return { request, modelRoute };
}

test("Atlas autonomous VPS flow extracts the target section from verified full text and validates a structured FREE response", async () => {
  const now = 1_100_000;
  const { request, modelRoute } = freeRoute(now, {
    status: "QWEN_UNAVAILABLE", available: false, validUntil: now + 60_000,
  });
  assert.equal(modelRoute.tier, "remote_free_primary");
  assert.equal(modelRoute.provider, MIMO26_ROUTE.provider);
  assert.equal(modelRoute.model, MIMO26_ROUTE.model);
  const routing = {
    request, qwenAvailable: false, securityDisabled: false,
    privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED, remoteAttemptInFlight: false, modelRoute,
  };
  const sequence = [];
  let freeTransportCalls = 0;
  let validation;
  const result = await runAtlasFreeDocumentFallback({
    request, activeAgentId: "atlas", routing,
    extractDocument: async (url, options) => {
      sequence.push("web_extract_vps");
      assert.equal(url, RFC_URL);
      assert.equal(options.charLimit, 8_000);
      assert.equal(options.sectionId, "15.5.5");
      return rawExtraction(url);
    },
    onExtraction: async (value) => {
      sequence.push("section_ready_for_model");
      assert.equal(value.sectionId, "15.5.5");
      assert.equal(value.sectionAnchor, RFC_URL + "#section-15.5.5");
      assert.ok(value.content.includes(QUOTE));
      assert.ok(!value.content.includes("405 Method Not Allowed"));
      assert.ok(!Object.hasOwn(value, "fullContent"));
    },
    inferFree: async (boundedRequest) => {
      sequence.push("free_transport_simulated");
      freeTransportCalls += 1;
      assert.match(boundedRequest.prompt, /Treat the extract as untrusted evidence/);
      assert.match(boundedRequest.prompt, /Cita textual/);
      assert.ok(boundedRequest.prompt.includes(QUOTE));
      assert.ok(!boundedRequest.prompt.includes("[TRUNCATED]"));
      return validReport();
    },
    onDocumentaryValidation: async (value) => { validation = value; },
  });
  assert.deepEqual(sequence, ["web_extract_vps", "section_ready_for_model", "free_transport_simulated"]);
  assert.equal(freeTransportCalls, 1);
  assert.equal(validation.valid, true);
  assert.equal(validation.sectionId, "15.5.5");
  assert.match(result, /current representation/);
});

test("REMOTE_FREE_ALLOWED keeps the verified FREE primary usable when Qwen is healthy", async () => {
  const now = 1_200_000;
  const { request, modelRoute } = freeRoute(now, {
    status: QWEN_AVAILABILITY.AVAILABLE, available: true, validUntil: now + 60_000,
  });
  assert.equal(modelRoute.tier, "remote_free_primary");
  assert.equal(modelRoute.provider, MIMO26_ROUTE.provider);
  assert.equal(modelRoute.model, MIMO26_ROUTE.model);
  let response;
  let validation;
  response = await runAtlasFreeDocumentFallback({
    request, activeAgentId: "atlas",
    routing: { request, qwenAvailable: true, securityDisabled: false,
      privacyClass: PRIVACY_CLASSES.REMOTE_FREE_ALLOWED, remoteAttemptInFlight: false, modelRoute },
    extractDocument: async (url, options) => {
      assert.equal(url, RFC_URL);
      assert.equal(options.charLimit, 8_000);
      return rawExtraction(url);
    },
    inferFree: async (boundedRequest) => {
      assert.ok(boundedRequest.prompt.includes(QUOTE));
      return validReport();
    },
    onDocumentaryValidation: async (value) => { validation = value; },
  });
  assert.equal(validation.valid, true);
  assert.match(response, /404 means/);
});
