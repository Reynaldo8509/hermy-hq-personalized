import test from "node:test";
import assert from "node:assert/strict";
import { dispatchKindBlockReason } from "./dispatch-kind-policy.mjs";

test("blocks the unsupported MAX notification route before it enters the queue", () => {
  assert.equal(dispatchKindBlockReason("max.owner_notification"), "notification_delivery_not_implemented");
  assert.equal(dispatchKindBlockReason(" max.owner_notification "), "notification_delivery_not_implemented");
  assert.equal(dispatchKindBlockReason("MAX.OWNER_NOTIFICATION"), "notification_delivery_not_implemented");
  assert.equal(dispatchKindBlockReason("max.chief-of-staff"), null);
});
