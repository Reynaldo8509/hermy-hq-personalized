import assert from "node:assert/strict";
import test from "node:test";
import { canPublishInternalHonchoSummaryForOrigin } from "./honcho-summary-policy.mjs";

test("synthetic runtime test requests never publish Honcho summaries", () => {
  assert.equal(canPublishInternalHonchoSummaryForOrigin("test"), false);
  assert.equal(canPublishInternalHonchoSummaryForOrigin("TEST"), false);
  assert.equal(canPublishInternalHonchoSummaryForOrigin("web"), true);
  assert.equal(canPublishInternalHonchoSummaryForOrigin("workflow"), true);
  assert.equal(canPublishInternalHonchoSummaryForOrigin(null), true);
});
