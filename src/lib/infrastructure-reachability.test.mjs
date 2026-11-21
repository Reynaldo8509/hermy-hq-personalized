import test from "node:test";
import assert from "node:assert/strict";
import { resolveFreshRemoteStatus, resolveTailnetReachability, tailnetObservationMaxAgeMs } from "./infrastructure-domain.mjs";

const now = Date.parse("2026-10-01T05:30:00.000Z");
const observedAt = "2026-10-01T05:28:29.620Z";

test("does not attribute an unrelated fresh peer to the current node snapshot", () => {
  const reachability = resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [{ hostname: "unrelated-peer", online: false, lastSeenAt: "2026-09-30T21:59:00.100Z" }],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability, null);
});

test("reports a node offline when its current Tailscale peer is freshly offline", () => {
  const reachability = resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [{ hostname: "node-alpha", online: false, lastSeenAt: "2026-10-01T05:20:00.000Z" }],
    observedAt,
    now,
    maxAgeMs: tailnetObservationMaxAgeMs(1800),
  });
  assert.equal(reachability.status, "offline");
  assert.equal(reachability.identityMatched, true);
});

test("keeps a node online through its current Tailscale identity", () => {
  const reachability = resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [{ hostname: "node-alpha", online: true }],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability.status, "online");
  assert.equal(reachability.identityMatched, true);
});

test("matches a peer by configured identity regardless of mutable telemetry", () => {
  const reachability = resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [
      { hostname: "node-alpha", online: true },
      { hostname: "unrelated-peer", online: false },
    ],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability.status, "online");
  assert.equal(reachability.hostname, "node-alpha");
  assert.equal(reachability.identityMatched, true);
});

test("does not infer Offline from absent or stale reachability data", () => {
  assert.equal(resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [{ hostname: "unrelated-peer", online: false }],
    observedAt: "2026-10-01T04:00:00.000Z",
    now,
    maxAgeMs: 60 * 60 * 1000,
  }), null);
  assert.equal(resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  }), null);
});


test("expires Tailscale reachability after one collection interval plus bounded grace", () => {
  const maxAgeMs = tailnetObservationMaxAgeMs(1800);
  assert.equal(maxAgeMs, 35 * 60 * 1000);
  assert.equal(tailnetObservationMaxAgeMs(null), 15 * 60 * 1000);
  assert.equal(resolveTailnetReachability({
    expectedAliases: ["node-alpha"],
    peers: [{ hostname: "node-alpha", online: true }],
    observedAt: "2026-10-01T04:54:00.000Z",
    now: Date.parse("2026-10-01T05:30:00.000Z"),
    maxAgeMs,
  }), null);
});

test("does not carry an old Online hardware status forward after its sample expires", () => {
  assert.equal(resolveFreshRemoteStatus("online", false), "no-data");
  assert.equal(resolveFreshRemoteStatus("offline", true), "offline");
  assert.equal(resolveFreshRemoteStatus("online", true), "online");
});
