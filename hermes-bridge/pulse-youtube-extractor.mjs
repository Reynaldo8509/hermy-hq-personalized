import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseYoutubeUrl } from "./video-youtube-contract.mjs";

const execFileAsync = promisify(execFile);
export const TRANSCRIPT_PYTHON = "$HOME/hermes/app/venv/bin/python";
export const TRANSCRIPT_SCRIPT =
  "$HOME/hermes/skills/media/youtube-content/scripts/fetch_transcript.py";
export const EXTRACTION_TIMEOUT_MS = 20000;
const MAX_TRANSCRIPT_CHARS = 200000;
const MAX_DIAGNOSTIC_CHARS = 500;

function boundedText(value, max = 10000) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function redactDiagnosticText(value) {
  if (typeof value !== "string" || !value) return null;
  let text = value.slice(0, MAX_DIAGNOSTIC_CHARS);
  text = text.replace(/(authorization|x-goog-api-key|api[_ -]?key)\s*[:=]\s*bearer\s+[^,\s]+/gi, "$1=[REDACTED]");
  text = text.replace(/(authorization|x-goog-api-key|api[_ -]?key|bearer)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]");
  text = text.replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{12,}|ak_[0-9A-Za-z_-]{12,})\b/g, "[REDACTED]");
  return text.slice(0, MAX_DIAGNOSTIC_CHARS);
}

function relevantSubprocessOutput(value) {
  const text = redactDiagnosticText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === "string") return redactDiagnosticText(parsed.error);
  } catch {}
  return text;
}

export function subprocessFailureDiagnostic(stage, error) {
  const rawCode = error?.code;
  const errorCode = typeof rawCode === "string" ? rawCode : "subprocess_exit";
  const exitCode = Number.isInteger(rawCode)
    ? rawCode
    : Number.isInteger(error?.exitCode) ? error.exitCode : null;
  const signal = typeof error?.signal === "string" ? error.signal.slice(0, 32) : null;
  const timeout = errorCode === "ETIMEDOUT"
    || (error?.killed === true && ["SIGTERM", "SIGKILL"].includes(signal));
  const diagnostic = {
    stage: String(stage || "unknown").slice(0, 64),
    exception_type: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
    error_code: errorCode.slice(0, 64),
    exit_code: exitCode,
    stderr: relevantSubprocessOutput(error?.stderr),
    stdout: relevantSubprocessOutput(error?.stdout),
    signal,
    timeout,
  };
  return `${diagnostic.stage}:${JSON.stringify(diagnostic)}`;
}

export function transcriptFromScriptJson(value) {
  const fullText = boundedText(value?.full_text, MAX_TRANSCRIPT_CHARS);
  const timestampedText = boundedText(value?.timestamped_text, MAX_TRANSCRIPT_CHARS);
  const segments = (timestampedText || "")
    .split("\n")
    .map((line) => line.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ timestamp: match[1], text: boundedText(match[2], 2000) }));
  return {
    status: fullText ? "available" : "unavailable",
    text: fullText,
    segments,
    visual_evidence: "not_available",
    duration: null,
    error: boundedText(value?.error, 2000),
  };
}

export function buildPulseExtractionResult({ task, metadata = {}, transcript, errors = [] }) {
  const extractionErrors = errors.filter(Boolean).slice(0, 20);
  const hasMetadata = Boolean(metadata.title || metadata.channel);
  const hasTranscript = transcript?.status === "available";
  const metadataPartial = hasMetadata && metadata.description === null;
  return {
    task_id: task.task_id,
    requester: task.requester,
    video_id: task.video_id,
    canonical_url: task.video_url,
    timestamps: task.timestamps || null,
    metadata: {
      title: boundedText(metadata.title),
      channel: boundedText(metadata.channel),
      description: boundedText(metadata.description, 30000),
      links: Array.isArray(metadata.links) ? metadata.links.slice(0, 50) : [],
      chapters: Array.isArray(metadata.chapters) ? metadata.chapters.slice(0, 100) : [],
      duration: metadata.duration ?? null,
      accessibility: metadata.accessibility ?? null,
      status: hasMetadata ? "available" : "unavailable",
    },
    transcript: transcript || {
      status: "unavailable",
      text: null,
      segments: [],
      visual_evidence: "not_available",
      duration: null,
    },
    chapters: Array.isArray(metadata.chapters) ? metadata.chapters.slice(0, 100) : [],
    technical_links: Array.isArray(metadata.links) ? metadata.links.slice(0, 50) : [],
    source_status: hasMetadata || hasTranscript
      ? (extractionErrors.length || metadataPartial ? "partial" : "extracted")
      : "failed",
    extraction_errors: extractionErrors,
  };
}

export async function fetchOembed(canonicalUrl, timeoutMs = EXTRACTION_TIMEOUT_MS) {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", canonicalUrl);
  endpoint.searchParams.set("format", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) throw new Error("oembed_http_" + response.status);
    const value = await response.json();
    return {
      title: boundedText(value.title),
      channel: boundedText(value.author_name),
      description: null,
      links: [],
      chapters: [],
      duration: null,
      accessibility: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTranscript(videoUrl, timeoutMs = EXTRACTION_TIMEOUT_MS) {
  const result = await execFileAsync(
    TRANSCRIPT_PYTHON,
    [TRANSCRIPT_SCRIPT, videoUrl, "--timestamps"],
    { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
  );
  try {
    return transcriptFromScriptJson(JSON.parse(result.stdout));
  } catch (error) {
    error.stdout = result.stdout;
    throw error;
  }
}

export async function extractPulseVideo(task, dependencies = {}) {
  let parsed;
  try { parsed = parseYoutubeUrl(task.video_url); }
  catch (error) { throw new Error("invalid_youtube_url:" + error.message); }
  const metadataFetcher = dependencies.metadataFetcher || fetchOembed;
  const transcriptFetcher = dependencies.transcriptFetcher || fetchTranscript;
  const errors = [];
  let metadata = {};
  let transcript = null;
  try { metadata = await metadataFetcher(parsed.canonical_url); }
  catch (error) { errors.push(subprocessFailureDiagnostic("metadata", error)); }
  try { transcript = await transcriptFetcher(parsed.canonical_url); }
  catch (error) { errors.push(subprocessFailureDiagnostic("transcript", error)); }
  return buildPulseExtractionResult({ task: { ...task, video_url: parsed.canonical_url, video_id: parsed.video_id }, metadata, transcript, errors });
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2]) {
  const task = { task_id: "controlled-cli", video_url: process.argv[2] };
  extractPulseVideo(task).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
