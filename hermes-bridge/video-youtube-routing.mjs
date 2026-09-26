import {
  VIDEO_YOUTUBE_ANALYZE_KIND,
  normalizeVideoTask,
  parseYoutubeUrl,
} from "./video-youtube-contract.mjs";

const MAX_KINDS = new Set(["max.chief-of-staff", "max.deep-analysis"]);
const AUTHORIZED_ORIGINS = new Set(["web", "hermes"]);

function field(prompt, name) {
  const match = String(prompt).match(new RegExp("\\b" + name + "\\s*=\\s*([^\\s,;]+)", "i"));
  return match?.[1] || null;
}

export function explicitVideoContractFromMaxRequest(request) {
  if (!MAX_KINDS.has(request?.kind) || !AUTHORIZED_ORIGINS.has(request?.origin) || request?.sideEffecting) return null;
  const prompt = String(request.prompt || "").split("\n\nHistorical context")[0];
  const explicitMarker = /(?:^|[\n;])\s*(?:kind\s*=\s*)?video\.youtube\.analyze\b/i.test(prompt);
  if (!explicitMarker) return null;
  if (prompt.includes("\\n")) return { valid: false, reason: "contract_newline_escape_literal" };
  const candidate = prompt.match(/https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"']+/i)?.[0]?.replace(/[),.;!?]+$/, "");
  if (!candidate) return { valid: false, reason: "video_url_required" };
  let youtube;
  try { youtube = parseYoutubeUrl(candidate); }
  catch (error) { return { valid: false, reason: error.message }; }
  const taskRequest = {
    ...request,
    kind: VIDEO_YOUTUBE_ANALYZE_KIND,
    video_url: youtube.canonical_url,
    requester: field(prompt, "requester") || request.origin,
    analysis_type: field(prompt, "analysis_type") || "summary",
    requested_formats: [field(prompt, "requested_formats") || "json"],
    delivery_targets: [field(prompt, "delivery_targets") || "vps"],
    destination_alias: field(prompt, "destination_alias") || "vps_documents",
  };
  try {
    return { valid: true, task: normalizeVideoTask(taskRequest) };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}
