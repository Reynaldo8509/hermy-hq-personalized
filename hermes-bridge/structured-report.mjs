export const ATLAS_STRUCTURED_REPORT_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    cause: Object.freeze({ type: "string", minLength: 1 }),
    hypothesis: Object.freeze({ type: "string", minLength: 1 }),
    remediation: Object.freeze({ type: "string", minLength: 1 }),
    validation: Object.freeze({ type: "string", minLength: 1 }),
    limitations: Object.freeze({ type: "string", minLength: 1 }),
    nextAction: Object.freeze({ type: "string", minLength: 1 }),
  }),
  required: Object.freeze(["cause", "hypothesis", "remediation", "validation", "limitations", "nextAction"]),
  additionalProperties: false,
});

export const ATLAS_STRUCTURED_REPORT_PROMPT = [
  "Formato de salida obligatorio: responde con un único objeto JSON, sin Markdown, cercas ni texto fuera del JSON.",
  "El objeto debe contener exactamente estas seis propiedades de tipo string y ninguna otra:",
  '{"cause":"...","hypothesis":"...","remediation":"...","validation":"...","limitations":"...","nextAction":"..."}',
  "Incluye un valor no vacío y basado únicamente en la solicitud y la evidencia disponible para cada propiedad.",
  "No inventes datos ni completes hechos ausentes. Cuando algo no esté confirmado, indícalo explícitamente y explica el límite de evidencia.",
  "No uses valores de relleno como unknown, pending, n/a, no aplica o sin datos.",
].join("\n");

const REQUIRED = ATLAS_STRUCTURED_REPORT_JSON_SCHEMA.required;
const INVALID_PLACEHOLDER = /^(pendiente|no registrado|n\/a|na|unknown|desconocido|sin datos|no aplica)$/i;
const RFC9110_URL = "https://www.rfc-editor.org/rfc/rfc9110.html";
const EVIDENCE_PROVENANCE_KEY = "evidenceProvenance";
const EVIDENCE_PROVENANCE_KEYS = ["method", "sourceUrl", "sectionId", "sectionContentSha256",
  "correctedFields", "normalizationRules", "modelOriginalFields", "evidenceDerivedFields", "fieldProvenance"];
const NORMALIZATION_RULE_FIELDS = {
  rfc9110_exact_source_quote: ["validation"],
  rfc9110_permanence_scope: ["hypothesis", "limitations"],
  rfc9110_conditional_410_guidance: ["remediation"],
};
const DETERMINISTIC_FIELDS = {
  hypothesis: "La sección no indica si la falta de representación es temporal o permanente.",
  limitations: "La sección no determina si la falta de representación es temporal o permanente.",
  remediation: "La sección prefiere 410 (Gone) sobre 404 solo si el origen sabe que la condición probablemente será permanente.",
};

function exactObjectKeys(value, expected) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()));
}

function uniqueStringList(value, allowed) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string"
    && (!allowed || allowed.includes(entry))) && new Set(value).size === value.length;
}

function validBoundEvidenceProvenance(report) {
  const provenance = report?.[EVIDENCE_PROVENANCE_KEY];
  if (!exactObjectKeys(provenance, EVIDENCE_PROVENANCE_KEYS)
      || provenance.method !== "deterministic_rfc9110_bound_evidence"
      || provenance.sourceUrl !== RFC9110_URL || provenance.sectionId !== "15.5.5"
      || !/^[a-f0-9]{64}$/.test(provenance.sectionContentSha256 || "")
      || !uniqueStringList(provenance.normalizationRules, Object.keys(NORMALIZATION_RULE_FIELDS))
      || !provenance.normalizationRules.length
      || !uniqueStringList(provenance.correctedFields, REQUIRED)
      || !provenance.correctedFields.length) return false;
  const expectedFields = [...new Set(provenance.normalizationRules.flatMap((rule) => NORMALIZATION_RULE_FIELDS[rule]))].sort();
  const correctedFields = [...provenance.correctedFields].sort();
  if (JSON.stringify(correctedFields) !== JSON.stringify(expectedFields)
      || !exactObjectKeys(provenance.modelOriginalFields, correctedFields)
      || !exactObjectKeys(provenance.evidenceDerivedFields, correctedFields)
      || !exactObjectKeys(provenance.fieldProvenance, REQUIRED)) return false;
  for (const field of correctedFields) {
    const original = provenance.modelOriginalFields[field];
    const derived = provenance.evidenceDerivedFields[field];
    if (typeof original !== "string" || !original.trim() || original.length > 4000
        || typeof derived !== "string" || derived !== report[field]) return false;
    if (Object.hasOwn(DETERMINISTIC_FIELDS, field) && derived !== DETERMINISTIC_FIELDS[field]) return false;
    if (field === "validation" && (!derived.includes(RFC9110_URL)
        || !/§15\.5\.5/.test(derived) || !/Cita textual\s*:/.test(derived))) return false;
  }
  return REQUIRED.every((field) => provenance.fieldProvenance[field]
    === (correctedFields.includes(field) ? "deterministic_rfc9110_bound_evidence" : "model_validated"));
}

export function buildAtlasStructuredReportPrompt(prompt) {
  const text = String(prompt || "");
  return text + (text ? "\n\n" : "") + ATLAS_STRUCTURED_REPORT_PROMPT;
}

export function parseStructuredReportJson(text) {
  let value;
  try { value = JSON.parse(String(text ?? "").trim()); }
  catch { return null; }
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return Object.fromEntries(REQUIRED.map((key) => [
    key,
    typeof value[key] === "string" ? value[key].trim().slice(0, 2000) || null : null,
  ]));
}

export function validateStructuredReportJson(text, { allowRfc9110EvidenceProvenance = false } = {}) {
  let value;
  try { value = JSON.parse(String(text ?? "").trim()); }
  catch { return { parsed: false, valid: false, fields: null, missing: [...REQUIRED] }; }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return { parsed: false, valid: false, fields: null, missing: [...REQUIRED] };
  }

  const fields = parseStructuredReportJson(text);
  const invalid = REQUIRED.filter((key) => {
    const field = value[key];
    return typeof field !== "string" || !field.trim() || INVALID_PLACEHOLDER.test(field.trim());
  });
  const permittedProvenance = allowRfc9110EvidenceProvenance
    && exactObjectKeys(value, [...REQUIRED, EVIDENCE_PROVENANCE_KEY])
    && validBoundEvidenceProvenance(value);
  const additional = Object.keys(value).filter((key) => !REQUIRED.includes(key)
    && !(permittedProvenance && key === EVIDENCE_PROVENANCE_KEY));
  const missing = [...invalid, ...(additional.length ? ["additionalProperties"] : [])];
  const exactKeys = (Object.keys(value).length === REQUIRED.length && additional.length === 0)
    || permittedProvenance;
  return { parsed: true, valid: exactKeys && missing.length === 0, fields, missing };
}
