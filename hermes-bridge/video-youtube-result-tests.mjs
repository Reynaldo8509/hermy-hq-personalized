import assert from "node:assert/strict";
import { validateVideoYoutubeResult } from "./video-youtube-result.mjs";

const request = {
  id: "request-result-test",
  origin: "max",
  kind: "video.youtube.analyze",
  title: "result test",
  prompt: "video.youtube.analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const base = {
  task_id: request.id,
  video_id: "dQw4w9WgXcQ",
  canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  metadata: { title: "title", channel: "channel", description: null },
  transcript: { status: "available", segments: [{ timestamp: "0:00", text: "mock" }] },
  source_status: "extracted",
  extraction_errors: [],
};
assert.equal(validateVideoYoutubeResult(JSON.stringify(base), request).valid, true);
assert.equal(validateVideoYoutubeResult(JSON.stringify({ ...base, source_status: "partial" }), request).valid, true);
assert.equal(validateVideoYoutubeResult(JSON.stringify({ ...base, task_id: "wrong" }), request).valid, false);
assert.equal(validateVideoYoutubeResult(JSON.stringify({ ...base, video_id: "wrong" }), request).valid, false);
assert.equal(validateVideoYoutubeResult("{not-json}", request).valid, false);
assert.equal(validateVideoYoutubeResult(JSON.stringify({}), request).valid, false);
assert.equal(validateVideoYoutubeResult(JSON.stringify({ ...base, source_status: "failed" }), request).valid, false);
assert.equal(validateVideoYoutubeResult(JSON.stringify({ ...base, source_status: "partial", metadata: { description: "invented" } }), request).valid, false);
console.log("video-youtube-result: PASS");
