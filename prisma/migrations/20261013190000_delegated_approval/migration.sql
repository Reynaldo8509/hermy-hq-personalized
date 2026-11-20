BEGIN;

ALTER TABLE "AgentRequest"
  ADD COLUMN IF NOT EXISTS "contractVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "executionMode" text,
  ADD COLUMN IF NOT EXISTS scope jsonb,
  ADD COLUMN IF NOT EXISTS "privacyClass" text,
  ADD COLUMN IF NOT EXISTS "requestedBy" text,
  ADD COLUMN IF NOT EXISTS "authSource" text,
  ADD COLUMN IF NOT EXISTS "riskReasons" jsonb;

CREATE TABLE "DelegatedApprovalPolicy" (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  policy_hash text NOT NULL UNIQUE CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  issuer text NOT NULL,
  rule_ids jsonb NOT NULL CHECK (jsonb_typeof(rule_ids) = 'array'),
  resource_ids_by_rule jsonb NOT NULL CHECK (jsonb_typeof(resource_ids_by_rule) = 'object'),
  enabled boolean NOT NULL DEFAULT false,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 days'),
  CHECK ((revoked_at IS NULL) OR (enabled = false))
);

CREATE UNIQUE INDEX "DelegatedApprovalPolicy_one_active_idx"
  ON "DelegatedApprovalPolicy" ((enabled))
  WHERE enabled = true AND revoked_at IS NULL;

CREATE TABLE "DelegatedApprovalDecision" (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE REFERENCES "AgentRequest"(id) ON DELETE RESTRICT,
  approval_id text NOT NULL UNIQUE REFERENCES "ActionApproval"(id) ON DELETE RESTRICT,
  policy_id text NOT NULL REFERENCES "DelegatedApprovalPolicy"(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  rule_id text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  delegated_actor text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','consumed','revoked','expired','invalidated')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes'),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);

CREATE INDEX "DelegatedApprovalDecision_policy_idx"
  ON "DelegatedApprovalDecision" (policy_id, status, expires_at);

CREATE TABLE "DelegatedApprovalAudit" (
  id text PRIMARY KEY,
  actor text NOT NULL,
  event text NOT NULL,
  policy_id text REFERENCES "DelegatedApprovalPolicy"(id) ON DELETE RESTRICT,
  request_id text REFERENCES "AgentRequest"(id) ON DELETE RESTRICT,
  approval_id text REFERENCES "ActionApproval"(id) ON DELETE RESTRICT,
  policy_hash text,
  request_fingerprint text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX "DelegatedApprovalAudit_policy_idx"
  ON "DelegatedApprovalAudit" (policy_id, created_at);
CREATE INDEX "DelegatedApprovalAudit_request_idx"
  ON "DelegatedApprovalAudit" (request_id, created_at);

CREATE FUNCTION reject_delegated_approval_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DelegatedApprovalAudit is append-only';
END;
$$;

CREATE TRIGGER "DelegatedApprovalAudit_append_only"
  BEFORE UPDATE OR DELETE ON "DelegatedApprovalAudit"
  FOR EACH ROW EXECUTE FUNCTION reject_delegated_approval_audit_mutation();

COMMIT;
