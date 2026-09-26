import assert from "node:assert/strict";
import { explicitVideoContractFromMaxRequest } from "./video-youtube-routing.mjs";

const fields = [
  "kind=video.youtube.analyze",
  "video_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "analysis_type=summary",
  "requested_formats=json",
  "delivery_targets=vps",
  "destination_alias=vps_documents",
  "requester=rey",
];
const realNewlinePrompt = fields.join("\n");
const base = { id: "transport-test", origin: "web", kind: "max.chief-of-staff", sideEffecting: false };

const valid = explicitVideoContractFromMaxRequest({ ...base, prompt: realNewlinePrompt });
assert.equal(valid.valid, true);
assert.equal(valid.task.video_id, "dQw4w9WgXcQ");

const jsonPayload = JSON.stringify({ ...base, prompt: realNewlinePrompt });
const parsedPayload = JSON.parse(jsonPayload);
assert.equal(parsedPayload.prompt.includes("\n"), true);
assert.equal(explicitVideoContractFromMaxRequest(parsedPayload).valid, true);

const literalEscapedPrompt = fields.join("\\n");
const literal = explicitVideoContractFromMaxRequest({ ...base, prompt: literalEscapedPrompt });
assert.equal(literal.valid, false);
assert.equal(literal.reason, "contract_newline_escape_literal");

const doubleSerialized = JSON.stringify({ ...base, prompt: jsonPayload });
const doubleParsed = JSON.parse(doubleSerialized);
assert.equal(explicitVideoContractFromMaxRequest(doubleParsed), null);

assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=bad" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ\nrequested_formats=xml" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ\ndestination_alias=/tmp" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "Busca videos de YouTube sobre seguridad" }), null);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).valid, true);
console.log("video-youtube-transport: PASS");
