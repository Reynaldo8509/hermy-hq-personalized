export const QWEN_UNAVAILABLE_TEST_MARKER = "[[INFERENCE_TEST_FAIL_QWEN_UNAVAILABLE]]";
export const QWEN_UNKNOWN_TEST_MARKER = "[[INFERENCE_TEST_QWEN_UNKNOWN]]";
export const QWEN_RECOVERY_TEST_MARKER = "[[INFERENCE_TEST_QWEN_RECOVERY]]";
export const MIMO_ROUTER_E2E_TEST_MARKER = "[[MIMO_ROUTER_E2E_ONCE]]";
export const MIMO_ROUTER_503_TEST_MARKER = "[[MIMO_ROUTER_503_ONCE]]";
export const REMOTE_FREE_FAILOVER_QWEN_UNAVAILABLE_MARKER = "[[INFERENCE_TEST_REMOTE_FREE_FAILOVER_QWEN_UNAVAILABLE]]";
const MIMO_ROUTER_E2E_TEST_KINDS = new Set(["max.chief-of-staff", "max.deep-analysis", "atlas.research"]);
const QWEN_ROUTER_TEST_KINDS = new Set(["max.chief-of-staff"]);
const QWEN_ROUTER_TEST_MODES = new Set([
  "qwen_unknown", "qwen_unavailable", "qwen_recovery",
  "remote_free_qwen_unknown", "remote_free_qwen_unavailable", "remote_free_failover_qwen_unavailable",
  "prefer_local_failover_qwen_unavailable",
]);
const MIMO_ROUTER_E2E_TEST_MODES = Object.freeze({
  mimo_e2e_once: MIMO_ROUTER_E2E_TEST_MARKER,
  mimo_503_once: MIMO_ROUTER_503_TEST_MARKER,
  mimo_e2e_qwen_unavailable: `${MIMO_ROUTER_E2E_TEST_MARKER}\n\n${QWEN_UNAVAILABLE_TEST_MARKER}`,
  qwen_unavailable: QWEN_UNAVAILABLE_TEST_MARKER,
  qwen_unknown: QWEN_UNKNOWN_TEST_MARKER,
  qwen_recovery: QWEN_RECOVERY_TEST_MARKER,
  remote_free_qwen_unknown: "[[INFERENCE_TEST_REMOTE_FREE_QWEN_UNKNOWN]]",
  remote_free_qwen_unavailable: "[[INFERENCE_TEST_REMOTE_FREE_QWEN_UNAVAILABLE]]",
  remote_free_failover_qwen_unavailable: `${REMOTE_FREE_FAILOVER_QWEN_UNAVAILABLE_MARKER}\n\n[[REMOTE_FREE_PRIMARY_PRETRANSPORT_ONCE]]`,
  prefer_local_failover_qwen_unavailable: "[[INFERENCE_TEST_PREFER_LOCAL_FAILOVER_QWEN_UNAVAILABLE]]\n\n[[PREFER_LOCAL_PRIMARY_PRETRANSPORT_ONCE]]",
});

const READ_ONLY_TEST_ACTIONS = Object.freeze({
  "max.chief-of-staff": "coordinate",
  "atlas.research": "research",
  "ledger.operations": "audit",
  "milo.email": "triage",
  "pulse.social": "strategy",
  "domus.home": "review",
});

export function inferenceTestOverrideAllowed({ actor, kind, sideEffecting, action, capability }) {
  return actor === "max" && sideEffecting === false && capability === "read_only" && READ_ONLY_TEST_ACTIONS[kind] === action;
}

export function inferenceTestOverrideKindAllowed(actor, override, kind) {
  if (QWEN_ROUTER_TEST_MODES.has(override)) {
    return actor === "max" && QWEN_ROUTER_TEST_KINDS.has(kind);
  }
  if (override === "qwen_unavailable") return actor === "max" && QWEN_ROUTER_TEST_KINDS.has(kind);
  return Object.hasOwn(MIMO_ROUTER_E2E_TEST_MODES, override)
    && actor === "max" && MIMO_ROUTER_E2E_TEST_KINDS.has(kind);
}

export function routerE2ETestMode(request = {}) {
  const kind = String(request.kind || "");
  const expectedAction = kind === "atlas.research" ? "research" : "coordinate";
  const prompt = String(request.prompt || "");
  if (request.origin !== "test"
      || !MIMO_ROUTER_E2E_TEST_KINDS.has(kind)
      || request.sideEffecting !== false
      || request.capability !== "read_only"
      || request.action !== expectedAction) return null;
  for (const [mode, marker] of Object.entries(MIMO_ROUTER_E2E_TEST_MODES)) {
    if (!prompt.endsWith("\n\n" + marker)) continue;
    if (QWEN_ROUTER_TEST_MODES.has(mode) && !QWEN_ROUTER_TEST_KINDS.has(kind)) return null;
    return mode;
  }
  return null;
}

export function isRouterE2ETestRequest(request = {}) {
  return routerE2ETestMode(request) !== null;
}

export function stripRouterE2ETestMarker(prompt) {
  const text = String(prompt || "");
  for (const marker of Object.values(MIMO_ROUTER_E2E_TEST_MODES)) {
    const suffix = "\n\n" + marker;
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  if (text.endsWith("\n\n" + QWEN_UNAVAILABLE_TEST_MARKER)) {
    return text.slice(0, -("\n\n" + QWEN_UNAVAILABLE_TEST_MARKER).length);
  }
  return text;
}

export function applyInferenceTestOverride(actor, override, prompt, kind = "") {
  if (override === undefined || override === null || override === "") return { origin: "web", prompt: String(prompt || "") };
  if (!inferenceTestOverrideKindAllowed(actor, override, kind)) return null;
  const marker = MIMO_ROUTER_E2E_TEST_MODES[override];
  return { origin: "test", prompt: String(prompt || "") + "\n\n" + marker };
}
