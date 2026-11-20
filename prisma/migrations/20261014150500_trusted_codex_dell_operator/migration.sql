BEGIN;

ALTER TABLE "ActionApproval"
  ADD COLUMN IF NOT EXISTS approval_method text;

COMMENT ON COLUMN "ActionApproval".approval_method IS
  'Machine-authenticated decision method; null for historical and ordinary human decisions.';

COMMIT;
