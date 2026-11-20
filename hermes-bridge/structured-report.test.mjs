import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ATLAS_STRUCTURED_REPORT_JSON_SCHEMA,
  buildAtlasStructuredReportPrompt,
  validateStructuredReportJson,
} from "./structured-report.mjs";

const FIXTURE = new URL("./fixtures/atlas-mimo-response-20261004.txt", import.meta.url);
const fixtureText = readFileSync(fileURLToPath(FIXTURE), "utf8");
const validReport = JSON.stringify({
  cause: "La respuesta de prueba no incluyó el contrato de seis campos.",
  hypothesis: "La instrucción de formato no llegó al modelo.",
  remediation: "Se añadió un contrato JSON explícito al prompt.",
  validation: "El objeto contiene seis valores no vacíos.",
  limitations: "La respuesta es sintética y no prueba hechos externos.",
  nextAction: "Ejecutar la E2E autorizada una vez.",
});

test("R47 sanitized MiMo response reproduces the six-field validation failure offline", () => {
  const result = validateStructuredReportJson(fixtureText);
  assert.equal(result.parsed, false);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.required);
  assert.match(fixtureText, /^\s*#/);
  assert.equal(fixtureText.includes(String.fromCharCode(96).repeat(3)), false);
});

test("Atlas prompt specifies exactly the six JSON properties and forbids surrounding prose", () => {
  const prompt = buildAtlasStructuredReportPrompt("Analiza este caso sintético.");
  assert.equal(prompt.startsWith("Analiza este caso sintético."), true);
  assert.match(prompt, /un único objeto JSON, sin Markdown/);
  for (const key of ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.required) assert.match(prompt, new RegExp('"' + key + '"'));
  assert.equal(ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(Object.keys(ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.properties), ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.required);
  assert.equal(validateStructuredReportJson(validReport).valid, true);
});

test("strict Atlas JSON rejects missing, null, empty, placeholder and additional values", () => {
  const base = JSON.parse(validReport);
  const missing = { ...base };
  delete missing.nextAction;
  assert.equal(validateStructuredReportJson(JSON.stringify(missing)).valid, false);
  assert.equal(validateStructuredReportJson(JSON.stringify({ ...base, cause: null })).valid, false);
  assert.equal(validateStructuredReportJson(JSON.stringify({ ...base, cause: "  " })).valid, false);
  assert.equal(validateStructuredReportJson(JSON.stringify({ ...base, cause: "unknown" })).valid, false);
  assert.equal(validateStructuredReportJson(JSON.stringify({ ...base, extra: "no permitido" })).valid, false);
  assert.equal(validateStructuredReportJson("\n" + validReport + "\n").valid, true);
});

test("strict Atlas JSON rejects markdown wrappers rather than repairing or inventing content", () => {
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal(validateStructuredReportJson(fence + "json\n" + validReport + "\n" + fence).valid, false);
  assert.equal(validateStructuredReportJson("Respuesta:\n" + validReport).valid, false);
});

function trustedNormalizedReport() {
  const report = JSON.parse(validReport);
  const quote = "A 404 status code does not indicate whether this lack of representation is temporary or permanent.";
  const corrected = {
    hypothesis: "La sección no indica si la falta de representación es temporal o permanente.",
    limitations: "La sección no determina si la falta de representación es temporal o permanente.",
    validation: `Fuente: https://www.rfc-editor.org/rfc/rfc9110.html; Sección: §15.5.5; Cita textual: \"${quote}\"`,
  };
  Object.assign(report, corrected);
  report.evidenceProvenance = {
    method: "deterministic_rfc9110_bound_evidence",
    sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.html",
    sectionId: "15.5.5",
    sectionContentSha256: "a".repeat(64),
    correctedFields: ["hypothesis", "limitations", "validation"],
    normalizationRules: ["rfc9110_exact_source_quote", "rfc9110_permanence_scope"],
    modelOriginalFields: {
      hypothesis: "La fuente confirma que 404 significa permanente.",
      limitations: "No hay limitaciones.",
      validation: "Fuente: RFC 9110 §15.5.5.",
    },
    evidenceDerivedFields: corrected,
    fieldProvenance: {
      cause: "model_validated",
      hypothesis: "deterministic_rfc9110_bound_evidence",
      remediation: "model_validated",
      validation: "deterministic_rfc9110_bound_evidence",
      limitations: "deterministic_rfc9110_bound_evidence",
      nextAction: "model_validated",
    },
  };
  return report;
}

test("the generic report stays strict while the verified Atlas RFC provenance extension is accepted only by opt-in", () => {
  const normalized = JSON.stringify(trustedNormalizedReport());
  assert.equal(validateStructuredReportJson(normalized).valid, false);
  assert.equal(validateStructuredReportJson(normalized, { allowRfc9110EvidenceProvenance: true }).valid, true);
});

test("the Atlas provenance extension rejects mismatched derived claims and forged source binding", () => {
  const mismatchedClaim = trustedNormalizedReport();
  mismatchedClaim.hypothesis = "La fuente dice que todo 404 es permanente.";
  assert.equal(validateStructuredReportJson(JSON.stringify(mismatchedClaim), {
    allowRfc9110EvidenceProvenance: true,
  }).valid, false);

  const forgedSource = trustedNormalizedReport();
  forgedSource.evidenceProvenance.sourceUrl = "https://attacker.example/rfc9110.html";
  assert.equal(validateStructuredReportJson(JSON.stringify(forgedSource), {
    allowRfc9110EvidenceProvenance: true,
  }).valid, false);

  const extra = trustedNormalizedReport();
  extra.evidenceProvenance.modelOriginalFields.extra = "not allowed";
  assert.equal(validateStructuredReportJson(JSON.stringify(extra), {
    allowRfc9110EvidenceProvenance: true,
  }).valid, false);
});
