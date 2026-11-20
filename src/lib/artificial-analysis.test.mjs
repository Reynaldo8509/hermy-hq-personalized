import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAACatalog, normalizeAAModel } from "./artificial-analysis.mjs";

test("normalizes published AA metrics and retains source nulls", () => {
  const model = normalizeAAModel({
    id: "model-1", slug: "example", name: "Example Model", model_creator: { name: "Example Lab" },
    evaluations: { artificial_analysis_intelligence_index: 42.5, artificial_analysis_coding_index: null },
    pricing: { price_1m_input_tokens: 1.25 },
    performance: { median_output_tokens_per_second: 80.2 },
  });
  assert.equal(model?.creator, "Example Lab");
  assert.equal(model?.intelligenceIndex, 42.5);
  assert.equal(model?.codingIndex, null);
  assert.equal(model?.inputUsdPerMillion, 1.25);
  assert.equal(model?.outputUsdPerMillion, null);
  assert.equal(model?.medianOutputTokensPerSecond, 80.2);
});

test("rejects incomplete model rows and normalizes tier and pagination", () => {
  assert.equal(normalizeAAModel({ name: "missing id" }), null);
  const catalog = normalizeAACatalog({
    tier: "free", intelligence_index_version: 4.3,
    pagination: { page: 1, page_size: 200, total_pages: 2, has_more: true },
    data: [{ id: "m1", slug: "m1", name: "Model 1" }, { id: "invalid" }],
  }, "2026-09-29T00:00:00.000Z");
  assert.equal(catalog.tier, "free");
  assert.equal(catalog.intelligenceIndexVersion, 4.3);
  assert.equal(catalog.pagination.hasMore, true);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.observedAt, "2026-09-29T00:00:00.000Z");
});
