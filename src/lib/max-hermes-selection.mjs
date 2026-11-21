const MODEL_ID = /^[^\s\u0000-\u001f\u007f]{1,160}$/;

export function extractExcelntModels(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.providers)) {
    throw new Error("hermes_model_options_invalid");
  }
  const provider = payload.providers.find((entry) => entry && typeof entry === "object"
    && entry.slug === "excelnt" && String(entry.name || "").toUpperCase() === "EXCELNT");
  if (!provider || provider.authenticated !== true || !Array.isArray(provider.models)) {
    throw new Error("hermes_excelnt_catalog_unavailable");
  }
  const models = [...new Set(provider.models.filter((id) => typeof id === "string"
    && MODEL_ID.test(id)))];
  if (!models.length) throw new Error("hermes_excelnt_catalog_empty");
  return models;
}

export function validateMaxModelSelection(provider, model, catalog) {
  if (provider == null && model == null) return { ok: true, selection: null };
  if (provider !== "excelnt") return { ok: false, error: "provider_not_supported" };
  if (typeof model !== "string" || !MODEL_ID.test(model)) {
    return { ok: false, error: "model_invalid" };
  }
  if (!Array.isArray(catalog) || !catalog.includes(model)) {
    return { ok: false, error: "model_not_in_authenticated_catalog" };
  }
  return { ok: true, selection: { provider: "excelnt", model, profile: "max-hq", mode: "text_only" } };
}
