import { VIDEO_YOUTUBE_ANALYZE_KIND } from "./video-youtube-contract.mjs";

export function suppressVideoSuccessAlert(request, status) {
  return request?.kind === VIDEO_YOUTUBE_ANALYZE_KIND && status === "done";
}
