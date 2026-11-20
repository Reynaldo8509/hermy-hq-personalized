BEGIN;

ALTER TABLE "AgentRequest"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" text,
  ADD COLUMN IF NOT EXISTS "dependsOn" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS capability text;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentRequest_idempotencyKey_key"
  ON "AgentRequest" ("idempotencyKey");

ALTER TABLE "ActionApproval"
  ADD COLUMN IF NOT EXISTS expires_at timestamp without time zone,
  ADD COLUMN IF NOT EXISTS parameters_snapshot jsonb;

UPDATE "ActionApproval"
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

UPDATE "ActionApproval" a
SET expires_at = COALESCE(a.expires_at, a.created_at + interval '24 hours'),
    parameters_snapshot = jsonb_build_object(
      'requestId', r.id, 'origin', r.origin, 'kind', r.kind, 'title', r.title,
      'prompt', r.prompt, 'sideEffecting', r."sideEffecting", 'action', r.action, 'capability', r.capability,
      'dependencies', COALESCE(r."dependsOn", '[]'::jsonb)
    )
FROM "AgentRequest" r
WHERE a.request_id = r.id AND a.action = 'execute' AND a.status = 'pending'
  AND r."sideEffecting" = true;

INSERT INTO "ActionApproval"
  (id, request_id, action, status, requested_by, approved_by, reason, created_at,
   resolved_at, expires_at, parameters_snapshot)
SELECT 'approval-' || r.id, r.id, 'execute', 'pending', r.origin, NULL,
  'Fase 2: se requiere aprobación individual para esta solicitud.',
  now(), NULL, now() + interval '24 hours',
  jsonb_build_object('requestId', r.id, 'origin', r.origin, 'kind', r.kind,
    'title', r.title, 'prompt', r.prompt, 'sideEffecting', r."sideEffecting", 'action', r.action, 'capability', r.capability,
    'dependencies', COALESCE(r."dependsOn", '[]'::jsonb))
FROM "AgentRequest" r
WHERE r.status = 'awaiting_approval' AND r."sideEffecting" = true
  AND NOT EXISTS (
    SELECT 1 FROM "ActionApproval" a WHERE a.request_id = r.id
      AND a.action = 'execute' AND a.status = 'pending'
  )
ON CONFLICT (id) DO UPDATE SET
  action = 'execute', status = 'pending', requested_by = EXCLUDED.requested_by,
  approved_by = NULL, reason = EXCLUDED.reason, created_at = now(), resolved_at = NULL,
  expires_at = EXCLUDED.expires_at, parameters_snapshot = EXCLUDED.parameters_snapshot;

COMMIT;
