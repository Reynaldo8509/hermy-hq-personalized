import assert from "node:assert/strict";
import {
  buildPulseExtractionResult,
  extractPulseVideo,
  subprocessFailureDiagnostic,
} from "./pulse-youtube-extractor.mjs";

const task = {
  task_id: "phase3f3-extractor-mock",
  requester: "rey",
  video_url: "https://www.youtube.com/watch?v=Gjnup-PuquQ",
  video_id: "Gjnup-PuquQ",
};

const subprocessError = Object.assign(new Error("Command failed"), {
  code: 1,
  exitCode: 1,
  stdout: JSON.stringify({ error: "No transcript found for this video" }),
  stderr: "provider returned no transcript",
});
const diagnostic = subprocessFailureDiagnostic("transcript", subprocessError);
const diagnosticValue = JSON.parse(diagnostic.slice("transcript:".length));
assert.equal(diagnosticValue.error_code, "subprocess_exit");
assert.equal(diagnosticValue.exit_code, 1);
assert.equal(diagnosticValue.stdout, "No transcript found for this video");
assert.equal(diagnosticValue.stderr, "provider returned no transcript");
assert.equal(diagnosticValue.timeout, false);
assert.ok(diagnostic.length < 1500);

const timeoutError = Object.assign(new Error("transcript timed out"), {
  code: "ETIMEDOUT",
  killed: true,
  signal: "SIGTERM",
  stderr: "subprocess timeout",
});
const timeoutValue = JSON.parse(
  subprocessFailureDiagnostic("transcript", timeoutError).slice("transcript:".length),
);
assert.equal(timeoutValue.error_code, "ETIMEDOUT");
assert.equal(timeoutValue.timeout, true);
assert.equal(timeoutValue.signal, "SIGTERM");

const extraction = await extractPulseVideo(task, {
  metadataFetcher: async () => ({
    title: "Synthetic technical video",
    channel: "Synthetic",
    description: null,
    links: [],
    chapters: [],
    duration: null,
  }),
  transcriptFetcher: async () => { throw subprocessError; },
});
assert.equal(extraction.video_id, "Gjnup-PuquQ");
assert.equal(extraction.transcript.status, "unavailable");
assert.equal(extraction.source_status, "partial");
assert.equal(extraction.extraction_errors.length, 1);
const preserved = JSON.parse(extraction.extraction_errors[0].slice("transcript:".length));
assert.equal(preserved.stdout, "No transcript found for this video");
assert.equal(preserved.exit_code, 1);

const synthetic = buildPulseExtractionResult({ task, metadata: {}, transcript: null, errors: [diagnostic] });
assert.equal(synthetic.transcript.status, "unavailable");
assert.equal(synthetic.extraction_errors.length, 1);
assert.ok(synthetic.extraction_errors[0].length < 1500);

console.log("PASS pulse-youtube-extractor-diagnostics-tests");
