import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAegisRequest, isAuthorizedAegisFreeInference } from "./agent-inference-dispatch.mjs";
import { OPENROUTER_COHERE_FREE_ROUTE, TOKENHARBOR_DEEPSEEK_FREE_ROUTE } from "./privacy-model-router.mjs";

const route = { ...TOKENHARBOR_DEEPSEEK_FREE_ROUTE, tier: "remote_free_primary" };
const request = {
  id: "synthetic-aegis-1", kind: "aegis.security", title: "Synthetic defensive review",
  prompt: "[[REMOTE_FREE_ALLOWED]] Analiza este escenario sintético, sin datos reales.",
  origin: "web", action: "audit", capability: "read_only", sideEffecting: false,
};

test("Aegis uses the free route only for an explicitly opted-in synthetic read-only audit", async () => {
  assert.equal(isAuthorizedAegisFreeInference(request, "REMOTE_FREE_ALLOWED", route), true);
  let localCalls = 0;
  let remoteCalls = 0;
  const result = await dispatchAegisRequest({
    request, privacyClass: "REMOTE_FREE_ALLOWED", route,
    runLocalReadOnly: async () => { localCalls += 1; return "local"; },
    inferFree: async (value) => { remoteCalls += 1; assert.equal(value, request); return "synthetic"; },
  });
  assert.equal(result, "synthetic");
  assert.equal(remoteCalls, 1);
  assert.equal(localCalls, 0);
});

test("Aegis keeps private or unapproved work local and rejects unsafe remote shapes", async () => {
  const cases = [
    [{ ...request, prompt: "Review a private incident" }, "LOCAL_ONLY", route],
    [request, "PREFER_LOCAL", route],
    [request, "REMOTE_FREE_ALLOWED", { ...route, provider: "groq", model: "openai/gpt-oss-20b" }],
    [request, "REMOTE_FREE_ALLOWED", { ...route, ...OPENROUTER_COHERE_FREE_ROUTE, tier: "remote_free_unavailable" }],
    [{ ...request, sideEffecting: true }, "REMOTE_FREE_ALLOWED", route],
    [{ ...request, attachments: [{ name: "synthetic.txt" }] }, "REMOTE_FREE_ALLOWED", route],
    [{ ...request, origin: "workflow" }, "REMOTE_FREE_ALLOWED", route],
    [{ ...request, capability: "privileged" }, "REMOTE_FREE_ALLOWED", route],
    [{ ...request, action: "scan" }, "REMOTE_FREE_ALLOWED", route],
  ];
  for (const [candidate, privacyClass, candidateRoute] of cases) {
    assert.equal(isAuthorizedAegisFreeInference(candidate, privacyClass, candidateRoute), false);
    let remoteCalls = 0;
    let localCalls = 0;
    const result = await dispatchAegisRequest({
      request: candidate, privacyClass, route: candidateRoute,
      runLocalReadOnly: async () => { localCalls += 1; return "local"; },
      inferFree: async () => { remoteCalls += 1; return "remote"; },
    });
    assert.equal(result, "local");
    assert.equal(localCalls, 1);
    assert.equal(remoteCalls, 0);
  }
});
