import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHealthProbeEnvelope, classifyPreTransportFailure, classifyProviderHealthFailure,
  createProviderHealthRequest, HEALTH_PROBE_PROMPT,
  HEALTH_PROVIDER, HEALTH_REQUESTED_MODEL, HEALTH_RETRY_COOLDOWN_MS, HEALTH_TTL_MS,
  GROQ_ACCOUNT_TIER, GROQ_FREE_EVIDENCE_SOURCE, GROQ_FREE_PLAN_RATE_LIMITS,
  GROQ_HEALTH_PROVIDER, GROQ_HEALTH_REQUESTED_MODEL, GROQ_OPERATOR_EVIDENCE_SOURCE,
  OPENCODE_ZEN_HEALTH_REQUESTED_MODEL, healthIsFresh, produceProviderHealth, shouldRunProviderHealthProbe,
  validateHealthProbeEvidence, verifyFreeCatalog, verifyGroqFreeEvidence, verifyOpenCodeZenFreeEvidence,
} from "./provider-health.mjs";
import {
  buildCanaryArgs, createRemoteApprovalRecord, MIMO26_ROUTE, OPENCODE_ZEN_FREE_ROUTE,
  GROQ_FREE_ROUTE, OPENROUTER_FREE_ROUTE, preparePrivacyInvocation,
} from "./privacy-model-router.mjs";

const freeCatalog = { data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { prompt: "0", completion: "0" } }] };
const validUsage = {
  remote_attempted: true, remote_attempt_status: "success", actual_provider: "Token Harbor",
  actual_model: "deepseek-v4.1-flash", finish_reason: "stop", input_tokens: 12,
  output_tokens: 4, total_tokens: 16, duration_ms: 810,
};

 test("health probe produces authentic readiness from free catalog, real transport, strict JSON and finish reason", async () => {
  let catalogCalls = 0;
  let inferenceCalls = 0;
  const health = await produceProviderHealth({
    readCatalog: async () => { catalogCalls += 1; return freeCatalog; },
    runProbe: async () => { inferenceCalls += 1; return { stdout: '{"ok":true}', usage: validUsage }; },
    now: 1_000_000, probeId: "probe-valid",
  });
  assert.deepEqual([catalogCalls, inferenceCalls], [1, 1]);
  assert.equal(health.status, "healthy");
  assert.equal(health.transportOk, true);
  assert.equal(health.modelAvailable, true);
  assert.equal(health.freePrice, true);
  assert.equal(health.verified_free, true);
  assert.equal(health.structuredJsonOk, true);
  assert.equal(health.finishReasonVerified, true);
  assert.equal(health.finishReason, "stop");
  assert.equal(health.actual_model, "deepseek-v4.1-flash");
  assert.equal(health.requested_model, "deepseek-v4.1-flash:free");
  assert.equal(health.validUntil - health.checkedAt, HEALTH_TTL_MS);
  assert.equal(health.prompt, undefined);
  assert.equal(health.response, undefined);
  assert.equal(health.api_key, undefined);
  assert.equal(healthIsFresh(health, 1_000_001), true);
});

test("OpenRouter readiness requires catalog zero prices and exact response provenance", async () => {
  const route = OPENROUTER_FREE_ROUTE;
  const catalog = { data: [{ id: route.model, pricing: { prompt: "0", completion: "0" } }] };
  const usage = { ...validUsage, actual_provider: "OpenRouter", actual_model: route.model };
  const health = await produceProviderHealth({
    provider: route.provider, requestedModel: route.model, providerLabel: "OpenRouter",
    allowedActualModels: new Set([route.model]), readCatalog: async () => catalog,
    runProbe: async () => ({ stdout: '{"ok":true}', usage }),
    now: 1_000_000, probeId: "openrouter-health-probe",
  });
  assert.equal(health.status, "healthy");
  assert.equal(health.verified_free, true);
  assert.equal(health.provider, route.provider);
  assert.equal(health.requested_model, route.model);
  assert.equal(health.actual_provider, "OpenRouter");
  assert.equal(health.actual_model, route.model);

  let inferenceCalls = 0;
  const paid = await produceProviderHealth({
    provider: route.provider, requestedModel: route.model, providerLabel: "OpenRouter",
    readCatalog: async () => ({ data: [{ id: route.model, pricing: { prompt: "0", completion: "0.01" } }] }),
    runProbe: async () => { inferenceCalls += 1; }, now: 1_000_000,
  });
  assert.equal(paid.verified_free, false);
  assert.equal(paid.status, "not_free");
  assert.equal(inferenceCalls, 0);

  const request = createProviderHealthRequest("openrouter-health-envelope");
  const approvalRecord = createRemoteApprovalRecord({ request, effectivePayload: HEALTH_PROBE_PROMPT,
    provider: route.provider, model: route.model, source: "provider_health_probe",
    probeType: "provider_health", now: 1_000_000, expiresAt: 1_120_000,
    nonce: "openrouter-health-nonce-0001" });
  const prepared = preparePrivacyInvocation(buildCanaryArgs(route, HEALTH_PROBE_PROMPT), {
    request, approvalRecord, now: 1_000_001,
  });
  assert.equal(assertHealthProbeEnvelope({ request, payload: HEALTH_PROBE_PROMPT,
    args: prepared.args, provider: prepared.provider, model: prepared.model, route }), true);
});

test("OpenCode Zen free evidence binds authenticated catalog ID to official model, endpoint, and Free/Free price rows", () => {
  const catalog = { data: [{ id: OPENCODE_ZEN_HEALTH_REQUESTED_MODEL }] };
  const docs = `<table>
    <tr><td>Nemotron 3.5 Lightning Free</td><td>nemotron-3.5-lightning-free</td><td>https://opencode.ai/zen/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
    <tr><td>Nemotron 3.5 Lightning Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
  </table>`;
  const verified = verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: docs });
  assert.equal(verified.verifiedFree, true);
  assert.equal(verified.freeEvidenceSource, "authenticated_catalog+official_pricing_docs");
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog: { data: [{ id: "other-model" }] }, pricingHtml: docs }).reason,
    "model_missing");
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: docs.replace("/zen/v1/chat/completions", "/zen/v1/responses") }).reason,
    "official_model_mapping_unverified");
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: docs.replace("<td>Free</td><td>Free</td><td>Free</td>", "<td>$0.2</td><td>Free</td><td>Free</td>") }).verifiedFree,
    false);
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: docs.replace("<td>Free</td><td>Free</td><td>Free</td>", "<td>Free</td><td>$0.2</td><td>Free</td>") }).reason,
    "official_input_or_output_price_not_free");
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: "<main>table markup changed</main>" }).verifiedFree,
    false);
});

test("OpenCode free evidence remains auditable while provider health inference is quarantined", () => {
  const route = OPENCODE_ZEN_FREE_ROUTE;
  const catalog = { data: [{ id: route.model }] };
  const docs = `<tr><td>Nemotron 3.5 Lightning Free</td><td>${route.model}</td><td>https://opencode.ai/zen/v1/chat/completions</td></tr>
    <tr><td>Nemotron 3.5 Lightning Free</td><td>Free</td><td>Free</td><td>Free</td></tr>`;
  assert.equal(verifyOpenCodeZenFreeEvidence({ catalog, pricingHtml: docs }).verifiedFree, true);
  const request = createProviderHealthRequest("opencode-zen-health-envelope");
  const args = buildCanaryArgs(route, HEALTH_PROBE_PROMPT);
  assert.throws(() => assertHealthProbeEnvelope({ request, payload: HEALTH_PROBE_PROMPT,
    args, provider: route.provider, model: route.model }), /provider_health_probe_envelope_denied/);
});

test("OpenCode FreeTierError 403 is classified without preserving provider response content", () => {
  assert.equal(classifyProviderHealthFailure({ transportAttempted: true, remoteHttpStatus: 403,
    provider: "opencode-zen", model: OPENCODE_ZEN_HEALTH_REQUESTED_MODEL,
    safeErrorType: "FreeTierError" }), "provider_policy_restricted");
  assert.equal(classifyProviderHealthFailure({ transportAttempted: true, remoteHttpStatus: 403,
    provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    safeErrorType: "FreeTierError" }), "auth_denied");
  assert.equal(classifyProviderHealthFailure({ transportAttempted: null, remoteHttpStatus: 403,
    provider: "opencode-zen", model: OPENCODE_ZEN_HEALTH_REQUESTED_MODEL,
    safeErrorType: "FreeTierError" }), "provider_policy_restricted");
});

test("malformed JSON does not set structuredJsonOk", () => {
  assert.equal(validateHealthProbeEvidence({ stdout: "not json", usage: validUsage }).structuredJsonOk, false);
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true,"extra":1}', usage: validUsage }).structuredJsonOk, false);
});

test("missing or non-stop finish_reason is unverified", () => {
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, finish_reason: null } }).finishReasonVerified, false);
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, finish_reason: "length" } }).finishReasonVerified, false);
});

test("transport requires one completed Token Harbor response and the allowlisted actual model", () => {
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, remote_attempted: false } }).transportOk, false);
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, remote_attempt_status: "uncertain" } }).transportOk, false);
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, actual_provider: "Other" } }).transportOk, false);
  assert.equal(validateHealthProbeEvidence({ stdout: '{"ok":true}', usage: { ...validUsage, actual_model: "unexpected-model" } }).transportOk, false);
});

test("free catalog accepts documented per-million fields and exact zero strings or numbers", () => {
  const records = [
    { id: HEALTH_REQUESTED_MODEL, pricing: { price_in_per_1m: 0, price_out_per_1m: 0 } },
    { id: HEALTH_REQUESTED_MODEL, pricing: { price_in_per_1m: "0", price_out_per_1m: "0" } },
    { id: HEALTH_REQUESTED_MODEL, pricing: { prompt: "0", completion: "0" } },
    { id: HEALTH_REQUESTED_MODEL, pricing: { input_usd_per_1m: 0, output_usd_per_1m: 0 } },
    { id: HEALTH_REQUESTED_MODEL, pricing: { input_usd_per_1m: "0", output_usd_per_1m: "0" } },
    { id: HEALTH_REQUESTED_MODEL, price_in_per_1m: 0, price_out_per_1m: "0" },
  ];
  for (const model of records) assert.equal(verifyFreeCatalog({ data: [model] }).verifiedFree, true);
  assert.equal(verifyFreeCatalog({ models: [records[0]] }).verifiedFree, true);
});

test("free catalog fails closed for missing, null, malformed or nonzero prices", () => {
  assert.equal(verifyFreeCatalog({ data: [] }).reason, "model_missing");
  assert.equal(verifyFreeCatalog({ data: [{ id: "mimo-v2.6-flash", pricing: { price_in_per_1m: 0, price_out_per_1m: 0 } }] }).reason, "model_missing");
  for (const pricing of [
    {}, { price_in_per_1m: null, price_out_per_1m: 0 },
    { price_in_per_1m: 0, price_out_per_1m: null },
    { price_in_per_1m: "", price_out_per_1m: "0" },
    { price_in_per_1m: "free", price_out_per_1m: "0" },
    { price_in_per_1m: false, price_out_per_1m: "0" },
    { price_in_per_1m: "0", price_out_per_1m: "not-a-price" },
  ]) {
    assert.equal(verifyFreeCatalog({ data: [{ id: HEALTH_REQUESTED_MODEL, pricing }] }).reason, "catalog_price_unknown");
  }
  assert.equal(verifyFreeCatalog({ data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { price_in_per_1m: 0, price_out_per_1m: 0.01 } }] }).status, "not_free");
  assert.equal(verifyFreeCatalog({ data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { prompt: "0", completion: "0.01" } }] }).status, "not_free");
  assert.equal(verifyFreeCatalog({ data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { input_usd_per_1m: 0.01, output_usd_per_1m: 0 } }] }).status, "not_free");
  assert.equal(verifyFreeCatalog({ data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { input_usd_per_1m: null, output_usd_per_1m: 0 } }] }).status, "unknown");
});

test("conflicting catalog price aliases fail closed instead of accepting the first zero", () => {
  const conflict = { id: HEALTH_REQUESTED_MODEL, pricing: {
    input_usd_per_1m: 0, price_in_per_1m: 0.01,
    output_usd_per_1m: 0, price_out_per_1m: 0,
  } };
  assert.equal(verifyFreeCatalog({ data: [conflict] }).status, "not_free");
});

test("model missing, paid, or unknown pricing prevents inference", async () => {
  for (const catalog of [
    { data: [] },
    { data: [{ id: HEALTH_REQUESTED_MODEL, pricing: { prompt: "0", completion: "0.01" } }] },
    { data: [{ id: HEALTH_REQUESTED_MODEL, pricing: {} }] },
  ]) {
    let inferenceCalls = 0;
    const health = await produceProviderHealth({
      readCatalog: async () => catalog,
      runProbe: async () => { inferenceCalls += 1; return { stdout: '{"ok":true}', usage: validUsage }; },
      now: 1_000_000,
    });
    assert.equal(inferenceCalls, 0);
    assert.notEqual(health.status, "healthy");
    assert.equal(health.verified_free, false);
  }
});

test("catalog timeout, 5xx, and 429 do not retry and never call inference", async () => {
  for (const [status, code, expected] of [[0, "ETIMEDOUT", "timeout"], [503, "", "provider_5xx"], [429, "", "rate_limited"]]) {
    let catalogCalls = 0;
    let inferenceCalls = 0;
    const health = await produceProviderHealth({
      readCatalog: async () => { catalogCalls += 1; throw Object.assign(new Error("synthetic"), { status, code }); },
      runProbe: async () => { inferenceCalls += 1; },
      now: 1_000_000,
    });
    assert.equal(catalogCalls, 1);
    assert.equal(inferenceCalls, 0);
    assert.equal(health.reason, expected);
    assert.equal(health.nextProbeAt, 1_000_000 + HEALTH_RETRY_COOLDOWN_MS);
  }
});

test("provider probe timeout, 5xx, 429 and 402 make one inference attempt and set cooldown", async () => {
  for (const [status, code, expected] of [[0, "ETIMEDOUT", "timeout"], [503, "", "provider_5xx"], [429, "", "rate_limited"], [402, "", "payment_required"]]) {
    let inferenceCalls = 0;
    const health = await produceProviderHealth({
      readCatalog: async () => freeCatalog,
      runProbe: async () => { inferenceCalls += 1; throw Object.assign(new Error("synthetic"), { status, code }); },
      now: 2_000_000,
    });
    assert.equal(inferenceCalls, 1);
    assert.notEqual(health.status, "healthy");
    assert.equal(health.transportOk, false);
    assert.ok(health.nextProbeAt > 2_000_000);
  }
});

test("pre-transport diagnostic stores only a safe failure category", () => {
  assert.equal(classifyPreTransportFailure({ usage: { failure: "local_argument_validation" } }), "local_argument_validation");
  assert.equal(classifyPreTransportFailure({ usage: { failure_type: "RuntimeError" } }), "python_runtime_error");
  assert.equal(classifyPreTransportFailure({ usage: { failure: "remote provider credential is unavailable", failure_type: "RuntimeError" } }), "credential_unavailable");
  assert.equal(classifyPreTransportFailure({ usage: { failure_type: "ModuleNotFoundError" } }), "python_dependency_error");
  assert.equal(classifyPreTransportFailure({ usage: { failure_type: "CustomLocalFailure" } }), "python_exception_other");
  assert.equal(classifyPreTransportFailure({ usage: { failure_type: "RuntimeError\nAPI_KEY=secret" } }), "unclassified_pre_transport_cli_failure");
  const rawTurnExit = "local_processing_error(secret prompt and credential)";
  const turnCategory = classifyPreTransportFailure({ usage: { turn_exit_reason: rawTurnExit }, errorCode: 1 });
  assert.equal(turnCategory, "cli_turn_local_processing_error");
  assert.equal(JSON.stringify({ turnCategory }).includes("secret"), false);
  const nestedCause = classifyPreTransportFailure({
    usage: { turn_exit_reason: "local_processing_error(remote provider credential is unavailable; secret=sk-test)" },
  });
  assert.equal(nestedCause, "credential_unavailable");
  assert.equal(JSON.stringify({ nestedCause }).includes("sk-test"), false);
  assert.equal(classifyPreTransportFailure({ usage: { completed: true }, errorCode: 1 }), "cli_empty_response");
  assert.equal(classifyPreTransportFailure({ usage: { failed: true }, errorCode: 2 }), "cli_turn_failed");
  assert.equal(classifyPreTransportFailure({ usage: { failed: true, partial: true }, errorCode: 2 }), "cli_turn_failed_partial");
  assert.equal(classifyPreTransportFailure({ usage: { partial: true }, errorCode: 2 }), "cli_turn_partial");
  assert.equal(classifyPreTransportFailure({ usage: { completed: false }, errorCode: 2 }), "cli_turn_not_completed");
  assert.equal(classifyPreTransportFailure({ usage: { interrupted: true, completed: false }, errorCode: 2 }), "cli_turn_interrupted");
  assert.equal(classifyPreTransportFailure({ usage: { failure_reason: "server_error", failed: true }, errorCode: 2 }), "cli_result_failure_server_error");
  assert.equal(classifyPreTransportFailure({ usage: { failure_reason: "unknown", api_calls: 0, failed: true } }), "cli_result_failure_unknown_no_api_calls");
  assert.equal(classifyPreTransportFailure({ usage: { failure_reason: "unknown", api_calls: 2, failed: true } }), "cli_result_failure_unknown_with_api_calls");
  const untrustedReason = classifyPreTransportFailure({ usage: { failure_reason: "private prompt secret", failed: true }, errorCode: 2 });
  assert.equal(untrustedReason, "cli_turn_failed");
  assert.equal(JSON.stringify({ untrustedReason }).includes("secret"), false);
  const interruptedDetail = classifyPreTransportFailure({ usage: { turn_exit_reason: "interrupted_by_system(secret details)" } });
  assert.equal(interruptedDetail, "cli_turn_interrupted");
  assert.equal(JSON.stringify({ interruptedDetail }).includes("secret"), false);
  assert.equal(classifyPreTransportFailure({ usage: { turn_exit_reason: "budget_exhausted" } }), "cli_turn_budget_exhausted");
  assert.equal(classifyPreTransportFailure({ usage: { turn_exit_reason: "max_iterations_reached(4/4)" } }), "cli_turn_max_iterations");
  assert.equal(classifyPreTransportFailure({ stderr: "hermes -z: agent failed: remote provider credential is unavailable" }), "credential_unavailable");
  assert.equal(classifyPreTransportFailure({ stderr: "privacy transport configuration is unavailable or invalid" }), "privacy_profile_configuration");
  const raw = "prompt=private text OPENROUTER_API_KEY=sk-test-secret";
  const category = classifyPreTransportFailure({ usage: { failure: raw }, stderr: raw, errorCode: 1 });
  assert.equal(category, "cli_nonzero_exit");
  assert.equal(JSON.stringify({ category }).includes("sk-test-secret"), false);
  assert.equal(classifyPreTransportFailure({}), "unclassified_pre_transport_cli_failure");
});

test("probe failure classification uses structured transport evidence and ignores pre-transport HTTP text", async () => {
  const catalog = { data: [{ id: OPENROUTER_FREE_ROUTE.model,
    pricing: { prompt: "0", completion: "0" } }] };
  const run = (evidence) => produceProviderHealth({
    provider: OPENROUTER_FREE_ROUTE.provider, requestedModel: OPENROUTER_FREE_ROUTE.model,
    readCatalog: async () => catalog,
    runProbe: async () => { throw Object.assign(new Error("HTTP 503 in local stderr"), evidence); },
    now: 3_000_000,
  });
  const preTransport = await run({ transportAttempted: false, remoteHttpStatus: 503,
    remoteAttemptStatus: "not_attempted" });
  assert.equal(preTransport.reason, "pre_transport_error");
  assert.equal(preTransport.transportAttempted, false);
  assert.equal(preTransport.lastVerifiedHttpStatus, null);
  assert.equal(preTransport.remoteAttemptStatus, "not_attempted");

  const diagnostic = await produceProviderHealth({
    provider: OPENROUTER_FREE_ROUTE.provider, requestedModel: OPENROUTER_FREE_ROUTE.model,
    readCatalog: async () => catalog,
    runProbe: async () => { throw Object.assign(new Error("raw secret must not escape"), {
      transportAttempted: false, remoteAttemptStatus: "not_attempted",
      localFailureCategory: "credential_unavailable", stderr: "sk-test-secret",
    }); },
    now: 3_000_001,
  });
  assert.equal(diagnostic.preTransportFailureCategory, "credential_unavailable");
  assert.equal(JSON.stringify(diagnostic).includes("sk-test-secret"), false);

  const confirmedHttp = await run({ transportAttempted: true, remoteHttpStatus: 503,
    remoteAttemptStatus: "failed" });
  assert.equal(confirmedHttp.reason, "provider_503");
  assert.equal(confirmedHttp.transportAttempted, true);
  assert.equal(confirmedHttp.lastVerifiedHttpStatus, 503);
  assert.equal(confirmedHttp.remoteAttemptStatus, "failed");

  const unknown = await run({ transportAttempted: true, remoteAttemptStatus: "uncertain" });
  assert.equal(unknown.reason, "transport_outcome_unknown");
  assert.equal(unknown.lastVerifiedHttpStatus, null);
});

test("stale health can be refreshed; fresh health and cooldown suppress probes", async () => {
  assert.equal(HEALTH_TTL_MS, 45 * 60 * 1000);
  assert.equal(HEALTH_RETRY_COOLDOWN_MS, 30 * 60 * 1000);
  const fresh = { status: "healthy", modelAvailable: true, freePrice: true, verified_free: true,
    syntheticInferenceOk: true, transportOk: true, structuredJsonOk: true, finishReasonVerified: true,
    toolCompatibility: "not_required_safe_mode", checkedAt: 1_000_000, validUntil: 1_000_000 + HEALTH_TTL_MS };
  assert.equal(healthIsFresh(fresh, 1_000_001), true);
  assert.equal(healthIsFresh(fresh, fresh.validUntil), false);
  assert.equal(shouldRunProviderHealthProbe({ health: fresh }, 1_000_001), false);
  assert.equal(shouldRunProviderHealthProbe({ health: { ...fresh, validUntil: 999_999 } }, 1_000_001), true);
  assert.equal(shouldRunProviderHealthProbe({ health: { status: "degraded", nextProbeAt: 1_200_000 } }, 1_100_000), false);
});

test("health probe is explicitly synthetic, tool-free, memory-free, skills-free, MCP-free and history-free", () => {
  const request = createProviderHealthRequest("health-probe-test");
  const approvalRecord = createRemoteApprovalRecord({ request, effectivePayload: HEALTH_PROBE_PROMPT,
    provider: MIMO26_ROUTE.provider, model: MIMO26_ROUTE.model, source: "provider_health_probe",
    probeType: "provider_health", now: 1_000_000, expiresAt: 1_120_000,
    nonce: "phase27-health-nonce-0001" });
  const prepared = preparePrivacyInvocation(buildCanaryArgs(MIMO26_ROUTE, HEALTH_PROBE_PROMPT), {
    request, approvalRecord, now: 1_000_001,
  });
  assert.equal(prepared.finalGateBlocked, false);
  assert.equal(assertHealthProbeEnvelope({ request, payload: HEALTH_PROBE_PROMPT,
    args: prepared.args, provider: prepared.provider, model: prepared.model }), true);
  for (const flag of ["-t", "--toolsets", "--resume", "--skills", "--memory", "--mcp", "--mcp-config", "--plugins", "--context", "--history"]) {
    assert.throws(() => assertHealthProbeEnvelope({ request, payload: HEALTH_PROBE_PROMPT,
      args: [...prepared.args, flag], provider: prepared.provider, model: prepared.model }), /provider_health_probe_envelope_denied/);
  }
  assert.throws(() => assertHealthProbeEnvelope({ request, payload: "changed", args: prepared.args,
    provider: prepared.provider, model: prepared.model }), /provider_health_probe_envelope_denied/);
  assert.throws(() => assertHealthProbeEnvelope({ request: { ...request, prompt: "user content" },
    payload: HEALTH_PROBE_PROMPT, args: prepared.args, provider: prepared.provider, model: prepared.model }), /provider_health_probe_envelope_denied/);
});


test("Groq Free eligibility needs current operator FREE evidence, exact catalog model and official free limits", () => {
  const catalog = { data: [{ id: GROQ_HEALTH_REQUESTED_MODEL }] };
  const operatorEvidence = { accountTier: GROQ_ACCOUNT_TIER,
    operatorEvidenceSource: GROQ_OPERATOR_EVIDENCE_SOURCE, rateLimits: GROQ_FREE_PLAN_RATE_LIMITS };
  const verified = verifyGroqFreeEvidence({ catalog, ...operatorEvidence });
  assert.equal(verified.modelAvailable, true);
  assert.equal(verified.verifiedFree, true);
  assert.equal(verified.status, "catalog_verified_free");
  assert.equal(verified.accountTier, "FREE");
  assert.equal(verified.freeEvidenceSource, GROQ_FREE_EVIDENCE_SOURCE);
  assert.equal(GROQ_OPERATOR_EVIDENCE_SOURCE, "operator_verified_console_free_plan_2026-10-06");
  assert.deepEqual(GROQ_FREE_PLAN_RATE_LIMITS, { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 });
  for (const changed of [
    { accountTier: "UNKNOWN" }, { accountTier: "DEVELOPER" },
    { operatorEvidenceSource: "authenticated_catalog" },
    { rateLimits: { ...GROQ_FREE_PLAN_RATE_LIMITS, tpm: 8001 } },
    { rateLimits: { ...GROQ_FREE_PLAN_RATE_LIMITS, paid_burst: true } },
    { modelId: "openai/gpt-oss-20b" },
  ]) {
    const result = verifyGroqFreeEvidence({ catalog, ...operatorEvidence, ...changed });
    assert.equal(result.verifiedFree, false);
  }
  assert.equal(verifyGroqFreeEvidence({ catalog: { data: [] }, ...operatorEvidence }).verifiedFree, false);
  assert.equal(verifyGroqFreeEvidence({ catalog }).verifiedFree, false);
});

test("Groq readiness uses the verified Free plan evidence and exact real inference provenance", async () => {
  const route = GROQ_FREE_ROUTE;
  const catalog = { data: [{ id: route.model }] };
  const usage = { ...validUsage, actual_provider: "Groq", actual_model: route.model };
  const verifyCatalogEvidence = ({ catalog: input, modelId }) => verifyGroqFreeEvidence({
    catalog: input, modelId, accountTier: GROQ_ACCOUNT_TIER,
    operatorEvidenceSource: GROQ_OPERATOR_EVIDENCE_SOURCE, rateLimits: GROQ_FREE_PLAN_RATE_LIMITS,
  });
  const healthy = await produceProviderHealth({
    provider: route.provider, requestedModel: route.model, providerLabel: "Groq",
    allowedActualModels: new Set([route.model]), readCatalog: async () => catalog,
    verifyCatalogEvidence, runProbe: async () => ({ stdout: '{"ok":true}', usage }),
    now: 1_000_000, probeId: "groq-health-probe",
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.verified_free, true);
  assert.equal(healthy.accountTier, GROQ_ACCOUNT_TIER);
  assert.equal(healthy.freeEvidenceSource, GROQ_FREE_EVIDENCE_SOURCE);
  assert.equal(healthy.actual_provider, "Groq");
  assert.equal(healthy.actual_model, GROQ_HEALTH_REQUESTED_MODEL);
  assert.equal(healthy.transportOk, true);

  let inferenceCalls = 0;
  const unverified = await produceProviderHealth({
    provider: route.provider, requestedModel: route.model,
    readCatalog: async () => catalog,
    verifyCatalogEvidence: ({ catalog: input, modelId }) => verifyGroqFreeEvidence({
      catalog: input, modelId, accountTier: "UNKNOWN",
    }),
    runProbe: async () => { inferenceCalls += 1; return { stdout: '{"ok":true}', usage }; },
    now: 1_000_001,
  });
  assert.equal(inferenceCalls, 0);
  assert.equal(unverified.verified_free, false);
});

test("Groq probe failures retain safe provider-specific readiness classes", async () => {
  const route = GROQ_FREE_ROUTE;
  const catalog = { data: [{ id: route.model }] };
  const verifyCatalogEvidence = ({ catalog: input, modelId }) => verifyGroqFreeEvidence({
    catalog: input, modelId, accountTier: GROQ_ACCOUNT_TIER,
    operatorEvidenceSource: GROQ_OPERATOR_EVIDENCE_SOURCE, rateLimits: GROQ_FREE_PLAN_RATE_LIMITS,
  });
  for (const [status, expected] of [[429, "rate_limited"], [401, "auth_failure"],
    [403, "auth_or_provider_policy"], [503, "provider_error"]]) {
    const health = await produceProviderHealth({
      provider: route.provider, requestedModel: route.model,
      readCatalog: async () => catalog, verifyCatalogEvidence,
      runProbe: async () => { throw Object.assign(new Error("safe synthetic failure"), {
        transportAttempted: true, remoteHttpStatus: status, remoteAttemptStatus: "failed",
        provider: route.provider, model: route.model,
      }); },
      now: 1_000_000,
    });
    assert.equal(health.status, expected);
    assert.equal(health.reason, expected);
    assert.equal(health.classification, expected);
    assert.equal(health.lastVerifiedHttpStatus, status);
    assert.equal(health.verified_free, true);
  }
  assert.equal(classifyProviderHealthFailure({ transportAttempted: false,
    provider: route.provider, model: route.model }), "pre_transport_error");
  assert.equal(classifyProviderHealthFailure({ transportAttempted: true,
    provider: route.provider, model: route.model }), "transport_outcome_unknown");
});

test("Groq is not a Bridge inference route even when a legacy health probe is constructed", () => {
  const route = GROQ_FREE_ROUTE;
  const request = createProviderHealthRequest("groq-health-envelope");
  const approvalRecord = createRemoteApprovalRecord({ request, effectivePayload: HEALTH_PROBE_PROMPT,
    provider: route.provider, model: route.model, source: "provider_health_probe",
    probeType: "provider_health", now: 1_000_000, expiresAt: 1_120_000,
    nonce: "phase222b5b-groq-health-nonce-0001" });
  const prepared = preparePrivacyInvocation(buildCanaryArgs(route, HEALTH_PROBE_PROMPT), {
    request, approvalRecord, now: 1_000_001,
  });
  assert.equal(prepared.finalGateBlocked, true);
  assert.notEqual(prepared.provider, route.provider);
  assert.throws(() => assertHealthProbeEnvelope({ request, payload: HEALTH_PROBE_PROMPT,
    args: prepared.args, provider: route.provider, model: route.model }), /provider_health_probe_envelope_denied/);
});
