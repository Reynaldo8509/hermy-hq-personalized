import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  classifyVideoYoutubeIntent,
  normalizeVideoTask,
} from "./video-youtube-contract.mjs";

export async function dispatchVideoYoutubeAnalyze(request, { extractor }) {
  if (request?.kind !== VIDEO_YOUTUBE_ANALYZE_KIND) {
    throw new Error("video_youtube_kind_required");
  }
  if (typeof extractor !== "function") {
    throw new Error("video_youtube_extractor_required");
  }
  const task = normalizeVideoTask(request);
  return extractor(task);
}

export { classifyVideoYoutubeIntent };
