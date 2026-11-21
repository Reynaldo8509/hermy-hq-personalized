import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  RFC9110_URL, RFC9110_SECTION_ANCHOR, RFC9110_HTML_EXTRACTOR_MODULE,
  extractRfc9110Section, requestedRfc9110Section,
  validateRfc9110DocumentaryResponse, verifyFullTextMetadata,
} from "./atlas-documentary-evidence.mjs";

const quote = "The 404 (Not Found) status code indicates that the origin server did not find a current representation for the target resource or is not willing to disclose that one exists.";
const permanenceQuote = "A 404 status code does not indicate whether this lack of representation is temporary or permanent";
const captured = JSON.parse(readFileSync(new URL("./test-fixtures-atlas-rfc9110-1555.json", import.meta.url), "utf8"));
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
function fixture() {
  return `${"Preamble line with unrelated prose.\n".repeat(2600)}\n#### [15.5.5.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5) [404 Not Found](https://www.rfc-editor.org/rfc/rfc9110.html#name-404-not-found)\n\n${quote}\n\nA 404 status code does not indicate whether this lack of representation is temporary or permanent; the 410 (Gone) status code is preferred over 404 if the origin server knows the condition is likely to be permanent.\n\n#### [15.5.6.](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6) [405 Method Not Allowed](https://www.rfc-editor.org/rfc/rfc9110.html#name-405-method-not-allowed)\n\n${"Appendix unrelated text.\n".repeat(2600)}`;
}
function response(overrides = {}) {
  return JSON.stringify({
    cause: "HTTP 404 Not Found indica que el servidor de origen no encontró una representación actual del recurso de destino y no está dispuesto a revelar que existe.",
    hypothesis: "La falta de representación podría ser temporal o permanente.",
    remediation: "La fuente recomienda 410 Gone si el origen sabe que la condición probablemente es permanente.",
    validation: `Fuente: ${RFC9110_URL}; Sección: §15.5.5; Cita textual: "${quote}"`,
    limitations: "La sección no determina si la falta de representación es temporal o permanente.",
    nextAction: "Consultar la sección 15.5.5 en la fuente oficial.",
    ...overrides,
  });
}
function boundSection(fullText = fixture(), { scope = "full_document", url = RFC9110_URL,
  sourceURL = url, requestedUrl = url, id = "15.5.5", sectionId = id,
  anchor = RFC9110_SECTION_ANCHOR, sectionAnchor = anchor, content,
  extractionId = scope === "parallel_web_fetch_objective" ? "6ba7b810-9dad-41d1-80b4-00c04fd430c8" : null,
} = {}) {
  const extracted = extractRfc9110Section(fullText, {
    scope: scope === "parallel_web_fetch_objective" ? "objective_excerpt" : "full_document",
  });
  const selectedContent = content ?? extracted.content;
  return {
    url, sourceURL, requestedUrl, id, title: extracted.title, anchor,
    sectionId, sectionAnchor, content: selectedContent,
    extractionScope: scope, extractionId,
    sourceContentSha256: sha256(fullText), sourceContentChars: fullText.length,
    sectionContentSha256: sha256(selectedContent),
  };
}
function fullTextMetadata(fullContent) {
  const lines = fullContent.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*#{1,6}\s*\[?15\.5\.5\./.test(line));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start
    && /^\s*#{1,6}\s*\[?15\.5\.6\./.test(line));
  const targetSectionContent = start >= 0 && end > start ? lines.slice(start, end).join("\n") : "";
  return {
    fullContent, fullTextChars: fullContent.length, fullTextSha256: sha256(fullContent),
    extractorModule: RFC9110_HTML_EXTRACTOR_MODULE, httpStatus: 200, contentType: "text/html",
    sourceResponseBytes: Buffer.byteLength(fullContent, "utf8"),
    sourceResponseSha256: sha256(fullContent),
    extractionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    targetSectionId: "15.5.5", targetSectionContent,
    targetSectionChars: targetSectionContent.length,
    targetSectionSha256: sha256(targetSectionContent),
  };
}

test("extracts the target section from the captured real normalized web_extract response", () => {
  assert.equal(captured.fixture_kind, "actual_read_only_provider_response");
  assert.equal(captured.returned_url, RFC9110_URL);
  const section = extractRfc9110Section(captured.content, { scope: "objective_excerpt" });
  assert.equal(section.id, "15.5.5");
  assert.equal(section.title, "404 Not Found");
  assert.match(section.content.replace(/\s+/g, " "), /origin server did not find a current representation/);
  assert.match(section.content.replace(/\s+/g, " "), /does not indicate whether this lack of representation is temporary or permanent/);
  assert.match(section.content, /heuristically cacheable/);
  assert.doesNotMatch(section.content, /15\.5\.4|IANA Considerations/);
  assert.equal(validateRfc9110DocumentaryResponse(
    response({ validation: `Fuente: ${RFC9110_URL}#section-15.5.5; Sección: sección 15.5.5; Cita textual: “${permanenceQuote}”` }),
    boundSection(captured.content, { scope: "parallel_web_fetch_objective" }),
  ).valid, true);
});

test("reproduces the prior false rejection with a source-backed permanence quote", () => {
  const evidence = boundSection(captured.content, { scope: "parallel_web_fetch_objective" });
  const normalizedQuote = permanenceQuote.replace(/\s+/g, " ");
  const result = validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: [RFC 9110](${RFC9110_URL}#section-15.5.5); Sección: § 15.5.5; Cita textual: "${normalizedQuote}"`,
  }), evidence);
  assert.equal(result.valid, true);
  assert.equal(result.quote, normalizedQuote);
});

test("rejects absent, fabricated, irrelevant, wrong-section, and unbound evidence", () => {
  const evidence = boundSection(captured.content, { scope: "parallel_web_fetch_objective" });
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}; Sección: §15.5.5; Cita textual: "a fabricated quotation not present in this source at all"`,
  }), evidence).reason, "atlas_documentary_quote_not_in_source");
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}; Sección: §15.5.5; Cita textual: "A 404 response is heuristically cacheable"`,
  }), evidence).reason, "atlas_documentary_quote_not_pertinent");
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: https://www.rfc-editor.org.evil.example/rfc/rfc9110.html#section-15.5.5; Sección: §15.5.5; Cita textual: "${quote}"`,
  }), evidence).reason, "atlas_documentary_citation_missing");
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}#section-15.5.5; Sección: §15.5.6; Cita textual: "${quote}"`,
  }), evidence).reason, "atlas_documentary_citation_missing");
  assert.equal(validateRfc9110DocumentaryResponse(response(), { ...evidence, sectionId: "15.5.6" }).reason,
    "atlas_documentary_evidence_integrity_failed");
  assert.equal(validateRfc9110DocumentaryResponse(response(), { ...evidence, url: "https://attacker.example/rfc9110.html" }).reason,
    "atlas_documentary_evidence_integrity_failed");
});

test("normalizes line wrapping and permits only canonical base or exact section-fragment citations", () => {
  const source = captured.content;
  const evidence = boundSection(source, { scope: "parallel_web_fetch_objective" });
  const wrappedQuote = "A 404 status code does not indicate whether this lack of\nrepresentation is temporary or permanent";
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}#section-15.5.5; Sección: sección 15.5.5; Cita textual: “${wrappedQuote}”`,
  }), evidence).valid, true);
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}#section-15.5.6; Sección: §15.5.5; Cita textual: "${quote}"`,
  }), evidence).reason, "atlas_documentary_citation_missing");
  assert.equal(validateRfc9110DocumentaryResponse(response({
    validation: `Fuente: ${RFC9110_URL}; Sección: §15.5.5 y sección 15.5.6; Cita textual: "${quote}"`,
  }), evidence).reason, "atlas_documentary_citation_missing");
});

test("rejects truncated evidence and answers unsupported by the source", () => {
  const evidence = boundSection(captured.content, { scope: "parallel_web_fetch_objective" });
  const truncated = evidence.content.split("A 404 status code does not indicate")[0];
  assert.equal(validateRfc9110DocumentaryResponse(response(), {
    ...evidence, content: truncated, sectionContentSha256: sha256(truncated),
  }).reason, "atlas_documentary_evidence_integrity_failed");
  const unsupported = validateRfc9110DocumentaryResponse(response({
    cause: "HTTP 404 means the server found the current representation and is willing to disclose it.",
  }), evidence);
  assert.equal(unsupported.reason, "atlas_documentary_answer_not_supported");
  assert.deepEqual(unsupported.diagnostics.causeSignals, {
    status_404: true, current_representation: true, not_found: false, nondisclosure: false,
  });
  assert.equal(validateRfc9110DocumentaryResponse(response({
    limitations: "The resource is permanently gone.",
  }), evidence).reason, "atlas_documentary_permanence_not_supported");
});

test("preserves extraction fail-closed behavior for missing, ambiguous, or truncated sections", () => {
  assert.throws(() => extractRfc9110Section("only unrelated text"), /section_missing/);
  const noBoundary = captured.content.replace(/(#### 15\.5\.5[\s\S]*?)\n\.\.\.\n/, "$1\n");
  assert.throws(() => extractRfc9110Section(noBoundary, { scope: "objective_excerpt" }), /section_ambiguous|boundary_missing/);
  const duplicate = `${captured.content}\n#### 15.5.5. 404 Not Found\n\nDuplicate section\n\n...`;
  assert.throws(() => extractRfc9110Section(duplicate, { scope: "objective_excerpt" }), /section_ambiguous/);
  const truncated = captured.content.slice(0, captured.content.indexOf("does not indicate"));
  assert.throws(() => extractRfc9110Section(truncated, { scope: "objective_excerpt" }), /section_incomplete|boundary_missing|section_ambiguous/);
});

test("rejects wrong requested URL and malformed full-text integrity metadata", () => {
  assert.throws(() => requestedRfc9110Section({ prompt: "RFC 9110 section 15.5.5" }, "https://attacker.example/rfc9110.html"), /source_mismatch/);
  assert.equal(requestedRfc9110Section({ prompt: "RFC 9110 section 15.5.5" }, RFC9110_URL).id, "15.5.5");
  const metadata = fullTextMetadata(fixture());
  assert.doesNotThrow(() => verifyFullTextMetadata(metadata));
  assert.throws(() => verifyFullTextMetadata({ ...metadata, fullTextSha256: "0".repeat(64) }), /fulltext_integrity_failed/);
  assert.throws(() => verifyFullTextMetadata({ ...metadata, sourceResponseSha256: "invalid" }), /source_integrity_failed/);
});
