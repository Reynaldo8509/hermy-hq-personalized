-- Safe fixture test. All rows are rolled back; no worker or external action runs.
BEGIN;

DO $approval_test$
DECLARE
  approve_id text := 'test-approval-approve-' || txid_current()::text;
  reject_id text := 'test-approval-reject-' || txid_current()::text;
  expire_id text := 'test-approval-expire-' || txid_current()::text;
  row_state record;
BEGIN
  INSERT INTO "ActionApproval"
    (id, request_id, action, status, requested_by, reason, expires_at, parameters_snapshot)
  VALUES
    (approve_id, approve_id, 'execute_agent_request', 'pending', 'fixture:requester', 'safe simulation', now() + interval '1 hour', '{}'::jsonb),
    (reject_id, reject_id, 'execute_agent_request', 'pending', 'fixture:requester', 'safe simulation', now() + interval '1 hour', '{}'::jsonb),
    (expire_id, expire_id, 'execute_agent_request', 'pending', 'fixture:requester', 'safe simulation', now() - interval '1 second', '{}'::jsonb);

  SELECT status INTO row_state FROM "ActionApproval" WHERE id=approve_id;
  IF row_state.status <> 'pending' THEN RAISE EXCEPTION 'pending branch did not start pending'; END IF;
  UPDATE "ActionApproval"
    SET status='approved', decision='approved', approved_by='fixture:approver',
        resolved_by='fixture:approver', result='fixture execution completed'
    WHERE id=approve_id AND status='pending';
  SELECT status, approved_by, rejected_by, result INTO row_state
    FROM "ActionApproval" WHERE id=approve_id;
  IF row_state.status <> 'approved' OR row_state.approved_by <> 'fixture:approver'
     OR row_state.rejected_by IS NOT NULL OR row_state.result <> 'fixture execution completed'
    THEN RAISE EXCEPTION 'approval branch did not preserve correct actor/result'; END IF;

  UPDATE "ActionApproval"
    SET status='rejected', decision='rejected', approved_by=NULL,
        rejected_by='fixture:rejector', resolved_by='fixture:rejector',
        result='fixture rejected; execution blocked'
    WHERE id=reject_id AND status='pending';
  SELECT status, approved_by, rejected_by, result INTO row_state
    FROM "ActionApproval" WHERE id=reject_id;
  IF row_state.status <> 'rejected' OR row_state.approved_by IS NOT NULL
     OR row_state.rejected_by <> 'fixture:rejector'
     OR row_state.result <> 'fixture rejected; execution blocked'
    THEN RAISE EXCEPTION 'rejection branch did not preserve separate actor/result'; END IF;

  UPDATE "ActionApproval"
    SET status='expired', decision='expired', resolved_by='system:approval-expiry',
        result='expired without execution', resolved_at=now()
    WHERE id=expire_id AND status='pending' AND expires_at <= now();
  SELECT status, resolved_by, result INTO row_state FROM "ActionApproval" WHERE id=expire_id;
  IF row_state.status <> 'expired' OR row_state.resolved_by <> 'system:approval-expiry'
     OR row_state.result <> 'expired without execution'
    THEN RAISE EXCEPTION 'expiration branch failed'; END IF;
END
$approval_test$;

ROLLBACK;
