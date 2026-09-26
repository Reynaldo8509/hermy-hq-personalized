import assert from "node:assert/strict";
import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  normalizeVideoTask,
} from "./video-youtube-contract.mjs";
import { classifyVideoYoutubeIntent, dispatchVideoYoutubeAnalyze } from "./video-youtube-dispatch.mjs";

const request = {
  id: "agent-request-synthetic",
  origin: "rey",
  kind: VIDEO_YOUTUBE_ANALYZE_KIND,
  title: "Analizar video",
  prompt: "video.youtube.analyze https://www.youtube.com/shorts/dQw4w9WgXcQ",
};
assert.equal(classifyVideoYoutubeIntent(request), VIDEO_YOUTUBE_ANALYZE_KIND);
let received;
const result = await dispatchVideoYoutubeAnalyze(request, {
  extractor: async (task) => {
    received = task;
    return {
      task_id: task.task_id,
      requester: task.requester,
      video_id: task.video_id,
      canonical_url: task.video_url,
      transcript: { status: "available", segments: [{ timestamp: "0:00", text: "mock" }] },
      source_status: "extracted",
      extraction_errors: [],
    };
  },
});
assert.equal(received.task_id, request.id);
assert.equal(received.requester, request.origin);
assert.equal(received.video_id, "dQw4w9WgXcQ");
assert.equal(received.video_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(result.task_id, request.id);
assert.equal(result.video_id, received.video_id);
await assert.rejects(
  () => dispatchVideoYoutubeAnalyze({ ...request, kind: "pulse.social" }, { extractor: async () => ({}) }),
  /video_youtube_kind_required/,
);
console.log("video-youtube-dispatch: PASS");
