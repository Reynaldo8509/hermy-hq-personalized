function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteOrNull(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

export function normalizeAAModel(value) {
  const source = object(value);
  const creator = object(source.model_creator);
  const evaluations = object(source.evaluations);
  const pricing = object(source.pricing);
  const performance = object(source.performance);
  if (typeof source.id !== "string" || typeof source.slug !== "string" || typeof source.name !== "string") return null;
  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    creator: typeof creator.name === "string" ? creator.name : "Unknown",
    releaseDate: typeof source.release_date === "string" ? source.release_date : null,
    intelligenceIndex: finiteOrNull(evaluations.artificial_analysis_intelligence_index),
    codingIndex: finiteOrNull(evaluations.artificial_analysis_coding_index),
    agenticIndex: finiteOrNull(evaluations.artificial_analysis_agentic_index),
    inputUsdPerMillion: finiteOrNull(pricing.price_1m_input_tokens),
    outputUsdPerMillion: finiteOrNull(pricing.price_1m_output_tokens),
    medianOutputTokensPerSecond: finiteOrNull(performance.median_output_tokens_per_second),
    medianTimeToFirstTokenSeconds: finiteOrNull(performance.median_time_to_first_token_seconds),
  };
}

export function normalizeAACatalog(payload, observedAt = new Date().toISOString()) {
  const source = object(payload);
  const pagination = object(source.pagination);
  const models = Array.isArray(source.data) ? source.data.map(normalizeAAModel).filter(Boolean) : [];
  return {
    source: "Artificial Analysis",
    tier: typeof source.tier === "string" ? source.tier : "unknown",
    intelligenceIndexVersion: finiteOrNull(source.intelligence_index_version),
    observedAt,
    pagination: {
      page: finiteOrNull(pagination.page),
      pageSize: finiteOrNull(pagination.page_size),
      totalPages: finiteOrNull(pagination.total_pages),
      hasMore: pagination.has_more === true,
    },
    models,
  };
}
