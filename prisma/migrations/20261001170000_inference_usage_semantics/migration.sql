-- Additive usage details from the Hermes one-shot usage contract.
ALTER TABLE "InferenceAttempt"
  ADD COLUMN "route_cost_policy" TEXT,
  ADD COLUMN "uncached_prompt_tokens" BIGINT,
  ADD COLUMN "reasoning_tokens" BIGINT,
  ADD COLUMN "cache_read_tokens" BIGINT,
  ADD COLUMN "cache_write_tokens" BIGINT,
  ADD COLUMN "api_calls" INTEGER,
  ADD COLUMN "auxiliary_total_tokens" BIGINT,
  ADD COLUMN "total_including_auxiliary_tokens" BIGINT,
  ADD COLUMN "usage_scope" TEXT;
