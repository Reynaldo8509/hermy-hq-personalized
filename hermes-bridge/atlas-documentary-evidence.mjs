import { createHash } from "node:crypto";

export const RFC9110_URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
export const RFC9110_SECTION_ID = "15.5.5";
export const RFC9110_SECTION_ANCHOR = `${RFC9110_URL}#section-${RFC9110_SECTION_ID}`;
export const RFC9110_SECTION_MAX_CHARS = 8_000;
export const RFC9110_HTML_EXTRACTOR_MODULE = "hermes-bridge/atlas_document_fetch.py:stdlib-https-html";
const RFC9110_TITLE = "404 Not Found";
const REPORT_KEYS = ["cause", "hypothesis", "remediation", "validation", "limitations", "nextAction"];
const EVIDENCE_PROVENANCE_KEY = "evidenceProvenance";
const EVIDENCE_PROVENANCE_KEYS = ["method", "sourceUrl", "sectionId", "sectionContentSha256",
  "correctedFields", "normalizationRules", "modelOriginalFields", "evidenceDerivedFields", "fieldProvenance"];
const DETERMINISTIC_RFC9110_FIELDS = Object.freeze({
  hypothesis: "La sección no indica si la falta de representación es temporal o permanente.",
  limitations: "La sección no determina si la falta de representación es temporal o permanente.",
  remediation: "La sección prefiere 410 (Gone) sobre 404 solo si el origen sabe que la condición probablemente será permanente.",
});
const NORMALIZATION_RULE_FIELDS = Object.freeze({
  rfc9110_exact_source_quote: ["validation"],
  rfc9110_permanence_scope: ["hypothesis", "limitations"],
  rfc9110_conditional_410_guidance: ["remediation"],
});

export function canonicalRfcUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "www.rfc-editor.org"
        || url.pathname !== "/rfc/rfc9110.html" || url.port || url.username || url.password
        || url.search || (url.hash && url.hash !== "#section-15.5.5")) return null;
    return RFC9110_URL;
  } catch { return null; }
}

export function requestedRfc9110Section(request, sourceUrl) {
  const text = `${String(request?.title || "")}\n${String(request?.prompt || "")}`;
  // Do not let the `rfc9110` URL path itself count as a textual RFC citation.
  // MAX's delegated task can express a valid compact reference as "15.5.5 ... RFC 9110"
  // without the words "section" or the § symbol; bind that form to a nearby RFC number.
  const citationText = text.replace(/https?:\/\/[^\s<>"'`]+/gi, " ");
  const namesRfc = /\bRFC\s+9110\b/i.test(citationText);
  const explicitSection = /(?:§\s*|\bsection\s+)15\.5\.5\b/i.test(citationText);
  const compactSectionCitation = /(?:\bRFC\s+9110\b[^\n]{0,120}\b15\.5\.5\b|\b15\.5\.5\b[^\n]{0,120}\bRFC\s+9110\b)/i
    .test(citationText);
  const asksSection = namesRfc && (explicitSection || compactSectionCitation);
  if (!asksSection) return null;
  if (canonicalRfcUrl(sourceUrl) !== RFC9110_URL) {
    throw Object.assign(new Error("atlas_documentary_source_mismatch"), { code: "atlas_documentary_source_mismatch" });
  }
  return { id: RFC9110_SECTION_ID, title: RFC9110_TITLE, anchor: RFC9110_SECTION_ANCHOR };
}

function headingDescriptor(line) {
  const links = [...String(line).matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((match) => ({ label: match[1].replace(/\\#/g, "#").trim(), href: match[2].replace(/\\#/g, "#").trim() }));
  const normalized = String(line)
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(\d+(?:\.\d+)+)\.?\s+(.+?)\s*$/);
  return match ? { number: match[1], title: match[2].trim(), links } : null;
}

function targetHeadingLinksAreValid(heading) {
  if (!heading.links.length) return true;
  const expected = [
    { label: /^15\.5\.5\.?$/, hash: "#section-15.5.5" },
    { label: /^404 Not Found$/i, hash: "#name-404-not-found" },
  ];
  if (heading.links.length !== expected.length) return false;
  return expected.every(({ label, hash }) => {
    const link = heading.links.find((candidate) => label.test(candidate.label));
    if (!link) return false;
    try {
      const url = new URL(link.href, RFC9110_URL);
      return url.protocol === "https:" && url.hostname === "www.rfc-editor.org"
        && url.pathname === "/rfc/rfc9110.html" && url.hash === hash
        && !url.port && !url.username && !url.password && !url.search;
    } catch { return false; }
  });
}

function isTargetHeading(heading) {
  return heading?.number === RFC9110_SECTION_ID
    && /^404 Not Found$/i.test(heading.title)
    && targetHeadingLinksAreValid(heading);
}

function isOmissionBoundary(line) {
  return /^\s*(?:\.\.\.|…|\[\s*(?:(?:middle|section|content)\s+)?(?:omitted|truncated)[^\]]*\])\s*$/i.test(line);
}

function documentaryError(code) {
  throw Object.assign(new Error(code), { code });
}

export function extractRfc9110Section(fullText, {
  maxChars = RFC9110_SECTION_MAX_CHARS, scope = "full_document",
} = {}) {
  if (typeof fullText !== "string" || fullText.length === 0 || fullText.length > 2_000_000) {
    documentaryError("atlas_documentary_fulltext_invalid");
  }
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > RFC9110_SECTION_MAX_CHARS
      || !["full_document", "objective_excerpt", "html_section"].includes(scope)) {
    documentaryError("atlas_documentary_scope_invalid");
  }
  const lines = fullText.split(/\r?\n/);
  const headings = lines.map(headingDescriptor);
  const starts = headings.flatMap((heading, index) => isTargetHeading(heading) ? [index] : []);
  if (starts.length !== 1) {
    documentaryError(starts.length ? "atlas_documentary_section_ambiguous" : "atlas_documentary_section_missing");
  }
  const start = starts[0];
  if (scope === "html_section") {
    if (headings.slice(start + 1).some((heading) => heading !== null)) {
      documentaryError("atlas_documentary_section_ambiguous");
    }
    const content = lines.slice(start + 1).join("\n").trim();
    const flattened = content.replace(/\s+/g, " ").trim();
    if (!content || content.length > maxChars
        || /\b(?:TRUNCATED|content has been truncated)\b/i.test(content)
        || !/[.!?]["'’”)]?$/.test(flattened)) {
      documentaryError("atlas_documentary_section_incomplete");
    }
    return { id: RFC9110_SECTION_ID, title: RFC9110_TITLE, anchor: RFC9110_SECTION_ANCHOR, content };
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = headings[i];
    if (heading) {
      const parts = heading.number.split(".");
      const isNextRfcSubsection = parts.length === 3 && parts[0] === "15"
        && parts[1] === "5" && Number(parts[2]) > 5;
      if (isNextRfcSubsection) { end = i; break; }
      if (scope === "objective_excerpt") {
        documentaryError("atlas_documentary_section_ambiguous");
      }
    }
    if (scope === "objective_excerpt" && isOmissionBoundary(lines[i])) { end = i; break; }
  }
  if (end < 0) documentaryError("atlas_documentary_section_boundary_missing");
  const content = lines.slice(start + 1, end).join("\n")
    .replace(/[ \t]*¶[ \t]*/g, "\n\n").trim();
  const flattened = content.replace(/\s+/g, " ").trim();
  if (!content || content.length > maxChars) {
    documentaryError("atlas_documentary_section_size_invalid");
  }
  if (/\b(?:TRUNCATED|content has been truncated)\b/i.test(content)
      || !/[.!?]["'’”)]?$/.test(flattened)) {
    documentaryError("atlas_documentary_section_incomplete");
  }
  return { id: RFC9110_SECTION_ID, title: RFC9110_TITLE, anchor: RFC9110_SECTION_ANCHOR, content };
}

export function normalizeDocumentQuote(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function foldText(text) {
  return String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function citationUrlIsCanonical(validation) {
  const urls = [...String(validation || "").matchAll(/https:\/\/[^\s<>\"'`]+/gi)]
    .map((match) => match[0].replace(/[),.;!?]+$/g, ""));
  return urls.length === 1 && canonicalRfcUrl(urls[0]) === RFC9110_URL;
}

function sectionEvidenceIsBound(section) {
  if (!section || section.id !== RFC9110_SECTION_ID || section.title !== RFC9110_TITLE
      || section.anchor !== RFC9110_SECTION_ANCHOR || section.sectionId !== RFC9110_SECTION_ID
      || section.sectionAnchor !== RFC9110_SECTION_ANCHOR || typeof section.content !== "string"
      || section.content.length === 0 || section.content.length > RFC9110_SECTION_MAX_CHARS) return false;
  if (canonicalRfcUrl(section.url) !== RFC9110_URL
      || canonicalRfcUrl(section.sourceURL) !== RFC9110_URL
      || canonicalRfcUrl(section.requestedUrl) !== RFC9110_URL) return false;
  if (!Number.isInteger(section.sourceContentChars) || section.sourceContentChars < section.content.length
      || section.sourceContentChars > 2_000_000
      || typeof section.sourceContentSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(section.sourceContentSha256)
      || typeof section.sectionContentSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(section.sectionContentSha256)
      || createHash("sha256").update(section.content, "utf8").digest("hex") !== section.sectionContentSha256) return false;
  if (section.extractionScope === "parallel_web_fetch_objective") {
    if (!/^[0-9a-f-]{36}$/i.test(section.extractionId || "")) return false;
  } else if (section.extractionScope === "full_document" || section.extractionScope === "html_section") {
    if (section.extractorModule !== RFC9110_HTML_EXTRACTOR_MODULE
        || section.httpStatus !== 200 || section.contentType !== "text/html"
        || !Number.isSafeInteger(section.sourceResponseBytes) || section.sourceResponseBytes < 1
        || section.sourceResponseBytes > 2_000_000
        || typeof section.sourceResponseSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(section.sourceResponseSha256)
        || !/^[0-9a-f-]{36}$/i.test(section.extractionId || "")) return false;
    if (section.extractionScope === "html_section") {
      if (typeof section.targetSectionContent !== "string"
          || !Number.isInteger(section.targetSectionChars)
          || section.targetSectionChars !== section.targetSectionContent.length
          || section.targetSectionChars > 100_000
          || typeof section.targetSectionSha256 !== "string"
          || !/^[a-f0-9]{64}$/.test(section.targetSectionSha256)
          || createHash("sha256").update(section.targetSectionContent, "utf8").digest("hex")
            !== section.targetSectionSha256) return false;
      try {
        const extracted = extractRfc9110Section(section.targetSectionContent, { scope: "html_section" });
        if (extracted.content !== section.content || extracted.id !== section.sectionId
            || extracted.anchor !== section.sectionAnchor) return false;
      } catch { return false; }
    }
  } else return false;
  const source = foldText(section.content);
  const definition = /\b404\b/.test(source) && /current representation/.test(source)
    && /did not find/.test(source) && /not willing to disclose/.test(source);
  const permanence = /\b404\b/.test(source) && /does not indicate whether/.test(source)
    && /lack of representation/.test(source) && /temporary/.test(source) && /permanent/.test(source);
  const guidance = /\b410\b/.test(source) && /gone/.test(source)
    && /preferred over 404/.test(source) && /permanent/.test(source);
  return definition && permanence && guidance;
}

function quoteIsPertinent(quote) {
  const normalized = foldText(quote);
  const definition = /\b404\b/.test(normalized)
    && /(not found|status code)/.test(normalized)
    && /(current representation|target resource)/.test(normalized)
    && /(did not find|not willing to disclose)/.test(normalized);
  const permanence = /does not indicate/.test(normalized)
    && /lack of representation/.test(normalized)
    && /temporary/.test(normalized) && /permanent/.test(normalized);
  const goneGuidance = /\b410\b/.test(normalized) && /gone/.test(normalized)
    && /\b404\b/.test(normalized) && /permanent/.test(normalized);
  return definition || permanence || goneGuidance;
}

function hasExactKeys(value, expected) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function trustedEvidenceProvenanceIsBound(report, section) {
  const provenance = report?.[EVIDENCE_PROVENANCE_KEY];
  if (typeof section?.content !== "string" || !hasExactKeys(provenance, EVIDENCE_PROVENANCE_KEYS)
      || provenance.method !== "deterministic_rfc9110_bound_evidence"
      || provenance.sourceUrl !== RFC9110_URL || provenance.sectionId !== RFC9110_SECTION_ID
      || typeof provenance.sectionContentSha256 !== "string"
      || provenance.sectionContentSha256 !== createHash("sha256").update(section.content, "utf8").digest("hex")) {
    return false;
  }
  if (!Array.isArray(provenance.correctedFields) || !provenance.correctedFields.length
      || provenance.correctedFields.some((field) => !REPORT_KEYS.includes(field))
      || new Set(provenance.correctedFields).size !== provenance.correctedFields.length
      || !Array.isArray(provenance.normalizationRules) || !provenance.normalizationRules.length
      || provenance.normalizationRules.some((rule) => !Object.hasOwn(NORMALIZATION_RULE_FIELDS, rule))
      || new Set(provenance.normalizationRules).size !== provenance.normalizationRules.length) {
    return false;
  }
  const derivedFields = [...new Set(provenance.normalizationRules.flatMap((rule) => NORMALIZATION_RULE_FIELDS[rule]))].sort();
  const correctedFields = [...provenance.correctedFields].sort();
  if (derivedFields.join("\u0000") !== correctedFields.join("\u0000")
      || !hasExactKeys(provenance.modelOriginalFields, correctedFields)
      || !hasExactKeys(provenance.evidenceDerivedFields, correctedFields)
      || !hasExactKeys(provenance.fieldProvenance, REPORT_KEYS)) return false;
  for (const field of correctedFields) {
    if (typeof provenance.modelOriginalFields[field] !== "string"
        || provenance.modelOriginalFields[field].length > 4_000
        || typeof provenance.evidenceDerivedFields[field] !== "string"
        || provenance.evidenceDerivedFields[field] !== report[field]
        || provenance.fieldProvenance[field] !== "deterministic_rfc9110_bound_evidence") return false;
    if (Object.hasOwn(DETERMINISTIC_RFC9110_FIELDS, field)
        && provenance.evidenceDerivedFields[field] !== DETERMINISTIC_RFC9110_FIELDS[field]) return false;
  }
  for (const field of REPORT_KEYS) {
    if (!correctedFields.includes(field) && provenance.fieldProvenance[field] !== "model_validated") return false;
  }
  return true;
}

export function validateRfc9110DocumentaryResponse(responseText, section, { allowTrustedNormalization = false } = {}) {
  let report;
  try { report = JSON.parse(String(responseText || "")); }
  catch { return { valid: false, reason: "atlas_documentary_response_not_json" }; }
  const plainSchema = hasExactKeys(report, REPORT_KEYS);
  const normalizedSchema = allowTrustedNormalization
    && hasExactKeys(report, [...REPORT_KEYS, EVIDENCE_PROVENANCE_KEY])
    && trustedEvidenceProvenanceIsBound(report, section);
  if (!report || typeof report !== "object" || Array.isArray(report)
      || (!plainSchema && !normalizedSchema)
      || REPORT_KEYS.some((key) => typeof report[key] !== "string" || !report[key].trim())) {
    return { valid: false, reason: "atlas_documentary_response_schema_invalid" };
  }
  if (!sectionEvidenceIsBound(section)) {
    return { valid: false, reason: "atlas_documentary_evidence_integrity_failed" };
  }
  const validation = report.validation;
  const normalizedCitationText = foldText(validation);
  const sectionReferences = [...normalizedCitationText.matchAll(
    /\b(?:sections?|seccion(?:es)?)\s*§?\s*(\d+(?:\.\d+)+)\b|§\s*(\d+(?:\.\d+)+)\b/gi,
  )].map((match) => match[1] || match[2]);
  const sectionReference = sectionReferences.length > 0
    && sectionReferences.every((reference) => reference === RFC9110_SECTION_ID);
  if (!citationUrlIsCanonical(validation) || !sectionReference) {
    return { valid: false, reason: "atlas_documentary_citation_missing" };
  }
  const quoteMatch = validation.match(/Cita textual\s*:\s*(?:"([^"]{40,500})"|“([^”]{40,500})”|'([^']{40,500})'|‘([^’]{40,500})’)/i);
  if (!quoteMatch) return { valid: false, reason: "atlas_documentary_quote_missing" };
  const quote = normalizeDocumentQuote(quoteMatch.slice(1).find(Boolean));
  const source = normalizeDocumentQuote(section.content);
  if (!foldText(source).includes(foldText(quote))) {
    return { valid: false, reason: "atlas_documentary_quote_not_in_source" };
  }
  if (!quoteIsPertinent(quote)) {
    return { valid: false, reason: "atlas_documentary_quote_not_pertinent" };
  }
  const cause = foldText(report.cause);
  const causeSignals = {
    status_404: /\b404\b/.test(cause),
    current_representation: /(current representation|representacion actual)/.test(cause),
    not_found: /(did not find|no encontro|no encuentra|no hallo)/.test(cause),
    nondisclosure: /(not willing to disclose|no esta dispuesto a revelar|no desea revelar|no quiere revelar)/.test(cause),
  };
  if (!Object.values(causeSignals).every(Boolean)) {
    return { valid: false, reason: "atlas_documentary_answer_not_supported", diagnostics: { causeSignals } };
  }
  const permanence = foldText(`${report.hypothesis} ${report.limitations}`);
  if (!/(temporary|temporar|temporal)/.test(permanence)
      || !/(permanent|permanente)/.test(permanence)
      || !/(does not indicate|does not imply|no indica|no implica|no determina|cannot be determined|no se puede determinar)/.test(permanence)) {
    return { valid: false, reason: "atlas_documentary_permanence_not_supported" };
  }
  const goneGuidance = foldText(report.remediation);
  if (!/410/.test(goneGuidance) || !/(gone|desaparecid)/.test(goneGuidance)
      || !/(permanent|permanente)/.test(goneGuidance)) {
    return { valid: false, reason: "atlas_documentary_410_guidance_not_supported" };
  }
  return { valid: true, reason: null, quote };
}

export function verifyFullTextMetadata(extraction) {
  const objectiveExcerpt = extraction?.extractionScope === "parallel_web_fetch_objective";
  const full = objectiveExcerpt ? extraction?.evidenceContent : extraction?.fullContent;
  const chars = objectiveExcerpt ? extraction?.evidenceContentChars : extraction?.fullTextChars;
  const sha256 = objectiveExcerpt ? extraction?.evidenceContentSha256 : extraction?.fullTextSha256;
  if (typeof full !== "string" || !Number.isInteger(chars) || chars !== full.length
      || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
      || createHash("sha256").update(full, "utf8").digest("hex") !== sha256) {
    throw Object.assign(new Error("atlas_documentary_fulltext_integrity_failed"), { code: "atlas_documentary_fulltext_integrity_failed" });
  }
  if (!objectiveExcerpt && (extraction?.extractorModule !== RFC9110_HTML_EXTRACTOR_MODULE
      || extraction?.httpStatus !== 200 || extraction?.contentType !== "text/html"
      || !Number.isSafeInteger(extraction?.sourceResponseBytes)
      || extraction.sourceResponseBytes < 1 || extraction.sourceResponseBytes > 2_000_000
      || typeof extraction?.sourceResponseSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(extraction.sourceResponseSha256)
      || !/^[0-9a-f-]{36}$/i.test(extraction?.extractionId || "")
      || extraction?.targetSectionId !== RFC9110_SECTION_ID
      || typeof extraction?.targetSectionContent !== "string"
      || !Number.isInteger(extraction?.targetSectionChars)
      || extraction.targetSectionChars !== extraction.targetSectionContent.length
      || extraction.targetSectionContent.length > 100_000
      || typeof extraction?.targetSectionSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(extraction.targetSectionSha256)
      || createHash("sha256").update(extraction.targetSectionContent, "utf8").digest("hex")
        !== extraction.targetSectionSha256
      || !extraction.fullContent.includes(extraction.targetSectionContent))) {
    throw Object.assign(new Error("atlas_documentary_source_integrity_failed"), { code: "atlas_documentary_source_integrity_failed" });
  }
}
