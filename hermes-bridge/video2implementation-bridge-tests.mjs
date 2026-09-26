import assert from "node:assert/strict";
import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  classifyVideoYoutubeIntent,
  normalizeVideoTask,
} from "./video-youtube-contract.mjs";
import { dispatchVideoYoutubeAnalyze } from "./video-youtube-dispatch.mjs";
import {
  validateVideo2ImplementationResult,
  validateVideoYoutubeResult,
} from "./video-youtube-result.mjs";

const id = "Gjnup-PuquQ";
const childRequest = {
  id: "synthetic-v2i-child",
  origin: "max",
  kind: VIDEO_YOUTUBE_ANALYZE_KIND,
  prompt: [
    "Pulse: solicitud explícita validada por MAX.",
    `kind=${VIDEO_YOUTUBE_ANALYZE_KIND}`,
    `video_url=https://www.youtube.com/watch?v=${id}`,
    "analysis_type=video2implementation",
    "requested_formats=markdown",
    "delivery_targets=vps",
    "destination_alias=vps_documents",
    "requester=rey",
  ].join("\n"),
};

const task = normalizeVideoTask(childRequest);
assert.equal(task.analysis_type, "video2implementation");
assert.deepEqual(task.requested_formats, ["markdown"]);
assert.equal(task.video_id, id);
assert.equal(task.video_url, `https://www.youtube.com/watch?v=${id}`);

let extractorCalls = 0;
const extracted = await dispatchVideoYoutubeAnalyze(childRequest, {
  extractor: async (received) => {
    extractorCalls += 1;
    assert.equal(received.analysis_type, "video2implementation");
    return { task_id: received.task_id, video_id: received.video_id, source_status: "extracted" };
  },
});
assert.equal(extractorCalls, 1);
assert.equal(extracted.video_id, id);

const envelope = {
  task_id: childRequest.id,
  video_id: id,
  canonical_url: `https://www.youtube.com/watch?v=${id}`,
  analysis_id: "v2i-synthetic-analysis",
  prompt_version: "v3",
  EXTRACTION_STATUS: "available",
  AUDIOVISUAL_STATUS: "partial",
  DOCUMENT_VALIDATION_STATUS: "partial",
  DELIVERY_STATUS: "not_requested",
  document_reference: {
    analysis_id: "v2i-synthetic-analysis",
    relative_path: "artifacts/v2i-synthetic-analysis.md",
    sha256: "a".repeat(64),
    size_bytes: 42,
  },
  artifact_ref: "artifacts/v2i-synthetic-analysis.md",
  artifact_sha256: "a".repeat(64),
  summary: "synthetic compact result",
  errors: [],
  limitations: ["evidence_partial"],
  provider_metrics: { model: "synthetic", invocation_count: 1 },
};
assert.equal(validateVideo2ImplementationResult(JSON.stringify(envelope), childRequest).valid, true);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({ ...envelope, document_markdown: "raw" }), childRequest).valid, false);
assert.equal(validateVideo2ImplementationResult(JSON.stringify({ ...envelope, artifact_ref: "../../outside.md" }), childRequest).valid, false);

const summaryRequest = {
  ...childRequest,
  prompt: `kind=${VIDEO_YOUTUBE_ANALYZE_KIND}\nvideo_url=https://www.youtube.com/watch?v=${id}\nanalysis_type=summary\nrequested_formats=json\ndelivery_targets=vps\ndestination_alias=vps_documents\nrequester=rey`,
};
const summaryResult = {
  task_id: summaryRequest.id,
  video_id: id,
  canonical_url: `https://www.youtube.com/watch?v=${id}`,
  metadata: { title: "synthetic", channel: "synthetic", description: null },
  transcript: { status: "available", segments: [] },
  source_status: "partial",
  extraction_errors: [],
};
assert.equal(validateVideoYoutubeResult(JSON.stringify(summaryResult), summaryRequest).valid, true);
assert.equal(classifyVideoYoutubeIntent({ kind: "pulse.social", id: "social-1", origin: "rey", prompt: "social strategy" }), null);

console.log("video2implementation-bridge: PASS");
