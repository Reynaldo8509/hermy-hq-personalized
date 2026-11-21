import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAtlasFromMax } from "./atlas-max-hq-dispatch.mjs";

const request = {
  id: "synthetic-parent-01", origin: "web", capability: "read_only", sideEffecting: false,
  userTask: "Summarize https://www.rfc-editor.org/rfc/rfc9110.html",
};

function response() {
  return { status: 201, json: async () => ({ duplicate: false, request: {
    id: "synthetic-child-01", kind: "atlas.research", origin: "web", action: "research",
    capability: "read_only", sideEffecting: false, status: "queued",
  } }) };
}

test("requires an explicit host allowlist for production HQ dispatch", async () => {
  let calls = 0;
  await assert.rejects(dispatchAtlasFromMax(request, {
    env: { NODE_ENV: "production", NEXT_PUBLIC_BASE_URL: "https://hq.example", INTERNAL_API_SECRET: "synthetic-secret" },
    fetchImpl: async () => { calls += 1; return response(); },
  }), { code: "max_atlas_hq_endpoint_not_allowlisted" });
  assert.equal(calls, 0);
});

test("dispatches only to the explicitly allowlisted HTTPS HQ origin", async () => {
  let target = null;
  const result = await dispatchAtlasFromMax(request, {
    env: {
      NODE_ENV: "production", NEXT_PUBLIC_BASE_URL: "https://hq.example",
      HERMY_HQ_ALLOWED_HOST: "hq.example", INTERNAL_API_SECRET: "synthetic-secret",
    },
    fetchImpl: async (url) => { target = url; return response(); },
  });
  assert.equal(target, "https://hq.example/api/hermes/dispatch");
  assert.equal(result.status, "queued");
});

test("preserves loopback-only dispatch for isolated tests", async () => {
  let target = null;
  await dispatchAtlasFromMax(request, {
    env: { NODE_ENV: "test", NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:3000", INTERNAL_API_SECRET: "synthetic-secret" },
    fetchImpl: async (url) => { target = url; return response(); },
  });
  assert.equal(target, "http://127.0.0.1:3000/api/hermes/dispatch");
});
