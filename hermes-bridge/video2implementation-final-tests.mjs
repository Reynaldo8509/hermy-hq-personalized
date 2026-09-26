import assert from "node:assert/strict";
import { validateVideo2ImplementationResult } from "./video-youtube-result.mjs";
import { classifyVideoYoutubeIntent, normalizeVideoTask } from "./video-youtube-contract.mjs";

const id = "Gjnup-PuquQ";
const request = {
  id: "final-node-child",
  origin: "max",
  kind: "video.youtube.analyze",
  prompt: [
    "kind=video.youtube.analyze",
    `video_url=https://www.youtube.com/watch?v=${id}`,
    "analysis_type=video2implementation",
    "requested_formats=markdown,docx,pdf",
    "delivery_targets=telegram",
    "destination_alias=telegram_owner",
    "requester=rey",
  ].join("\n"),
};
const task = normalizeVideoTask(request);
assert.equal(task.analysis_type, "video2implementation");
assert.deepEqual(task.requested_formats, ["markdown", "docx", "pdf"]);

const analysis = "v2i-final-node";
const ref = (suffix, hash, size) => ({
  analysis_id: analysis,
  relative_path: `artifacts/${analysis}.${suffix}`,
  sha256: hash.repeat(64),
  size_bytes: size,
});
const result = {
  task_id: request.id,
  video_id: id,
  canonical_url: `https://www.youtube.com/watch?v=${id}`,
  analysis_id: analysis,
  prompt_version: "v3",
  EXTRACTION_STATUS: "partial",
  AUDIOVISUAL_STATUS: "partial",
  DOCUMENT_VALIDATION_STATUS: "partial",
  DELIVERY_STATUS: "delivered",
  document_reference: ref("md", "a", 100),
  artifact_ref: `artifacts/${analysis}.md`,
  artifact_sha256: "a".repeat(64),
  document_formats: {
    markdown: { status: "generated", reference: ref("md", "a", 100) },
    docx: { status: "generated", reference: ref("docx", "b", 200) },
    pdf: { status: "generated", reference: ref("pdf", "c", 300) },
  },
  summary: "compact result",
  errors: [],
  limitations: ["evidence_partial"],
  extraction_errors: ["transcript_unavailable"],
};
assert.equal(validateVideo2ImplementationResult(JSON.stringify(result), request).valid, true);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({
  ...result,
  document_formats: { ...result.document_formats, pdf: { status: "generated", reference: ref("pdf", "../../", 1) } },
}), request).valid, false);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({ ...result, document_markdown: "raw" }), request).valid, false);
assert.equal(classifyVideoYoutubeIntent({ kind: "pulse.social", prompt: "social strategy" }), null);
console.log("video2implementation-final: PASS");
