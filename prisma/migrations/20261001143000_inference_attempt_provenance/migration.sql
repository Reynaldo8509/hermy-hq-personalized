ALTER TABLE "InferenceAttempt"
  ADD COLUMN "failover_reason" TEXT,
  ADD COLUMN "cost_source" TEXT;
