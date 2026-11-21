import test from "node:test";
import assert from "node:assert/strict";
import { autoApprovalEnabled } from "./delegated-approval-policy.mjs";

test("delegated approvals require the exact server-side true flag", () => {
  assert.equal(autoApprovalEnabled(undefined), false);
  assert.equal(autoApprovalEnabled("false"), false);
  assert.equal(autoApprovalEnabled("TRUE"), false);
  assert.equal(autoApprovalEnabled("true"), true);
});
