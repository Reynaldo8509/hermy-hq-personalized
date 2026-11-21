import { PERSISTED_INFERENCE_COST_STATUSES } from "./inference-cost-status.mjs";

export { PERSISTED_INFERENCE_COST_STATUSES };

const deepseek = Object.freeze({
  id: "tokenharbor-deepseek-free",
  requestedProvider: "custom:tokenharbor",
  model: "deepseek-v4.1-flash:free",
  gateway: "tokenharbor",
  actualProvider: "Token Harbor",
  costStatus: "verified_free",
  reportedCost: 0,
  routeCostPolicy: "verified_free_allowlist",
});
const cohere = Object.freeze({
  id: "openrouter-cohere-north-mini-free",
  requestedProvider: "openrouter",
  model: "cohere/north-mini-code:free",
  gateway: "openrouter",
  actualProvider: "Cohere",
  costStatus: "verified_free",
  reportedCost: 0,
  routeCostPolicy: "verified_free_allowlist",
});
const deterministic = (id) => Object.freeze({
  id: `local-deterministic-${id}`,
  requestedProvider: "local-deterministic",
  model: id,
  gateway: "bridge-local-function",
  actualProvider: "local",
  costStatus: "unknown",
  reportedCost: null,
  routeCostPolicy: "local_no_billing",
});
const codexWorker = Object.freeze({
  id: "codex-worker",
  requestedProvider: "openai-codex-worker",
  model: "dedicated-codex-worker",
  gateway: "codex-hermy-vps.service",
  routeCostPolicy: "subscription_only_no_payg",
});

export const REMOTE_FREE_ROUTES = Object.freeze({ deepseek, cohere });
export const LOCAL_FREE_ROUTES = Object.freeze({
  max: deterministic("max-no-local-llm"),
  atlas: deterministic("atlas-no-local-llm"),
  aegis: deterministic("aegis-passive-readonly"),
  milo: deterministic("milo-subject-triage"),
  ledger: deterministic("ledger-backup-readonly"),
  domus: deterministic("domus-readonly"),
  pulse: deterministic("pulse-no-local-llm"),
});

const remotePool = Object.freeze([deepseek, cohere]);
const none = Object.freeze([]);
/** @typedef {{ id: string, model: string, gateway: string, requestedProvider?: string, provider?: string, actualProvider?: string, costStatus?: string, reportedCost?: number | null, routeCostPolicy?: string }} AgentRoute */
/** @typedef {{ freeOnly?: boolean, explicitRemoteConsent?: boolean, localOptional?: boolean, requiresAtlasCapability?: boolean, remoteClass?: string, emailPrivacy?: string, scheduledProvenanceRequired?: boolean, homeAssistantPrivacy?: string }} AgentAffinityOptions */
/** @param {AgentRoute} primary @param {readonly AgentRoute[]} fallbacks @param {readonly string[]} requiredCapabilities @param {AgentAffinityOptions} [extra] */
const affinity = (primary, fallbacks, requiredCapabilities, extra = {}) => Object.freeze({
  primary, fallbacks: Object.freeze([...fallbacks]), requiredCapabilities: Object.freeze(requiredCapabilities), ...extra,
});

export const MODEL_AFFINITY = Object.freeze({
  hermes_normal: affinity(deepseek, [cohere], ["fast", "chat"], { freeOnly: true, explicitRemoteConsent: true }),
  hermes_reasoning: affinity(deepseek, [cohere], ["reasoning", "tools"], { freeOnly: true, explicitRemoteConsent: true }),
  max: affinity(deepseek, [cohere], ["reasoning", "structured", "delegation"], { freeOnly: true, explicitRemoteConsent: true }),
  codex: affinity(codexWorker, none, ["read_only", "engineering"], { freeOnly: false, localOptional: false }),
  atlas: affinity(deepseek, [cohere], ["research", "reasoning", "structured"], { freeOnly: true, requiresAtlasCapability: true }),
  aegis: affinity(LOCAL_FREE_ROUTES.aegis, none, ["passive_read_only", "confirmation_required"], { freeOnly: true, remoteClass: "synthetic_only" }),
  milo: affinity(LOCAL_FREE_ROUTES.milo, none, ["local_deterministic", "read_only"], { freeOnly: true, emailPrivacy: "LOCAL_ONLY" }),
  ledger: affinity(LOCAL_FREE_ROUTES.ledger, none, ["local_deterministic", "backup_read_only"], { freeOnly: true, scheduledProvenanceRequired: true }),
  domus: affinity(LOCAL_FREE_ROUTES.domus, none, ["local_deterministic", "ha_read_only"], { freeOnly: true, homeAssistantPrivacy: "LOCAL_ONLY" }),
  pulse: affinity(LOCAL_FREE_ROUTES.pulse, none, ["local_unavailable"], { freeOnly: true }),
});

const REQUEST_AGENT = Object.freeze({
  "max.chief-of-staff": "max", "max.deep-analysis": "max",
  "atlas.research": "atlas", "aegis.security": "aegis", "milo.email": "milo",
  "pulse.social": "pulse", "ledger.operations": "ledger", "domus.home": "domus",
  "codex.audit": "codex", "codex.change": "codex", "codex.engineering": "codex",
  oneshot: "hermes_normal", chat: "hermes_normal",
});

export function modelPolicyForAgent(agentId) {
  return MODEL_AFFINITY[agentId] || MODEL_AFFINITY.hermes_normal;
}

export function modelPolicyForRequest(kind) {
  return modelPolicyForAgent(REQUEST_AGENT[kind] || "hermes_normal");
}

export function primaryRouteForRequest(kind) {
  return modelPolicyForRequest(kind).primary;
}

export function fallbackRoutesForRequest(kind) {
  return [...modelPolicyForRequest(kind).fallbacks];
}

export function routeCostPolicy(requestedProvider, requestedModel) {
  const provider = String(requestedProvider || "");
  const model = String(requestedModel || "");
  if (Object.values(LOCAL_FREE_ROUTES).some((route) => route.requestedProvider === provider && route.model === model)) return "local_no_billing";
  if (Object.values(REMOTE_FREE_ROUTES).some((route) => route.requestedProvider === provider && route.model === model)) return "verified_free_allowlist";
  return "not_allowlisted_fail_closed";
}

export function findValidatedFreeRoute(requestedProvider, requestedModel, actualProvider, actualModel) {
  return remotePool.find((route) => route.requestedProvider === requestedProvider
    && route.model === requestedModel && route.actualProvider === actualProvider
    && route.model === actualModel) || null;
}

export function findValidatedLocalRoute(requestedProvider, requestedModel, actualProvider, actualModel) {
  return Object.values(LOCAL_FREE_ROUTES).find((route) => route.requestedProvider === requestedProvider
    && route.model === requestedModel && route.actualProvider === actualProvider
    && route.model === actualModel) || null;
}
