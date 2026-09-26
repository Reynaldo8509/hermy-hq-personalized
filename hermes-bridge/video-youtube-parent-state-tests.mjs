import assert from "node:assert/strict";
import { applyMockChildOutcome, isPendingVideoDelegation } from "./video-youtube-parent-state.mjs";

const request = { id: "parent-1", kind: "max.chief-of-staff" };
const contract = { valid: true, task: { video_id: "dQw4w9WgXcQ" } };
const child = { id: "child-1", kind: "video.youtube.analyze" };
const validReport = "Delegué el análisis explícito de YouTube a Pulse. Solicitud hija: child-1.\n\nCAUSA_CONFIRMADA: x\nHIPOTESIS: x\nREPARACION_APLICADA: x\nVALIDACION: x\nLIMITACIONES: x\nSIGUIENTE_ACCION: x";

assert.equal(isPendingVideoDelegation(request, contract, validReport), true);
assert.equal(isPendingVideoDelegation(request, contract, "command error: failed"), false);
assert.equal(isPendingVideoDelegation({ ...request, kind: "oneshot" }, contract, validReport), false);

const parsedResult = {
  task_id: child.id,
  video_id: "dQw4w9WgXcQ",
  source_status: "partial",
  transcript: { status: "available", segments: [{ timestamp: "0:01", text: "synthetic" }] },
  error: null,
  extraction_errors: [],
};
const done = applyMockChildOutcome({ ...request, status: "running" }, child, { status: "done", result: JSON.stringify(parsedResult) });
assert.equal(done.status, "done");
assert.equal(done.error, null);
assert.equal(done.result.child_request_id, child.id);
assert.equal(done.result.result.source_status, "partial");
assert.deepEqual(done.result.result.extraction_errors, []);

const failed = applyMockChildOutcome({ ...request, status: "running" }, child, { status: "failed", error: "youtube_provider_unavailable" });
assert.equal(failed.status, "failed");
assert.equal(failed.result, null);
assert.match(failed.error, /youtube_provider_unavailable/);
assert.throws(() => applyMockChildOutcome({ ...request, status: "running" }, child, { status: "running" }), /child_must_be_terminal/);
assert.throws(() => applyMockChildOutcome({ ...request, status: "done" }, child, { status: "done", result: "{}" }), /parent_must_remain_running/);
console.log("video-youtube-parent-state: PASS");
