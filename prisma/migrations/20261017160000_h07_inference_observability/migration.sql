-- Additive H07 provenance fields. Existing rows remain unchanged and nullable.
ALTER TABLE "InferenceAttempt"
  ADD COLUMN "usage_source" TEXT,
  ADD COLUMN "http_status" INTEGER;
