#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  buildPreparedVideoResult,
  parseYoutubeUrl,
} from "./video-youtube-contract.mjs";

const id = "dQw4w9WgXcQ";
for (const url of [
  `https://www.youtube.com/watch?v=${id}`,
  `https://youtu.be/${id}`,
  `https://www.youtube.com/shorts/${id}`,
  `https://www.youtube.com/live/${id}?feature=share`,
]) assert.equal(parseYoutubeUrl(url).video_id, id);
for (const url of [
  `http://www.youtube.com/watch?v=${id}`,
  `https://youtube.com.evil.example/watch?v=${id}`,
  `https://localhost/watch?v=${id}`,
  `https://www.youtube.com/watch?v=bad`,
]) assert.throws(() => parseYoutubeUrl(url));

const result = buildPreparedVideoResult({
  id: "synthetic-task",
  origin: "telegram",
  metadata: {
    video_url: `https://youtu.be/${id}`,
    analysis_type: "video2implementation",
    requested_formats: ["markdown", "json"],
    delivery_targets: ["telegram"],
    destination_alias: "telegram_owner",
  },
});
assert.equal(VIDEO_YOUTUBE_ANALYZE_KIND, "video.youtube.analyze");
assert.equal(result.source_status.status, "not_activated");
assert.equal(result.video_id, id);
assert.equal(result.metadata, null);
assert.ok(result.capabilities.some(item => item.name === "audiovisual_analysis"));
assert.equal(buildPreparedVideoResult({
  id: "invalid",
  origin: "telegram",
  metadata: { video_url: "https://localhost/x", analysis_type: "summary", requested_formats: ["markdown"], delivery_targets: ["telegram"], destination_alias: "telegram_owner" },
}).source_status.status, "invalid_request");
console.log("video-youtube-contract: PASS");
