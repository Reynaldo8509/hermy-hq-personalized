export function classifyInferenceRecord(record = {}) {
  const provider = String(record.provider || "").trim().toLowerCase();
  const model = String(record.model || "").trim().toLowerCase();
  const actualProvider = String(record.actual_provider || "").trim().toLowerCase();
  const actualModel = String(record.actual_model || "").trim().toLowerCase();

  // Historical rows written by generic CLI/tool operations are retained for review,
  // but default/default does not prove that an inference reached a model.
  if (provider === "default" && model === "default") return "legacy_unclassified";
  if (actualProvider === "not_invoked" || actualModel === "not_invoked") return "route_not_invoked";
  return "model_inference";
}

export function sumKnownUsage(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined
    && Number.isFinite(Number(value)));
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) : null;
}


export function classifyProviderRoute(record = {}) {
  const provider = String(record.actual_provider || record.provider || "").trim().toLowerCase();
  const model = String(record.actual_model || record.model || "").trim().toLowerCase();
  const routeTier = String(record.route_tier || "").trim().toLowerCase();
  const costStatus = String(record.cost_status || "").trim().toLowerCase();
  const cost = Number(record.reported_cost);

  if (model === "qwen3-8b-local" && ["qwen-local-tailscale", "qwen local", "qwen-local"].includes(provider)
      && (record.remote_attempted === false || routeTier.startsWith("local"))) return "local";
  if (record.free_route === true && record.route_cost_policy === "catalog_verified_free") return "verified_free";
  if (costStatus === "paid" || (costStatus === "actual" && Number.isFinite(cost) && cost > 0)) return "commercial_verified";
  return "remote_cost_unverified";
}
