ALTER TABLE "InferenceAttempt"
  ADD COLUMN "privacy_class" TEXT,
  ADD COLUMN "complexity_class" TEXT,
  ADD COLUMN "route_tier" TEXT,
  ADD COLUMN "fallback_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "finish_reason" TEXT,
  ADD COLUMN "structured_output_valid" BOOLEAN;

ALTER TABLE "InferenceAttempt"
  ADD CONSTRAINT "InferenceAttempt_privacy_class_check"
    CHECK ("privacy_class" IS NULL OR "privacy_class" IN ('LOCAL_ONLY', 'PREFER_LOCAL', 'REMOTE_FREE_ALLOWED')),
  ADD CONSTRAINT "InferenceAttempt_complexity_class_check"
    CHECK ("complexity_class" IS NULL OR "complexity_class" IN ('SIMPLE', 'INTERMEDIATE', 'COMPLEX'));
