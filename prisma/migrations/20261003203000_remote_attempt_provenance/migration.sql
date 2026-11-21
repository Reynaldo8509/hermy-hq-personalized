ALTER TABLE "InferenceAttempt"
  ADD COLUMN "remote_attempted" BOOLEAN,
  ADD COLUMN "remote_attempt_status" TEXT;

ALTER TABLE "InferenceAttempt"
  ADD CONSTRAINT "InferenceAttempt_remote_attempt_status_valid"
  CHECK ("remote_attempt_status" IS NULL OR "remote_attempt_status" IN ('not_attempted', 'success', 'uncertain', 'failed'));
