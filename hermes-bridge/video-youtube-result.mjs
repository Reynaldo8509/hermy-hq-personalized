import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  normalizeVideoTask,
  parseYoutubeUrl,
} from "./video-youtube-contract.mjs";

const SOURCE_STATUSES = new Set(["extracted", "partial"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResult(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { value: null, reason: "video_result_empty" };
  }
  try {
    const parsed = JSON.parse(value);
    return { value: parsed, reason: null };
  } catch {
    return { value: null, reason: "video_result_json_invalid" };
  }
}

const ANALYSIS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXTRACTION_STATUS = "EXTRACTION_STATUS";
const AUDIOVISUAL_STATUS = "AUDIOVISUAL_STATUS";
const DOCUMENT_VALIDATION_STATUS = "DOCUMENT_VALIDATION_STATUS";
const DELIVERY_STATUS = "DELIVERY_STATUS";
const EXTRACTION_STATUSES = new Set(["not_requested", "available", "partial", "failed"]);
const AUDIOVISUAL_STATUSES = new Set(["not_requested", "available", "partial", "failed"]);
const DOCUMENT_STATUSES = new Set(["not_requested", "valid", "partial", "invalid"]);
const DELIVERY_STATUSES = new Set(["not_requested", "ready", "delivered", "failed"]);
const DOCUMENT_FORMATS = new Set(["markdown", "docx", "pdf"]);
const DOCUMENT_FORMAT_STATUSES = new Set(["not_requested", "generated", "failed"]);
const PROVIDER_DIAGNOSTIC_FIELDS = new Set([
  "http_status", "provider_code", "provider_status", "error_category",
  "error_message", "request_id", "elapsed_seconds",
]);

function validateProviderDiagnostics(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) return "video2implementation_provider_diagnostics_object_required";
  if (Object.keys(value).some((key) => !PROVIDER_DIAGNOSTIC_FIELDS.has(key))) {
    return "video2implementation_provider_diagnostics_field_not_allowed";
  }
  if (value.http_status !== undefined && (!Number.isInteger(value.http_status) || value.http_status < 100 || value.http_status > 599)) {
    return "video2implementation_provider_http_status_invalid";
  }
  if (value.provider_code !== undefined && !(
    (typeof value.provider_code === "number" && Number.isInteger(value.provider_code))
    || (typeof value.provider_code === "string" && value.provider_code.length > 0 && value.provider_code.length <= 200)
  )) return "video2implementation_provider_code_invalid";
  for (const field of ["provider_status", "error_category"]) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 200)) {
      return `video2implementation_${field}_invalid`;
    }
  }
  if (value.error_message !== undefined && (typeof value.error_message !== "string" || value.error_message.length > 1000)) {
    return "video2implementation_provider_error_message_invalid";
  }
  if (value.request_id !== undefined && (typeof value.request_id !== "string" || !value.request_id.trim() || value.request_id.length > 200)) {
    return "video2implementation_provider_request_id_invalid";
  }
  if (value.elapsed_seconds !== undefined && (typeof value.elapsed_seconds !== "number" || !Number.isFinite(value.elapsed_seconds) || value.elapsed_seconds < 0 || value.elapsed_seconds > 3600)) {
    return "video2implementation_provider_elapsed_seconds_invalid";
  }
  return null;
}

function validateExtractionErrors(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 20) return "video2implementation_extraction_errors_invalid";
  if (value.some((item) => typeof item !== "string" || item.length > 1500)) {
    return "video2implementation_extraction_error_item_invalid";
  }
  return null;
}

function validateDocumentFormats(value, analysisId) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) return "video2implementation_document_formats_object_required";
  for (const [extension, entry] of Object.entries(value)) {
    if (!DOCUMENT_FORMATS.has(extension)) return "video2implementation_document_format_not_allowed";
    if (!isObject(entry) || !DOCUMENT_FORMAT_STATUSES.has(entry.status)) {
      return "video2implementation_document_format_entry_invalid";
    }
    if (entry.status === "generated") {
      const reference = entry.reference;
      const suffix = extension === "markdown" ? "md" : extension;
      const expected = `artifacts/${analysisId}.${suffix}`;
      if (!isObject(reference) || reference.relative_path !== expected) {
        return "video2implementation_document_format_reference_invalid";
      }
      if (!SHA256_RE.test(reference.sha256 || "") || !Number.isInteger(reference.size_bytes) || reference.size_bytes < 1) {
        return "video2implementation_document_format_integrity_invalid";
      }
      if (reference.analysis_id !== analysisId) {
        return "video2implementation_document_format_analysis_id_invalid";
      }
    } else if (entry.reference !== undefined && entry.reference !== null) {
      return "video2implementation_document_format_reference_unexpected";
    }
    if (entry.error !== undefined && (typeof entry.error !== "string" || entry.error.length > 240)) {
      return "video2implementation_document_format_error_invalid";
    }
  }
  return null;
}

export function validateVideo2ImplementationResult(value, request) {
  const parsed = parseResult(value);
  if (!parsed.value || !isObject(parsed.value)) {
    return { valid: false, reason: parsed.reason || "video2implementation_result_object_required" };
  }
  const result = parsed.value;
  let task;
  try { task = normalizeVideoTask(request); }
  catch (error) { return { valid: false, reason: "video_request_invalid:" + error.message }; }
  if (request?.kind !== VIDEO_YOUTUBE_ANALYZE_KIND) {
    return { valid: false, reason: "video2implementation_result_kind_invalid" };
  }
  if (task.analysis_type !== "video2implementation") {
    return { valid: false, reason: "video2implementation_analysis_type_required" };
  }
  if (result.task_id !== task.task_id) return { valid: false, reason: "video2implementation_task_id_mismatch" };
  if (result.video_id !== task.video_id) return { valid: false, reason: "video2implementation_video_id_mismatch" };
  let canonical;
  try { canonical = parseYoutubeUrl(result.canonical_url); }
  catch (error) { return { valid: false, reason: "video2implementation_canonical_url_invalid:" + error.message }; }
  if (canonical.video_id !== task.video_id || result.canonical_url !== task.video_url) {
    return { valid: false, reason: "video2implementation_canonical_url_mismatch" };
  }
  if (!ANALYSIS_ID_RE.test(result.analysis_id || "")) return { valid: false, reason: "video2implementation_analysis_id_invalid" };
  if (typeof result.prompt_version !== "string" || !result.prompt_version.trim()) return { valid: false, reason: "video2implementation_prompt_version_invalid" };
  const statuses = [
    [EXTRACTION_STATUS, EXTRACTION_STATUSES],
    [AUDIOVISUAL_STATUS, AUDIOVISUAL_STATUSES],
    [DOCUMENT_VALIDATION_STATUS, DOCUMENT_STATUSES],
    [DELIVERY_STATUS, DELIVERY_STATUSES],
  ];
  for (const [field, allowed] of statuses) {
    if (!allowed.has(result[field])) return { valid: false, reason: `video2implementation_${field.toLowerCase()}_invalid` };
  }
  if (typeof result.summary !== "string" || result.summary.length > 1000) return { valid: false, reason: "video2implementation_summary_invalid" };
  if (!Array.isArray(result.errors) || !Array.isArray(result.limitations)) return { valid: false, reason: "video2implementation_diagnostics_invalid" };
  const providerDiagnosticsError = validateProviderDiagnostics(result.provider_diagnostics);
  if (providerDiagnosticsError) return { valid: false, reason: providerDiagnosticsError };
  const extractionErrorsError = validateExtractionErrors(result.extraction_errors);
  if (extractionErrorsError) return { valid: false, reason: extractionErrorsError };
  const documentFormatsError = validateDocumentFormats(result.document_formats, result.analysis_id);
  if (documentFormatsError) return { valid: false, reason: documentFormatsError };
  if (typeof result.artifact_ref !== "string" && result.artifact_ref !== null) return { valid: false, reason: "video2implementation_artifact_ref_invalid" };
  if (typeof result.artifact_sha256 !== "string" && result.artifact_sha256 !== null) return { valid: false, reason: "video2implementation_artifact_hash_invalid" };
  if (result[DOCUMENT_VALIDATION_STATUS] === "not_requested") {
    if (result.artifact_ref !== null || result.artifact_sha256 !== null) return { valid: false, reason: "video2implementation_unrequested_artifact_present" };
  } else {
    if (result.artifact_ref !== `artifacts/${result.analysis_id}.md`) return { valid: false, reason: "video2implementation_artifact_ref_unsafe" };
    if (!SHA256_RE.test(result.artifact_sha256 || "")) return { valid: false, reason: "video2implementation_artifact_hash_invalid" };
  }
  if (result.document_reference !== null && !isObject(result.document_reference)) {
    return { valid: false, reason: "video2implementation_document_reference_invalid" };
  }
  for (const forbidden of ["document_markdown", "transcript", "full_transcript"]) {
    if (forbidden in result) return { valid: false, reason: "video2implementation_raw_content_forbidden" };
  }
  if (result[AUDIOVISUAL_STATUS] === "failed") {
    return { valid: false, reason: result.errors[0] || "video2implementation_audiovisual_failed" };
  }
  return { valid: true, value: result, document_status: result[DOCUMENT_VALIDATION_STATUS] };
}

export function validateVideoYoutubeResult(value, request) {
  const parsed = parseResult(value);
  if (!parsed.value || !isObject(parsed.value)) {
    return { valid: false, reason: parsed.reason || "video_result_object_required" };
  }
  const result = parsed.value;
  let task;
  try {
    task = normalizeVideoTask(request);
  } catch (error) {
    return { valid: false, reason: "video_request_invalid:" + error.message };
  }
  if (request?.kind !== VIDEO_YOUTUBE_ANALYZE_KIND) {
    return { valid: false, reason: "video_result_kind_invalid" };
  }
  if (result.task_id !== task.task_id) {
    return { valid: false, reason: "video_result_task_id_mismatch" };
  }
  if (result.video_id !== task.video_id) {
    return { valid: false, reason: "video_result_video_id_mismatch" };
  }
  let canonical;
  try { canonical = parseYoutubeUrl(result.canonical_url); }
  catch (error) { return { valid: false, reason: "video_result_canonical_url_invalid:" + error.message }; }
  if (canonical.video_id !== task.video_id || result.canonical_url !== task.video_url) {
    return { valid: false, reason: "video_result_canonical_url_mismatch" };
  }
  if (!isObject(result.metadata) || !isObject(result.transcript)) {
    return { valid: false, reason: "video_result_metadata_transcript_required" };
  }
  if (!SOURCE_STATUSES.has(result.source_status)) {
    return { valid: false, reason: "video_result_source_status_invalid" };
  }
  if (!Array.isArray(result.extraction_errors)) {
    return { valid: false, reason: "video_result_extraction_errors_invalid" };
  }
  if (!["available", "unavailable"].includes(result.transcript.status)) {
    return { valid: false, reason: "video_result_transcript_status_invalid" };
  }
  if (!Array.isArray(result.transcript.segments)) {
    return { valid: false, reason: "video_result_transcript_segments_invalid" };
  }
  if (result.metadata.description !== null && typeof result.metadata.description !== "string") {
    return { valid: false, reason: "video_result_description_invalid" };
  }
  if (result.source_status === "partial" && result.metadata.description !== null) {
    return { valid: false, reason: "video_result_partial_reason_missing" };
  }
  return { valid: true, value: result, source_status: result.source_status };
}
