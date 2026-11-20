import test from "node:test";
import assert from "node:assert/strict";
import { resolveFreshRemoteStatus, resolveTailnetReachability, tailnetObservationMaxAgeMs } from "./infrastructure-domain.mjs";

const now = Date.parse("2026-10-01T05:30:00.000Z");
const observedAt = "2026-10-01T05:28:29.620Z";

test("does not attribute an unrelated fresh peer to a registered node", () => {
  const reachability = resolveTailnetReachability({
    nodeId: "toshiba-p50",
    hostnames: ["GalaxyS25Plus5G"],
    peers: [{ hostname: "GalaxyS25Plus5G", online: false, lastSeenAt: "2026-09-30T21:59:00.100Z" }],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability, null);
});

test("reports Dell Offline when its registered Tailscale peer is freshly offline", () => {
  const reachability = resolveTailnetReachability({
    nodeId: "dell-g15",
    peers: [{ hostname: "KaliDellG15", online: false, lastSeenAt: "2026-10-01T05:20:00.000Z" }],
    observedAt,
    now,
    maxAgeMs: tailnetObservationMaxAgeMs(1800),
  });
  assert.equal(reachability.status, "offline");
  assert.equal(reachability.identityMatched, true);
});

test("keeps Dell Online through its current Tailscale identity regardless of wired interface state", () => {
  const reachability = resolveTailnetReachability({
    nodeId: "dell-g15",
    hostnames: ["KaliDellG15"],
    peers: [{ hostname: "KaliDellG15", online: true }],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability.status, "online");
  assert.equal(reachability.identityMatched, true);
});

test("prefers the registered Toshiba identity when it exists", () => {
  const reachability = resolveTailnetReachability({
    nodeId: "toshiba-p50",
    hostnames: ["GalaxyS25Plus5G"],
    peers: [
      { hostname: "toshibap50-kali", online: true },
      { hostname: "GalaxyS25Plus5G", online: false },
    ],
    observedAt,
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(reachability.status, "online");
  assert.equal(reachability.hostname, "toshibap50-kali");
  assert.equal(reachability.identityMatched, true);
});

test("does not infer Offline from absent or stale reachability data", () => {
  assert.equal(resolveTailnetReachability({
    nodeId: "toshiba-p50",
    hostnames: ["GalaxyS25Plus5G"],
    peers: [{ hostname: "GalaxyS25Plus5G", online: false }],
    observedAt: "2026-10-01T04:00:00.000Z",
    now,
    maxAgeMs: 60 * 60 * 1000,
  }), null);
  assert.equal(resolveTailnetReachability({
    nodeId: "toshiba-p50",
    hostnames: ["toshibap50-kali"],
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
    nodeId: "dell-g15",
    peers: [{ hostname: "KaliDellG15", online: true }],
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
