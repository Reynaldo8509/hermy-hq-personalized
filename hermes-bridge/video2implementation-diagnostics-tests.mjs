import assert from "node:assert/strict";
import { validateVideo2ImplementationResult } from "./video-youtube-result.mjs";
import { propagationDetailForParent } from "./video-youtube-parent-state.mjs";

const id = "Gjnup-PuquQ";
const request = {
  id: "phase3f2-child",
  origin: "max",
  kind: "video.youtube.analyze",
  prompt: [
    "kind=video.youtube.analyze",
    `video_url=https://www.youtube.com/watch?v=${id}`,
    "analysis_type=video2implementation",
    "requested_formats=markdown",
    "delivery_targets=vps",
    "destination_alias=vps_documents",
    "requester=rey",
  ].join("\n"),
};

const envelope = {
  task_id: request.id,
  video_id: id,
  canonical_url: `https://www.youtube.com/watch?v=${id}`,
  analysis_id: "v2i-phase3f2-child",
  prompt_version: "v3",
  EXTRACTION_STATUS: "partial",
  AUDIOVISUAL_STATUS: "partial",
  DOCUMENT_VALIDATION_STATUS: "not_requested",
  DELIVERY_STATUS: "not_requested",
  document_reference: null,
  artifact_ref: null,
  artifact_sha256: null,
  summary: "provider failure with bounded diagnostics",
  errors: ["gemini_provider_temporary_error"],
  limitations: [],
  extraction_errors: ["transcript:timeout"],
  transcript_status: "unavailable",
  provider_metrics: { model: "gemini-3.8-flash", invocation_count: 1, elapsed_seconds: 76.744 },
  provider_diagnostics: {
    http_status: 503,
    provider_code: 503,
    provider_status: "UNAVAILABLE",
    error_category: "gemini_provider_temporary_error",
    error_message: "temporary provider failure",
    request_id: "synthetic-request-id",
    elapsed_seconds: 76.744,
  },
};

const valid = validateVideo2ImplementationResult(JSON.stringify(envelope), request);
assert.equal(valid.valid, true);
const failedEnvelope = { ...envelope, AUDIOVISUAL_STATUS: "failed" };
const failedValidation = validateVideo2ImplementationResult(JSON.stringify(failedEnvelope), request);
assert.equal(failedValidation.valid, false);
assert.equal(failedValidation.reason, "gemini_provider_temporary_error");
assert.equal(validateVideo2ImplementationResult(JSON.stringify({
  ...envelope,
  provider_diagnostics: { ...envelope.provider_diagnostics, body: "raw response" },
}), request).valid, false);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({
  ...envelope,
  provider_diagnostics: { ...envelope.provider_diagnostics, error_message: "x".repeat(1001) },
}), request).valid, false);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({
  ...envelope,
  extraction_errors: ["x".repeat(1000)],
}), request).valid, true);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({
  ...envelope,
  extraction_errors: ["x".repeat(1501)],
}), request).valid, false);

const childFailureDetail = JSON.stringify(envelope);
assert.equal(
  propagationDetailForParent("video.youtube.analyze", "failed", childFailureDetail, "generic failure"),
  childFailureDetail,
);
assert.equal(
  propagationDetailForParent("video.youtube.analyze", "done", childFailureDetail, "done result"),
  "done result",
);
assert.equal(
  propagationDetailForParent("pulse.social", "failed", childFailureDetail, "social failure"),
  "social failure",
);

console.log("video2implementation-diagnostics: PASS");
