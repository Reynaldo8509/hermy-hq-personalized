ALTER TABLE "ActionApproval"
  ADD COLUMN "rejected_by" TEXT,
  ADD COLUMN "resolved_by" TEXT,
  ADD COLUMN "decision" TEXT,
  ADD COLUMN "result" TEXT,
  ADD COLUMN "incident_id" TEXT;

UPDATE "ActionApproval"
SET "rejected_by" = COALESCE("rejected_by", "approved_by"),
    "approved_by" = NULL,
    "decision" = 'rejected'
WHERE "status" = 'rejected';

UPDATE "ActionApproval"
SET "decision" = "status"
WHERE "decision" IS NULL AND "status" IN ('approved', 'expired');

ALTER TABLE "IncidentMemory"
  ADD COLUMN "invalid_duration_ms" BIGINT,
  ADD COLUMN "cause_confirmed" BOOLEAN;

UPDATE "IncidentMemory"
SET "invalid_duration_ms" = "duration_ms",
    "duration_ms" = NULL,
    "limitations" = concat_ws(E'\n', NULLIF(btrim("limitations"), ''),
      'Auditoría: duration_ms negativo (' || "duration_ms"::text || ') se anuló; timestamps originales preservados.')
WHERE "duration_ms" < 0;

ALTER TABLE "IncidentMemory"
  ADD CONSTRAINT "IncidentMemory_duration_nonnegative"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);

ALTER TABLE "InferenceAttempt"
  ADD COLUMN "attempt_number" INTEGER,
  ADD COLUMN "requested_provider" TEXT,
  ADD COLUMN "requested_model" TEXT,
  ADD COLUMN "gateway" TEXT,
  ADD COLUMN "actual_provider" TEXT,
  ADD COLUMN "actual_model" TEXT,
  ADD COLUMN "underlying_provider" TEXT,
  ADD COLUMN "error_class" TEXT,
  ADD COLUMN "started_at" TIMESTAMP(6),
  ADD COLUMN "prompt_tokens" BIGINT,
  ADD COLUMN "completion_tokens" BIGINT,
  ADD COLUMN "total_tokens" BIGINT,
  ADD COLUMN "reported_cost" DOUBLE PRECISION,
  ADD COLUMN "cost_currency" TEXT,
  ADD COLUMN "cost_status" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "free_route" BOOLEAN;

UPDATE "InferenceAttempt"
SET "attempt_number" = "attempt_no",
    "requested_provider" = "provider",
    "requested_model" = "model",
    "started_at" = "created_at";

ALTER TABLE "InferenceAttempt"
  ADD CONSTRAINT "InferenceAttempt_duration_nonnegative"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  ADD CONSTRAINT "InferenceAttempt_cost_status_valid"
  CHECK ("cost_status" IN ('verified_free', 'reported_zero', 'unknown', 'paid'));
