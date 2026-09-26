import assert from "node:assert/strict";
import { explicitVideoContractFromMaxRequest } from "./video-youtube-routing.mjs";

const base = {
  id: "max-parent-test",
  origin: "web",
  kind: "max.chief-of-staff",
  sideEffecting: false,
  prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ\nanalysis_type=summary requested_formats=json delivery_targets=vps destination_alias=vps_documents requester=rey",
};
const valid = explicitVideoContractFromMaxRequest(base);
assert.equal(valid.valid, true);
assert.equal(valid.task.video_id, "dQw4w9WgXcQ");
assert.equal(valid.task.requester, "rey");
assert.deepEqual(valid.task.requested_formats, ["json"]);
assert.deepEqual(valid.task.delivery_targets, ["vps"]);
assert.equal(valid.task.destination_alias, "vps_documents");
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "Busca videos de YouTube sobre seguridad" }), null);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "Texto citado: video.youtube.analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), null);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "video.youtube.analyze https://example.invalid/video analysis_type=summary requested_formats=json delivery_targets=vps destination_alias=vps_documents" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nanalysis_type=summary requested_formats=json delivery_targets=vps destination_alias=/tmp" }).valid, false);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "kind=video.youtube.analyze\nvideo_url=https://www.youtube.com/watch?v=dQw4w9WgXcQ\nanalysis_type=summary requested_formats=json delivery_targets=vps destination_alias=vps_documents" }).valid, true);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, sideEffecting: true }), null);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, origin: "max" }), null);
assert.equal(explicitVideoContractFromMaxRequest({ ...base, prompt: "video.youtube.analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ analysis_type=summary requested_formats=xml delivery_targets=vps destination_alias=vps_documents" }).valid, false);
console.log("video-youtube-routing: PASS");
