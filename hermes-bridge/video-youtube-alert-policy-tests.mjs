import assert from "node:assert/strict";
import { suppressVideoSuccessAlert } from "./video-youtube-alert-policy.mjs";

const validPartial = { kind: "video.youtube.analyze", result: { source_status: "partial", error: null, extraction_errors: [] } };
assert.equal(suppressVideoSuccessAlert(validPartial, "done"), true);
assert.equal(suppressVideoSuccessAlert({ ...validPartial, result: { source_status: "extracted", error: null } }, "done"), true);
assert.equal(suppressVideoSuccessAlert(validPartial, "failed"), false);
assert.equal(suppressVideoSuccessAlert({ kind: "pulse.social" }, "done"), false);
assert.equal(suppressVideoSuccessAlert({ kind: "max.chief-of-staff" }, "done"), false);
console.log("video-youtube-alert-policy: PASS");
