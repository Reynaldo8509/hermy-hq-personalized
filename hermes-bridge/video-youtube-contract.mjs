const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const ALLOWED_FORMATS = new Set(["markdown", "json", "docx", "pdf"]);
const ALLOWED_ANALYSIS_TYPES = new Set(["summary", "transcript", "metadata", "video2implementation"]);
const ALLOWED_DESTINATIONS = new Set(["telegram_owner", "vps_documents"]);
const ALLOWED_DELIVERY_TARGETS = new Set(["telegram", "vps"]);

export const VIDEO_YOUTUBE_ANALYZE_KIND = "video.youtube.analyze";
const VIDEO_URL_RE = /https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)(?:\/[^\s<>"']*)?/gi;

function videoUrlFromAgentRequest(request) {
  const metadata = request?.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const direct = metadata.video_url || request?.video_url;
  if (direct) return direct;
  if (request?.kind !== VIDEO_YOUTUBE_ANALYZE_KIND) return null;
  const text = String(request?.prompt || "") + "\n" + String(request?.title || "");
  return text.match(VIDEO_URL_RE)?.[0]?.replace(/[),.;!?]+$/, "") || null;
}

function requesterFromAgentRequest(request) {
  const metadata = request?.metadata && typeof request.metadata === "object" ? request.metadata : {};
  if (metadata.requester || request?.requester) return metadata.requester || request.requester;
  if (request?.kind !== VIDEO_YOUTUBE_ANALYZE_KIND) return null;
  const prompt = String(request?.prompt || "").split("\n\nHistorical context")[0];
  return prompt.match(/\brequester\s*=\s*([^\s,;]+)/i)?.[1] || null;
}

function promptField(request, name) {
  const prompt = String(request?.prompt || "").split("\n\nHistorical context")[0];
  const match = prompt.match(new RegExp("\\b" + name + "\\s*=\\s*([^\\s,;]+)", "i"));
  return match?.[1] || null;
}

function promptListField(request, name) {
  const prompt = String(request?.prompt || "").split("\n\nHistorical context")[0];
  const match = prompt.match(new RegExp("(?:^|\\n)\\s*" + name + "\\s*=\\s*([^\\n]+)", "i"));
  return match?.[1]?.trim() || null;
}

function listField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[;,\s]+/).filter(Boolean);
  return null;
}

export function parseYoutubeUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("video_url_required");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error("youtube_url_malformed"); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:") throw new Error("youtube_https_required");
  if (!["", "443"].includes(parsed.port) || parsed.username || parsed.password) {
    throw new Error("youtube_authority_invalid");
  }
  if (!ALLOWED_HOSTS.has(host)) throw new Error("youtube_domain_not_allowed");

  let videoId = "";
  if (host === "youtu.be") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 1) videoId = parts[0];
  } else if (parsed.pathname.replace(/\/$/, "") === "/watch") {
    videoId = parsed.searchParams.get("v") || "";
  } else {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && ["shorts", "live"].includes(parts[0].toLowerCase())) videoId = parts[1];
  }
  if (!VIDEO_ID_RE.test(videoId)) throw new Error("youtube_video_id_invalid");
  return {
    video_id: videoId,
    canonical_url: `https://www.youtube.com/watch?v=${videoId}`,
    source_host: host,
  };
}

function text(value, field, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${field}_invalid`);
  }
  return value.trim();
}

export function normalizeVideoTask(request) {
  const metadata = request?.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const source = { ...metadata, ...request };
  const videoUrl = videoUrlFromAgentRequest(request);
  const youtube = parseYoutubeUrl(videoUrl);
  const formatSource = source.requested_formats ?? promptListField(request, "requested_formats");
  const formats = listField(formatSource)
    ? [...new Set(listField(formatSource).map(value => String(value).trim().toLowerCase()))]
    : request?.kind === VIDEO_YOUTUBE_ANALYZE_KIND ? ["json"] : [];
  const targetSource = source.delivery_targets ?? promptListField(request, "delivery_targets");
  const targets = listField(targetSource)
    ? [...new Set(listField(targetSource).map(value => text(value, "delivery_target", 64)))]
    : request?.kind === VIDEO_YOUTUBE_ANALYZE_KIND ? ["vps"] : [];
  const analysisType = text(source.analysis_type || promptField(request, "analysis_type") || (request?.kind === VIDEO_YOUTUBE_ANALYZE_KIND ? "summary" : ""), "analysis_type", 64).toLowerCase();
  const destination = text(source.destination_alias || promptField(request, "destination_alias") || (request?.kind === VIDEO_YOUTUBE_ANALYZE_KIND ? "vps_documents" : ""), "destination_alias", 64);
  if (!ALLOWED_ANALYSIS_TYPES.has(analysisType)) throw new Error("analysis_type_not_allowed");
  if (!formats.length || formats.some(value => !ALLOWED_FORMATS.has(value))) throw new Error("requested_format_not_allowed");
  if (!targets.length || targets.some(value => !ALLOWED_DELIVERY_TARGETS.has(value))) throw new Error("delivery_target_not_allowed");
  if (!ALLOWED_DESTINATIONS.has(destination) || /[/\\]/.test(destination)) throw new Error("destination_alias_not_allowed");
  if (source.video_id && source.video_id !== youtube.video_id) throw new Error("video_id_mismatch");
  return {
    task_id: text(source.task_id || source.id, "task_id", 128),
    requester: text(requesterFromAgentRequest(request) || source.origin, "requester", 128),
    video_url: youtube.canonical_url,
    video_id: youtube.video_id,
    analysis_type: analysisType,
    requested_formats: formats,
    delivery_targets: targets,
    destination_alias: destination,
    status: String(source.status || "queued"),
    error_code: source.error_code || null,
    timestamps: source.timestamps || null,
  };
}

export function classifyVideoYoutubeIntent(request) {
  const textValue = String(request?.title || "") + "\n" + String(request?.prompt || "");
  return /\bvideo\.youtube\.analyze\b/i.test(textValue)
    ? VIDEO_YOUTUBE_ANALYZE_KIND
    : null;
}

export function selectPulseCapabilities(task) {
  const plan = [
    { name: "youtube_metadata", mode: "planned", external_call: false },
    { name: "transcript_extraction", mode: "planned", external_call: false },
  ];
  if (task.analysis_type === "video2implementation") {
    plan.push(
      { name: "video2implementation_prompt", mode: "pending_prompt_file", external_call: false },
      { name: "audiovisual_analysis", mode: "not_activated", external_call: false },
    );
  }
  if (task.requested_formats.some(value => ["markdown", "json"].includes(value))) {
    plan.push({ name: "deterministic_document", mode: "planned", external_call: false });
  }
  if (task.requested_formats.some(value => ["docx", "pdf"].includes(value))) {
    plan.push({ name: "office_document_export", mode: "pending_runtime", external_call: false });
  }
  plan.push({ name: "delivery", mode: "planned", destination_alias: task.destination_alias, external_call: false });
  return plan;
}

export function buildPreparedVideoResult(request) {
  try {
    const task = normalizeVideoTask(request);
    return {
      task_id: task.task_id,
      video_id: task.video_id,
      canonical_url: task.video_url,
      metadata: null,
      transcript: null,
      chapters: null,
      technical_links: null,
      source_status: {
        status: "not_activated",
        reason: "Phase 2 preparation only; no external extraction was invoked.",
      },
      extraction_errors: [],
      capabilities: selectPulseCapabilities(task),
    };
  } catch (error) {
    return {
      task_id: request?.id || request?.task_id || null,
      video_id: null,
      canonical_url: null,
      metadata: null,
      transcript: null,
      chapters: null,
      technical_links: null,
      source_status: { status: "invalid_request" },
      extraction_errors: [{ code: error.message || "invalid_request" }],
    };
  }
}
