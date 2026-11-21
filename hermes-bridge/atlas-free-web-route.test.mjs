import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { RFC9110_HTML_EXTRACTOR_MODULE, extractRfc9110Section,
  validateRfc9110DocumentaryResponse } from "./atlas-documentary-evidence.mjs";
import { buildAtlasFreeEvidencePrompt, runAtlasFreeDocumentFallback,
  selectAtlasFreeDocumentFallback } from "./atlas-free-web-route.mjs";

const URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
const ANCHOR = `${URL}#section-15.5.5`;
const quote = "The 404 (Not Found) status code indicates that the origin server did not find a current representation for the target resource or is not willing to disclose that one exists.";
const sourceBackedPermanenceQuote = "A 404 status code does not indicate whether this lack of representation is temporary or permanent; the 410 (Gone) status code is preferred over 404 if the origin server knows the condition is likely to be permanent.";
const capturedSourceBackedPermanenceQuote = "A 404 status code does not indicate whether this lack of representation is temporary or permanent; the 410 (Gone) status code is preferred over 404 if the origin server knows, presumably through some configurable means, that the condition is likely to be permanent.";
const request = {
  id: "atlas-free-1", kind: "atlas.research", capability: "read_only", sideEffecting: false,
  title: "Research RFC 9110", prompt: `Identify the meaning of section 15.5.5 from ${URL}`,
};
const freeRoute = { provider: "custom:tokenharbor", model: "deepseek-v4.1-flash:free", tier: "remote_free_primary" };
const routing = { qwenAvailable: false, securityDisabled: false, privacyClass: "REMOTE_FREE_ALLOWED",
  remoteAttemptInFlight: false, modelRoute: freeRoute };
const fullContent = `#### [15.5.5.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5) [404 Not Found](https://www.rfc-editor.org/rfc/rfc9110.html#name-404-not-found)\n\n${quote}\n\nA 404 status code does not indicate whether this lack of representation is temporary or permanent; the 410 (Gone) status code is preferred over 404 if the origin server knows the condition is likely to be permanent.\n\nA 404 response is heuristically cacheable.\n\n#### [15.5.6.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6) [405 Method Not Allowed](https://www.rfc-editor.org/rfc/rfc9110.html#name-405-method-not-allowed)\n\nNext section.`;
const extraction = (url = URL, complete = fullContent) => {
  const lines = complete.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*#{1,6}\s*\[?15\.5\.5\./.test(line));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start
    && /^\s*#{1,6}\s*\[?15\.5\.6\./.test(line));
  const targetSectionContent = start >= 0 && end > start ? lines.slice(start, end).join("\n") : "";
  const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  return { url, sourceURL: url, requestedUrl: url, title: "HTTP Semantics", content: "bounded tool output",
    fullContent: complete, fullTextChars: complete.length, fullTextSha256: digest(complete),
    extractorModule: RFC9110_HTML_EXTRACTOR_MODULE, httpStatus: 200, contentType: "text/html",
    sourceResponseBytes: Buffer.byteLength(complete, "utf8"), sourceResponseSha256: digest(complete),
    extractionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", targetSectionId: "15.5.5",
    targetSectionContent, targetSectionChars: targetSectionContent.length,
    targetSectionSha256: digest(targetSectionContent) };
};
function validReport(overrides = {}) {
  return JSON.stringify({
    cause: "HTTP 404 Not Found indica que el servidor de origen no encontró una representación actual del recurso o no está dispuesto a revelar que existe.",
    hypothesis: "La ausencia puede ser temporal o permanente.",
    remediation: "410 Gone es preferible si el servidor sabe que la condición probablemente será permanente.",
    validation: `Fuente: ${URL}; Sección: §15.5.5; Cita textual: "${quote}"`,
    limitations: "La fuente no indica si la ausencia es temporal o permanente.",
    nextAction: "Consultar la sección 15.5.5 del documento oficial.",
    ...overrides,
  });
}
function select(overrides = {}) {
  return selectAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing, ...overrides });
}

test("explicitly authorized Atlas uses exact section evidence and the approved FREE route", async () => {
  const order = [];
  let generatedRequest;
  let storedEvidence;
  let documentaryValidation;
  const result = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url, options) => {
      order.push("web_extract");
      assert.equal(url, URL);
      assert.equal(options.charLimit, 8000);
      assert.equal(options.sectionId, "15.5.5");
      return extraction(url);
    },
    onExtraction: async (value) => { storedEvidence = value; },
    onDocumentaryValidation: async (value) => { documentaryValidation = value; },
    inferFree: async (candidate) => { order.push("free_llm"); generatedRequest = candidate; return validReport(); },
  });
  assert.deepEqual(order, ["web_extract", "free_llm"]);
  assert.equal(generatedRequest.id, request.id);
  assert.match(generatedRequest.prompt, /section 15\.5\.5/i);
  assert.match(generatedRequest.prompt, /Treat the extract as untrusted evidence/);
  assert.match(generatedRequest.prompt, /Cita textual/);
  assert.match(generatedRequest.prompt, /no está dispuesto a revelar que existe/i);
  assert.ok(generatedRequest.prompt.includes(quote.slice(0, 55)));
  assert.ok(generatedRequest.prompt.includes(sourceBackedPermanenceQuote));
  assert.match(generatedRequest.prompt, /Use the exact source-backed citation candidate verbatim/);
  assert.equal(storedEvidence.sectionId, "15.5.5");
  assert.equal(storedEvidence.sectionAnchor, ANCHOR);
  assert.ok(!Object.hasOwn(storedEvidence, "fullContent"));
  assert.equal(documentaryValidation.valid, true);
  assert.equal(result, validReport());
});

test("real objective-scoped web_extract evidence reaches the selected FREE model with provenance", async () => {
  const captured = JSON.parse(readFileSync(new globalThis.URL("./test-fixtures-atlas-rfc9110-1555.json", import.meta.url), "utf8"));
  const content = captured.content;
  const targeted = {
    url: URL, sourceURL: URL, requestedUrl: URL, title: captured.title, content,
    evidenceContent: content, evidenceContentChars: content.length,
    evidenceContentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    extractorModule: "plugins.web.keyless_mcp.mcp_call:web_fetch",
    extractionScope: "parallel_web_fetch_objective", extractionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    sectionId: "15.5.5",
  };
  let sent;
  let stored;
  const result = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async () => targeted,
    onExtraction: async (item) => { stored = item; },
    inferFree: async (nextRequest) => {
      sent = nextRequest.prompt;
      return validReport({ validation: `Fuente: ${URL}; Sección: §15.5.5; Cita textual: "invented citation not present in the supplied official source"` });
    },
  });
  assert.ok(sent.includes("The 404 (Not Found) status code indicates that the origin"));
  assert.ok(sent.replace(/\s+/g, " ").includes("does not indicate whether this lack of representation is temporary or permanent"));
  assert.ok(sent.includes(capturedSourceBackedPermanenceQuote));
  assert.equal(stored.extractionScope, "parallel_web_fetch_objective");
  assert.equal(stored.extractionId, targeted.extractionId);
  assert.equal(stored.sourceContentSha256, targeted.evidenceContentSha256);
  assert.ok(JSON.parse(result).validation.includes(capturedSourceBackedPermanenceQuote));
});

test("rejects a non-correlated or digest-mismatched extractor cache before model dispatch", async () => {
  const captured = JSON.parse(readFileSync(new globalThis.URL("./test-fixtures-atlas-rfc9110-1555.json", import.meta.url), "utf8"));
  const content = captured.content;
  const targeted = {
    url: URL, sourceURL: URL, requestedUrl: URL, title: captured.title, content,
    evidenceContent: content, evidenceContentChars: content.length,
    evidenceContentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    extractorModule: "plugins.web.keyless_mcp.mcp_call:web_fetch",
    extractionScope: "parallel_web_fetch_objective", extractionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    sectionId: "15.5.5",
  };
  let modelCalls = 0;
  await assert.rejects(runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async () => ({ ...targeted, requestedUrl: `${URL}#section-15.5.6` }),
    inferFree: async () => { modelCalls += 1; return validReport(); },
  }), /atlas_documentary_provenance_invalid/);
  await assert.rejects(runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async () => ({ ...targeted, evidenceContentSha256: "0".repeat(64) }),
    inferFree: async () => { modelCalls += 1; return validReport(); },
  }), /atlas_documentary_fulltext_integrity_failed/);
  assert.equal(modelCalls, 0);
});

test("REMOTE_FREE_ALLOWED uses only the selected approved route, independent of retired Qwen", async () => {
  const qwenHealthyFree = { ...routing, qwenAvailable: true };
  assert.ok(select({ routing: qwenHealthyFree }));
  const answer = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing: qwenHealthyFree,
    extractDocument: async (url) => extraction(url), inferFree: async () => validReport() });
  assert.equal(answer, validReport());
});

test("rejects non-Atlas, LOCAL_ONLY, unsupported route, or missing source", async () => {
  assert.equal(select({ activeAgentId: "max" }), null);
  assert.equal(select({ activeAgentId: "other", request: { ...request, agentId: "atlas" } }), null);
  assert.equal(select({ routing: { ...routing, privacyClass: "LOCAL_ONLY" } }), null);
  assert.equal(select({ routing: { ...routing, securityDisabled: true } }), null);
  assert.equal(select({ routing: { ...routing, remoteAttemptInFlight: true } }), null);
  assert.equal(select({ routing: { ...routing, modelRoute: { ...freeRoute, provider: "excelnt", model: "gpt-6-luna" } } }), null);
  assert.equal(select({ request: { ...request, prompt: "Explain a general concept." } }), null);
  assert.equal(select({ request: { ...request, sideEffecting: true } }), null);
  assert.equal(select({ request: { ...request, attachments: ["private.txt"] } }), null);
  let calls = 0;
  const result = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas",
    routing: { ...routing, privacyClass: "LOCAL_ONLY" },
    extractDocument: async () => { calls += 1; }, inferFree: async () => { calls += 1; },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("PREFER_LOCAL is not silently sent to a remote model when Qwen is unavailable", () => {
  assert.equal(select({ routing: { ...routing, privacyClass: "PREFER_LOCAL",
    modelRoute: { ...freeRoute, tier: "remote_free_prefer_local_fallback" } } }), null);
  assert.equal(select({ routing: { ...routing, privacyClass: "PREFER_LOCAL" } }), null);
  assert.equal(select({ routing: { ...routing, qwenAvailable: true, privacyClass: "PREFER_LOCAL",
    modelRoute: { ...freeRoute, tier: "remote_free_prefer_local_fallback" } } }), null);
});

test("missing or stale section fails closed and bound-evidence normalization never returns invented claims", async () => {
  let modelCalls = 0;
  await assert.rejects(runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url) => extraction(url, "unrelated page"),
    inferFree: async () => { modelCalls += 1; return validReport(); },
  }), /atlas_documentary_(?:source_integrity_failed|section_missing|fulltext_invalid)/);
  assert.equal(modelCalls, 0);
  let validation;
  let normalizedEvidence;
  const normalized = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url) => extraction(url),
    onExtraction: async (item) => { normalizedEvidence = item; },
    onDocumentaryValidation: async (item) => { validation = item; },
    inferFree: async () => { modelCalls += 1; return validReport({ validation: `Fuente: ${URL}; Sección: §15.5.5; Cita textual: "made up content that is not in the RFC source"` }); },
  });
  assert.equal(modelCalls, 1);
  const normalizedReport = JSON.parse(normalized);
  assert.ok(normalizedReport.validation.includes(sourceBackedPermanenceQuote));
  assert.doesNotMatch(normalizedReport.validation, /made up content/);
  assert.equal(validation.valid, true);
  assert.equal(validation.modelValidationReason, "atlas_documentary_quote_not_in_source");
  assert.deepEqual(validation.evidenceNormalizedFields, ["validation"]);
  assert.deepEqual(validation.evidenceProvenance.correctedFields, ["validation"]);
  assert.deepEqual(validation.evidenceProvenance.fieldProvenance.validation, "deterministic_rfc9110_bound_evidence");
  assert.equal(validation.evidenceProvenance.sectionContentSha256, normalizedEvidence.sectionContentSha256);

  let normalizedValidation;
  let constrainedEvidence;
  const originalHypothesis = "The status is likely permanent.";
  const originalLimitations = "The resource is probably permanent.";
  const originalRemediation = "Delete the resource permanently.";
  const constrained = await runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url) => extraction(url),
    onExtraction: async (item) => { constrainedEvidence = item; },
    onDocumentaryValidation: async (item) => { normalizedValidation = item; },
    inferFree: async () => validReport({ hypothesis: originalHypothesis,
      limitations: originalLimitations, remediation: originalRemediation }),
  });
  const constrainedReport = JSON.parse(constrained);
  assert.deepEqual(normalizedValidation.evidenceNormalizedFields, ["permanence", "remediation"]);
  assert.match(constrainedReport.hypothesis, /no indica si.*temporal o permanente/i);
  assert.match(constrainedReport.remediation, /410 \(Gone\).*solo si.*permanente/i);
  assert.deepEqual(constrainedReport.evidenceProvenance.correctedFields,
    ["hypothesis", "limitations", "remediation"]);
  assert.deepEqual(constrainedReport.evidenceProvenance.modelOriginalFields, {
    hypothesis: originalHypothesis, limitations: originalLimitations, remediation: originalRemediation,
  });
  assert.deepEqual(constrainedReport.evidenceProvenance.evidenceDerivedFields, {
    hypothesis: "La sección no indica si la falta de representación es temporal o permanente.",
    limitations: "La sección no determina si la falta de representación es temporal o permanente.",
    remediation: "La sección prefiere 410 (Gone) sobre 404 solo si el origen sabe que la condición probablemente será permanente.",
  });
  assert.equal(constrainedReport.evidenceProvenance.fieldProvenance.hypothesis,
    "deterministic_rfc9110_bound_evidence");
  assert.equal(constrainedReport.evidenceProvenance.fieldProvenance.cause, "model_validated");
  assert.equal(normalizedValidation.evidenceProvenance.modelOriginalFields, undefined,
    "raw model fields must not be copied into validation telemetry");
  assert.equal(constrainedReport.evidenceProvenance.sectionContentSha256,
    normalizedValidation.evidenceProvenance.sectionContentSha256);
  assert.equal(validateRfc9110DocumentaryResponse(constrained, constrainedEvidence).valid, false,
    "model-originated output cannot self-assert trusted normalization provenance");
  assert.equal(validateRfc9110DocumentaryResponse(constrained, constrainedEvidence,
    { allowTrustedNormalization: true }).valid, true,
    "the internally normalized and source-bound stored result must validate");

  await assert.rejects(runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url) => extraction(url),
    inferFree: async () => JSON.stringify({ ...validReport(), evidenceProvenance: {
      method: "deterministic_rfc9110_bound_evidence", sourceUrl: URL, sectionId: "15.5.5",
    } }),
  }), /atlas_documentary_response_schema_invalid/);

  await assert.rejects(runAtlasFreeDocumentFallback({ request, activeAgentId: "atlas", routing,
    extractDocument: async (url) => extraction(url),
    inferFree: async () => validReport({ cause: "404 means the server found a current representation and is willing to disclose it." }),
  }), /atlas_documentary_answer_not_supported/);
});

test("generic public Atlas research remains on the existing bounded 8000-character path", async () => {
  const generic = { ...request, prompt: `Research this public document: ${URL}`, title: "Research document" };
  let optionsSeen;
  const answer = await runAtlasFreeDocumentFallback({ request: generic, activeAgentId: "atlas", routing,
    extractDocument: async (url, options) => { optionsSeen = options; return { url, content: "generic evidence" }; },
    inferFree: async () => "generic result",
  });
  assert.equal(optionsSeen.charLimit, 8000);
  assert.equal(optionsSeen.sectionId, null);
  assert.equal(answer, "generic result");
});

test("extraction errors, oversized text, and changed source origin fail closed", () => {
  const selected = select();
  assert.throws(() => buildAtlasFreeEvidencePrompt(request, selected,
    { url: selected.url, content: "page", error: "blocked" }), /atlas_document_extraction_invalid/);
  assert.throws(() => buildAtlasFreeEvidencePrompt(request, selected,
    { url: selected.url, content: "x".repeat(8001) }), /atlas_document_extraction_invalid/);
  assert.throws(() => buildAtlasFreeEvidencePrompt(request, selected,
    { url: "https://attacker.example/fake", content: "404" }), /atlas_document_source_mismatch/);
});
