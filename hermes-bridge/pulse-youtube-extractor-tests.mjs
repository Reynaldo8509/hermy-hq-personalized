import assert from "node:assert/strict";
import { extractPulseVideo, transcriptFromScriptJson } from "./pulse-youtube-extractor.mjs";

const task = {
  task_id: "synthetic-1",
  requester: "synthetic",
  video_url: "https://youtu.be/dQw4w9WgXcQ",
  timestamps: { received_at: "2026-09-20T00:00:00Z" },
};
const result = await extractPulseVideo(task, {
  metadataFetcher: async () => ({
    title: "Synthetic title",
    channel: "Synthetic channel",
    description: "Synthetic description",
  }),
  transcriptFetcher: async () => transcriptFromScriptJson({
    full_text: "hello world",
    timestamped_text: ["0:00 hello", "0:02 world"].join("\n"),
  }),
});
assert.equal(result.source_status, "extracted");
assert.equal(result.metadata.title, "Synthetic title");
assert.equal(result.metadata.channel, "Synthetic channel");
assert.deepEqual(result.timestamps, task.timestamps);
assert.equal(result.transcript.segments.length, 2);
assert.equal(result.transcript.visual_evidence, "not_available");
assert.deepEqual(result.technical_links, []);
const partial = await extractPulseVideo(task, {
  metadataFetcher: async () => { throw new Error("mock_metadata"); },
  transcriptFetcher: async () => transcriptFromScriptJson({ error: "mock_transcript" }),
});
assert.equal(partial.source_status, "failed");
assert.equal(partial.extraction_errors.length, 1);
console.log("pulse-youtube-extractor: PASS");
