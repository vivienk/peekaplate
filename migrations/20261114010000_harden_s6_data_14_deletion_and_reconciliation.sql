-- migrate:up
-- S6-DATA-14 Hardening:
-- 1. Separate peekaplate_runtime from deletion-operator and independent deletion-checker roles.
-- 2. Enforce deletion lifecycle state machine, provenance immutability, and non-self-approval in PostgreSQL.
-- 3. Add monotonic per-venue deletion_epoch fencing, global restore freeze gate, and restore reconciliation ledger.

DO $$
DECLARE
  op_role record;
  chk_role record;
BEGIN
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls, rolinherit
    INTO op_role
    FROM pg_roles
    WHERE rolname = 'peekaplate_deletion_operator';
  IF NOT FOUND THEN
    CREATE ROLE peekaplate_deletion_operator NOLOGIN NOINHERIT;
  ELSIF op_role.rolsuper OR op_role.rolcreatedb OR op_role.rolcreaterole
    OR op_role.rolcanlogin OR op_role.rolreplication OR op_role.rolbypassrls
    OR op_role.rolinherit THEN
    RAISE EXCEPTION 'peekaplate_deletion_operator exists with unsafe attributes';
  END IF;

  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls, rolinherit
    INTO chk_role
    FROM pg_roles
    WHERE rolname = 'peekaplate_deletion_checker';
  IF NOT FOUND THEN
    CREATE ROLE peekaplate_deletion_checker NOLOGIN NOINHERIT;
  ELSIF chk_role.rolsuper OR chk_role.rolcreatedb OR chk_role.rolcreaterole
    OR chk_role.rolcanlogin OR chk_role.rolreplication OR chk_role.rolbypassrls
    OR chk_role.rolinherit THEN
    RAISE EXCEPTION 'peekaplate_deletion_checker exists with unsafe attributes';
  END IF;
END;
$$;

-- Revoke excessive privileges from peekaplate_runtime
REVOKE EXECUTE ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) FROM peekaplate_runtime;
REVOKE UPDATE ON app_private.order_data_deletion_requests FROM peekaplate_runtime;

-- Grant scoped schema and table privileges to operator and checker roles
GRANT USAGE ON SCHEMA app_private TO peekaplate_deletion_operator, peekaplate_deletion_checker;
GRANT SELECT, UPDATE ON app_private.order_data_deletion_requests TO peekaplate_deletion_operator;
GRANT SELECT ON app_private.order_outcome_import_batches TO peekaplate_deletion_operator;
GRANT EXECUTE ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) TO peekaplate_deletion_operator;

-- Per-venue monotonic deletion epoch for fencing in-flight imports across Tx 1 -> R2 upload -> Tx 2
CREATE TABLE app_private.order_data_deletion_gates (
  tenant_id uuid PRIMARY KEY REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  deletion_epoch bigint NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_private.order_data_deletion_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_data_deletion_gates FORCE ROW LEVEL SECURITY;
CREATE POLICY order_data_deletion_gates_tenant_scope ON app_private.order_data_deletion_gates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON app_private.order_data_deletion_gates TO peekaplate_runtime, peekaplate_deletion_operator, peekaplate_deletion_checker;

-- Global restore freeze gate (fail-closed if unreadable or active)
CREATE TABLE app_private.system_gates (
  gate_name text PRIMARY KEY CHECK (length(btrim(gate_name)) > 0 AND length(gate_name) <= 64),
  is_active boolean NOT NULL DEFAULT false,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_private.system_gates (gate_name, is_active, reason)
VALUES ('order_imports_restore_freeze', false, NULL)
ON CONFLICT (gate_name) DO NOTHING;

GRANT SELECT ON app_private.system_gates TO peekaplate_runtime, peekaplate_deletion_operator, peekaplate_deletion_checker;
GRANT UPDATE (is_active, reason, updated_by, updated_at) ON app_private.system_gates TO peekaplate_deletion_operator;

-- Append-only restore reconciliation audit log
CREATE TABLE app_private.restore_reconciliation_runs (
  id uuid PRIMARY KEY,
  reconciliation_run_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  ledger_status text NOT NULL CHECK (
    ledger_status IN ('completed', 'intent_only', 'completed_without_intent', 'missing_in_r2', 'malformed', 'conflict')
  ),
  outcome text NOT NULL CHECK (
    outcome IN ('reconciled', 'blocked_unresolved_intent', 'blocked_anomaly', 'failed')
  ),
  r2_objects_deleted integer NOT NULL DEFAULT 0 CHECK (r2_objects_deleted >= 0),
  db_batches_deleted integer NOT NULL DEFAULT 0 CHECK (db_batches_deleted >= 0),
  db_lines_deleted integer NOT NULL DEFAULT 0 CHECK (db_lines_deleted >= 0),
  db_quarantine_deleted integer NOT NULL DEFAULT 0 CHECK (db_quarantine_deleted >= 0),
  db_conflicts_deleted integer NOT NULL DEFAULT 0 CHECK (db_conflicts_deleted >= 0),
  operator_id uuid NOT NULL,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 512),
  reconciled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER restore_reconciliation_runs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.restore_reconciliation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.restore_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.restore_reconciliation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_reconciliation_runs_tenant_scope ON app_private.restore_reconciliation_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON app_private.restore_reconciliation_runs TO peekaplate_runtime, peekaplate_deletion_checker;
GRANT SELECT, INSERT ON app_private.restore_reconciliation_runs TO peekaplate_deletion_operator;

-- L2: Durable retry queue for failed compensating R2 deletions (no CSV/PII content)
CREATE TABLE app_private.order_import_orphan_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  storage_key text NOT NULL CHECK (
    storage_key ~ ('^order-imports/' || tenant_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/source\.csv$')
  ),
  deletion_epoch bigint NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cleaned', 'failed')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz,
  UNIQUE (tenant_id, batch_id)
);

ALTER TABLE app_private.order_import_orphan_cleanups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_import_orphan_cleanups FORCE ROW LEVEL SECURITY;
CREATE POLICY order_import_orphan_cleanups_tenant_scope ON app_private.order_import_orphan_cleanups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON app_private.order_import_orphan_cleanups TO peekaplate_runtime, peekaplate_deletion_operator;

-- C1: Unforgeable transaction-scoped grant table (replaces untrusted GUC flags).
-- Only record_deletion_verification() and reconcile_venue_order_deletion() may write/delete rows here.
CREATE UNLOGGED TABLE app_private.deletion_privileged_tx_grants (
  txid xid8 PRIMARY KEY,
  pid integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('verification', 'reconciliation')),
  session_role text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE app_private.deletion_privileged_tx_grants FROM PUBLIC, peekaplate_runtime, peekaplate_deletion_operator, peekaplate_deletion_checker;

CREATE OR REPLACE FUNCTION app_private.is_runtime_role(p_role name)
RETURNS boolean
STABLE
SET search_path = pg_catalog
AS $$
  SELECT pg_has_role(p_role, 'peekaplate_runtime', 'member')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role AND rolsuper);
$$ LANGUAGE sql;

REVOKE ALL ON FUNCTION app_private.is_runtime_role(name) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_runtime_role(name) TO peekaplate_runtime, peekaplate_deletion_operator, peekaplate_deletion_checker;

CREATE OR REPLACE FUNCTION app_private.has_privileged_deletion_tx_grant(p_operation text)
RETURNS boolean
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  IF app_private.is_runtime_role(session_user)
     OR app_private.is_runtime_role(current_user) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM app_private.deletion_privileged_tx_grants g
    WHERE g.txid = pg_current_xact_id()
      AND g.pid = pg_backend_pid()
      AND g.operation = p_operation
      AND g.session_role = session_user::text
  );
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.has_privileged_deletion_tx_grant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.has_privileged_deletion_tx_grant(text) TO peekaplate_runtime, peekaplate_deletion_operator, peekaplate_deletion_checker;

-- Expand order_data_deletion_requests lifecycle & verification columns
ALTER TABLE app_private.order_data_deletion_requests
  ADD COLUMN receipt_written_at timestamptz,
  ADD COLUMN verified_by uuid,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verification_outcome text CHECK (verification_outcome IS NULL OR verification_outcome IN ('PASS', 'FAIL')),
  ADD COLUMN verification_evidence_ref text CHECK (verification_evidence_ref IS NULL OR length(verification_evidence_ref) <= 512),
  ADD COLUMN reconciled_from_r2 boolean NOT NULL DEFAULT false;

ALTER TABLE app_private.order_data_deletion_requests
  DROP CONSTRAINT IF EXISTS order_data_deletion_requests_status_check,
  DROP CONSTRAINT IF EXISTS order_data_deletion_requests_check;

ALTER TABLE app_private.order_data_deletion_requests
  ADD CONSTRAINT order_data_deletion_requests_status_check
    CHECK (status IN ('requested', 'executing', 'r2_deleted', 'db_deleted', 'awaiting_verification', 'verified', 'failed')),
  ADD CONSTRAINT order_data_deletion_requests_completion_check
    CHECK (status NOT IN ('db_deleted', 'awaiting_verification', 'verified') OR (completed_at IS NOT NULL AND executed_by IS NOT NULL)),
  ADD CONSTRAINT order_data_deletion_requests_receipt_check
    CHECK (status NOT IN ('awaiting_verification', 'verified') OR receipt_written_at IS NOT NULL),
  ADD CONSTRAINT order_data_deletion_requests_verification_check
    CHECK (
      status <> 'verified' OR (
        verified_by IS NOT NULL AND
        verified_at IS NOT NULL AND
        verification_outcome = 'PASS' AND
        verified_by <> requested_by AND
        verified_by <> executed_by
      )
    );

DROP INDEX IF EXISTS app_private.order_data_deletion_requests_tenant_active_idx;
CREATE INDEX order_data_deletion_requests_tenant_active_idx
  ON app_private.order_data_deletion_requests (tenant_id, status)
  WHERE status <> 'verified';

-- Column-scoped read grants for independent deletion checker
GRANT SELECT (
  tenant_id, id, requested_by, executed_by, reason, status,
  r2_objects_deleted, db_batches_deleted, db_lines_deleted,
  db_quarantine_deleted, db_conflicts_deleted, error_code,
  requested_at, completed_at, receipt_written_at,
  verified_by, verified_at, verification_outcome, verification_evidence_ref,
  reconciled_from_r2
) ON app_private.order_data_deletion_requests TO peekaplate_deletion_checker;
GRANT SELECT (id, tenant_id, status, created_at, finished_at) ON app_private.order_outcome_import_batches TO peekaplate_deletion_checker;
GRANT SELECT (tenant_id, order_id, order_line_id, outcome_type, batch_id) ON app_private.order_outcome_lines TO peekaplate_deletion_checker;
GRANT SELECT (id, tenant_id, batch_id) ON app_private.order_outcome_quarantine TO peekaplate_deletion_checker;
GRANT SELECT (tenant_id, order_id, order_line_id, outcome_type, batch_id) ON app_private.order_outcome_conflicts TO peekaplate_deletion_checker;
GRANT SELECT (tenant_id, pos_item_code, review_status) ON app_private.pos_dish_mappings TO peekaplate_deletion_checker;
GRANT SELECT (tenant_id, activated_at) ON app_private.venue_tracking_activations TO peekaplate_deletion_checker;

-- Atomically increment per-venue deletion_epoch when a deletion request is inserted
CREATE OR REPLACE FUNCTION app_private.bump_order_data_deletion_epoch()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  INSERT INTO app_private.order_data_deletion_gates (tenant_id, deletion_epoch, updated_at)
  VALUES (NEW.tenant_id, 1, now())
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    deletion_epoch = app_private.order_data_deletion_gates.deletion_epoch + 1,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.bump_order_data_deletion_epoch() FROM PUBLIC;

CREATE TRIGGER order_data_deletion_requests_epoch_bump
  AFTER INSERT ON app_private.order_data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.bump_order_data_deletion_epoch();

-- C1: SECURITY INVOKER caller guard (runs before insert enforcement).
-- Distinguishes session_user from current_user and rejects runtime logins, runtime current_user,
-- and arbitrary postgres-owned SECURITY DEFINER functions without an unforgeable tx grant.
CREATE OR REPLACE FUNCTION app_private.guard_order_data_deletion_request_caller()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reconciled_from_r2
     OR NEW.status <> 'requested'
     OR NEW.executed_by IS NOT NULL
     OR NEW.completed_at IS NOT NULL
     OR NEW.receipt_written_at IS NOT NULL
     OR NEW.verified_by IS NOT NULL
     OR NEW.verified_at IS NOT NULL
     OR NEW.verification_outcome IS NOT NULL
     OR NEW.verification_evidence_ref IS NOT NULL THEN
    IF app_private.is_runtime_role(session_user)
       OR app_private.is_runtime_role(current_user)
       OR NOT app_private.has_privileged_deletion_tx_grant('reconciliation') THEN
      RAISE EXCEPTION 'Session % (current %) cannot insert reconciliation or pre-completed deletion records', session_user, current_user;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "00_guard_order_data_deletion_request_caller"
  BEFORE INSERT ON app_private.order_data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_order_data_deletion_request_caller();

-- Allow privileged reconciliation inserts while keeping normal inserts owner-gated
CREATE OR REPLACE FUNCTION app_private.enforce_order_data_deletion_request_insert()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  session_actor text;
  session_tenant text;
  session_permission text;
BEGIN
  session_tenant := NULLIF(btrim(current_setting('app.tenant_id', true)), '');
  IF session_tenant IS NULL OR session_tenant <> NEW.tenant_id::text THEN
    RAISE EXCEPTION 'Trusted tenant context (app.tenant_id) must match deletion request tenant_id';
  END IF;

  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');

  IF NEW.reconciled_from_r2 THEN
    IF NOT app_private.has_privileged_deletion_tx_grant('reconciliation') THEN
      RAISE EXCEPTION 'reconciled_from_r2 inserts are permitted only inside reconcile_venue_order_deletion';
    END IF;
    IF session_actor IS NULL OR session_actor <> NEW.executed_by::text THEN
      RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match executed_by during reconciliation';
    END IF;
    RETURN NEW;
  END IF;

  IF session_actor IS NULL OR session_actor <> NEW.requested_by::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match requested_by';
  END IF;

  SELECT permission INTO session_permission
  FROM app_private.staff_membership
  WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.requested_by;

  IF session_permission IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an authorized venue owner may submit an order data deletion request';
  END IF;

  IF NEW.status <> 'requested' OR NEW.executed_by IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.verified_by IS NOT NULL THEN
    RAISE EXCEPTION 'New deletion requests must start in requested state without completion or verification fields';
  END IF;

  NEW.requested_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enforce role-restricted updates, provenance immutability, and strict state machine transitions
CREATE OR REPLACE FUNCTION app_private.enforce_order_data_deletion_request_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
  is_operator boolean;
  is_reconciliation boolean;
  is_verification boolean;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Deleting or truncating order data deletion audit records is prohibited';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    is_reconciliation := app_private.has_privileged_deletion_tx_grant('reconciliation');
    is_verification := app_private.has_privileged_deletion_tx_grant('verification');
    is_operator := (
      pg_has_role(current_user, 'peekaplate_deletion_operator', 'usage')
      OR pg_has_role(session_user, 'peekaplate_deletion_operator', 'member')
      OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper)
    )
    AND NOT app_private.is_runtime_role(session_user)
    AND NOT app_private.is_runtime_role(current_user);

    IF NOT (is_operator OR is_reconciliation OR is_verification) THEN
      RAISE EXCEPTION 'Session % (current %) is not authorized to update deletion lifecycle records', session_user, current_user;
    END IF;

    IF NEW.id <> OLD.id OR
       NEW.tenant_id <> OLD.tenant_id OR
       NEW.requested_by <> OLD.requested_by OR
       NEW.requested_at <> OLD.requested_at OR
       NEW.reason IS DISTINCT FROM OLD.reason OR
       NEW.reconciled_from_r2 IS DISTINCT FROM OLD.reconciled_from_r2 THEN
      RAISE EXCEPTION 'Mutation of immutable deletion audit provenance fields is prohibited';
    END IF;

    IF OLD.status = 'verified' THEN
      RAISE EXCEPTION 'Verified deletion audit records are immutable';
    END IF;

    -- Allowed transitions
    IF NOT (
      (OLD.status = 'requested' AND NEW.status IN ('executing', 'failed')) OR
      (OLD.status = 'executing' AND NEW.status IN ('executing', 'r2_deleted', 'failed')) OR
      (OLD.status = 'r2_deleted' AND NEW.status IN ('db_deleted', 'failed')) OR
      (OLD.status = 'db_deleted' AND NEW.status IN ('db_deleted', 'awaiting_verification', 'failed')) OR
      (OLD.status = 'awaiting_verification' AND NEW.status IN ('awaiting_verification', 'verified')) OR
      (OLD.status = 'failed' AND NEW.status IN ('executing', 'failed'))
    ) THEN
      IF NOT is_reconciliation THEN
        RAISE EXCEPTION 'Illegal deletion lifecycle transition from % to %', OLD.status, NEW.status;
      END IF;
    END IF;

    IF NEW.status = 'verified' AND NOT is_verification THEN
      RAISE EXCEPTION 'Transition to verified is permitted only through record_deletion_verification';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Independent checker verification function (checker <> requested_by and checker <> executed_by)
CREATE OR REPLACE FUNCTION app_private.record_deletion_verification(
  p_tenant_id uuid,
  p_request_id uuid,
  p_checker_id uuid,
  p_outcome text,
  p_evidence_ref text
)
RETURNS TABLE (
  request_id uuid,
  venue_id uuid,
  status text,
  verified_by uuid,
  verified_at timestamptz,
  verification_outcome text
)
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  session_tenant text;
  session_actor text;
  req_row record;
  v_now timestamptz := now();
BEGIN
  IF pg_has_role(session_user, 'peekaplate_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime role % cannot execute record_deletion_verification', session_user;
  END IF;

  IF NOT (
    pg_has_role(session_user, 'peekaplate_deletion_checker', 'member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper)
  ) THEN
    RAISE EXCEPTION 'Session role % is not authorized to verify order data deletion', session_user;
  END IF;

  session_tenant := NULLIF(btrim(current_setting('app.tenant_id', true)), '');
  IF session_tenant IS NULL OR session_tenant <> p_tenant_id::text THEN
    RAISE EXCEPTION 'Trusted tenant context (app.tenant_id) must match p_tenant_id';
  END IF;

  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');
  IF session_actor IS NULL OR session_actor <> p_checker_id::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match p_checker_id';
  END IF;

  IF p_outcome NOT IN ('PASS', 'FAIL') THEN
    RAISE EXCEPTION 'Invalid verification outcome: %', p_outcome;
  END IF;

  IF p_evidence_ref IS NULL OR length(btrim(p_evidence_ref)) = 0 THEN
    RAISE EXCEPTION 'Verification evidence reference is required';
  END IF;

  SELECT r.id, r.tenant_id, r.requested_by, r.executed_by, r.status
  INTO req_row
  FROM app_private.order_data_deletion_requests AS r
  WHERE r.tenant_id = p_tenant_id AND r.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deletion request % not found for tenant %', p_request_id, p_tenant_id;
  END IF;

  IF req_row.status <> 'awaiting_verification' THEN
    RAISE EXCEPTION 'Deletion request % is in status %, expected awaiting_verification', p_request_id, req_row.status;
  END IF;

  IF p_checker_id = req_row.requested_by OR p_checker_id = req_row.executed_by THEN
    RAISE EXCEPTION 'Independent checker cannot be the requester or executing operator';
  END IF;

  BEGIN
    INSERT INTO app_private.deletion_privileged_tx_grants (txid, pid, operation, session_role)
    VALUES (pg_current_xact_id(), pg_backend_pid(), 'verification', session_user::text)
    ON CONFLICT (txid) DO UPDATE
      SET pid = EXCLUDED.pid, operation = EXCLUDED.operation, session_role = EXCLUDED.session_role;

    UPDATE app_private.order_data_deletion_requests
    SET status = CASE WHEN p_outcome = 'PASS' THEN 'verified' ELSE 'awaiting_verification' END,
        verified_by = p_checker_id,
        verified_at = v_now,
        verification_outcome = p_outcome,
        verification_evidence_ref = p_evidence_ref,
        execution_token = NULL,
        execution_lease_expires_at = NULL
    WHERE tenant_id = p_tenant_id AND id = p_request_id;

    IF p_outcome = 'PASS' THEN
      UPDATE app_private.order_import_orphan_cleanups AS c
      SET status = 'cleaned', cleaned_at = v_now, last_attempt_at = v_now, last_error = NULL
      WHERE c.tenant_id = p_tenant_id AND c.status <> 'cleaned';
    END IF;

    DELETE FROM app_private.deletion_privileged_tx_grants WHERE txid = pg_current_xact_id();
  EXCEPTION
    WHEN OTHERS THEN
      DELETE FROM app_private.deletion_privileged_tx_grants WHERE txid = pg_current_xact_id();
      RAISE;
  END;

  RETURN QUERY
  SELECT
    p_request_id,
    p_tenant_id,
    CASE WHEN p_outcome = 'PASS' THEN 'verified'::text ELSE 'awaiting_verification'::text END,
    p_checker_id,
    v_now,
    p_outcome;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.record_deletion_verification(uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_deletion_verification(uuid, uuid, uuid, text, text) TO peekaplate_deletion_checker;

-- Privileged post-restore reconciliation function (operator-only)
CREATE OR REPLACE FUNCTION app_private.reconcile_venue_order_deletion(
  p_reconciliation_run_id uuid,
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid,
  p_completed_at timestamptz,
  p_receipt_written_at timestamptz,
  p_ledger_status text,
  p_r2_objects_deleted integer,
  p_evidence_ref text
)
RETURNS TABLE (
  batches_deleted integer,
  lines_deleted integer,
  quarantine_deleted integer,
  conflicts_deleted integer,
  outcome text
)
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  session_tenant text;
  session_actor text;
  existing_row record;
  v_batches integer := 0;
  v_lines integer := 0;
  v_quarantine integer := 0;
  v_conflicts integer := 0;
  v_outcome text;
BEGIN
  IF pg_has_role(session_user, 'peekaplate_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime role % cannot execute reconcile_venue_order_deletion', session_user;
  END IF;

  IF NOT (
    pg_has_role(session_user, 'peekaplate_deletion_operator', 'member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper)
  ) THEN
    RAISE EXCEPTION 'Session role % is not authorized to reconcile order data deletion', session_user;
  END IF;

  session_tenant := NULLIF(btrim(current_setting('app.tenant_id', true)), '');
  IF session_tenant IS NULL OR session_tenant <> p_tenant_id::text THEN
    RAISE EXCEPTION 'Trusted tenant context (app.tenant_id) must match p_tenant_id';
  END IF;

  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');
  IF session_actor IS NULL OR session_actor <> p_operator_id::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match p_operator_id';
  END IF;

  IF p_ledger_status NOT IN ('completed', 'intent_only', 'completed_without_intent', 'missing_in_r2', 'conflict') THEN
    RAISE EXCEPTION 'Unsupported ledger_status for reconciliation: %', p_ledger_status;
  END IF;

  BEGIN
    INSERT INTO app_private.deletion_privileged_tx_grants (txid, pid, operation, session_role)
    VALUES (pg_current_xact_id(), pg_backend_pid(), 'reconciliation', session_user::text)
    ON CONFLICT (txid) DO UPDATE
      SET pid = EXCLUDED.pid, operation = EXCLUDED.operation, session_role = EXCLUDED.session_role;
    PERFORM set_config('app.order_data_deletion_active', 'on', true);

    SELECT id, status, requested_by
    INTO existing_row
    FROM app_private.order_data_deletion_requests
    WHERE tenant_id = p_tenant_id AND id = p_request_id
    FOR UPDATE;

    IF p_ledger_status = 'completed' THEN
      DELETE FROM app_private.order_outcome_lines WHERE tenant_id = p_tenant_id;
      GET DIAGNOSTICS v_lines = ROW_COUNT;

      DELETE FROM app_private.order_outcome_quarantine WHERE tenant_id = p_tenant_id;
      GET DIAGNOSTICS v_quarantine = ROW_COUNT;

      DELETE FROM app_private.order_outcome_conflicts WHERE tenant_id = p_tenant_id;
      GET DIAGNOSTICS v_conflicts = ROW_COUNT;

      DELETE FROM app_private.order_outcome_import_batches WHERE tenant_id = p_tenant_id;
      GET DIAGNOSTICS v_batches = ROW_COUNT;

      IF NOT FOUND THEN
        INSERT INTO app_private.order_data_deletion_requests (
          tenant_id, id, requested_by, executed_by, reason, status,
          r2_objects_deleted, db_batches_deleted, db_lines_deleted,
          db_quarantine_deleted, db_conflicts_deleted,
          requested_at, completed_at, receipt_written_at, reconciled_from_r2
        ) VALUES (
          p_tenant_id, p_request_id, p_operator_id, p_operator_id, NULL, 'awaiting_verification',
          GREATEST(0, p_r2_objects_deleted), v_batches, v_lines, v_quarantine, v_conflicts,
          COALESCE(p_completed_at, now()), COALESCE(p_completed_at, now()), COALESCE(p_receipt_written_at, now()), true
        );
      ELSIF existing_row.status <> 'verified' THEN
        UPDATE app_private.order_data_deletion_requests
        SET status = 'awaiting_verification',
            executed_by = COALESCE(executed_by, p_operator_id),
            completed_at = COALESCE(completed_at, p_completed_at, now()),
            receipt_written_at = COALESCE(receipt_written_at, p_receipt_written_at, now()),
            r2_objects_deleted = GREATEST(r2_objects_deleted, p_r2_objects_deleted),
            db_batches_deleted = db_batches_deleted + v_batches,
            db_lines_deleted = db_lines_deleted + v_lines,
            db_quarantine_deleted = db_quarantine_deleted + v_quarantine,
            db_conflicts_deleted = db_conflicts_deleted + v_conflicts,
            execution_token = NULL,
            execution_lease_expires_at = NULL,
            error_code = NULL
        WHERE tenant_id = p_tenant_id AND id = p_request_id;
      END IF;

      UPDATE app_private.order_import_orphan_cleanups
      SET status = 'cleaned', cleaned_at = now(), last_attempt_at = now(), last_error = NULL
      WHERE tenant_id = p_tenant_id AND status <> 'cleaned';

      v_outcome := 'reconciled';
    ELSE
      -- intent_only / completed_without_intent / missing_in_r2 / conflict: keep venue blocked
      IF NOT FOUND THEN
        INSERT INTO app_private.order_data_deletion_requests (
          tenant_id, id, requested_by, executed_by, reason, status,
          error_code, requested_at, reconciled_from_r2
        ) VALUES (
          p_tenant_id, p_request_id, p_operator_id, p_operator_id, NULL, 'failed',
          left('restore_' || p_ledger_status, 64), now(), true
        );
      ELSIF existing_row.status <> 'verified' THEN
        UPDATE app_private.order_data_deletion_requests
        SET status = 'failed',
            error_code = left('restore_' || p_ledger_status, 64),
            execution_token = NULL,
            execution_lease_expires_at = NULL
        WHERE tenant_id = p_tenant_id AND id = p_request_id;
      END IF;

      v_outcome := CASE
        WHEN p_ledger_status = 'intent_only' THEN 'blocked_unresolved_intent'
        ELSE 'blocked_anomaly'
      END;
    END IF;

    INSERT INTO app_private.restore_reconciliation_runs (
      id, reconciliation_run_id, tenant_id, request_id, ledger_status, outcome,
      r2_objects_deleted, db_batches_deleted, db_lines_deleted,
      db_quarantine_deleted, db_conflicts_deleted,
      operator_id, evidence_ref, reconciled_at
    ) VALUES (
      gen_random_uuid(), p_reconciliation_run_id, p_tenant_id, p_request_id, p_ledger_status, v_outcome,
      GREATEST(0, p_r2_objects_deleted), v_batches, v_lines, v_quarantine, v_conflicts,
      p_operator_id, p_evidence_ref, now()
    );

    PERFORM set_config('app.order_data_deletion_active', 'off', true);
    DELETE FROM app_private.deletion_privileged_tx_grants WHERE txid = pg_current_xact_id();
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('app.order_data_deletion_active', 'off', true);
      DELETE FROM app_private.deletion_privileged_tx_grants WHERE txid = pg_current_xact_id();
      RAISE;
  END;

  RETURN QUERY SELECT v_batches, v_lines, v_quarantine, v_conflicts, v_outcome;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.reconcile_venue_order_deletion(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.reconcile_venue_order_deletion(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text) TO peekaplate_deletion_operator;

-- H1: Replace delete_venue_order_data so obsolete 'completed' check rejects db_deleted, awaiting_verification, and verified
CREATE OR REPLACE FUNCTION app_private.delete_venue_order_data(
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid,
  p_execution_token uuid
)
RETURNS TABLE (
  batches_deleted integer,
  lines_deleted integer,
  quarantine_deleted integer,
  conflicts_deleted integer
)
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  session_tenant text;
  session_actor text;
  request_status text;
  current_token uuid;
  v_lines integer := 0;
  v_quarantine integer := 0;
  v_conflicts integer := 0;
  v_batches integer := 0;
BEGIN
  IF pg_has_role(session_user, 'peekaplate_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime role % cannot execute delete_venue_order_data', session_user;
  END IF;

  IF NOT (
    pg_has_role(session_user, 'peekaplate_deletion_operator', 'member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper)
  ) THEN
    RAISE EXCEPTION 'Session role % is not authorized to execute order data deletion', session_user;
  END IF;

  session_tenant := NULLIF(btrim(current_setting('app.tenant_id', true)), '');
  IF session_tenant IS NULL OR session_tenant <> p_tenant_id::text THEN
    RAISE EXCEPTION 'Trusted tenant context (app.tenant_id) must match p_tenant_id';
  END IF;

  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');
  IF session_actor IS NULL OR session_actor <> p_operator_id::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match p_operator_id';
  END IF;

  SELECT status, execution_token INTO request_status, current_token
  FROM app_private.order_data_deletion_requests
  WHERE tenant_id = p_tenant_id AND id = p_request_id
  FOR UPDATE;

  IF request_status IS NULL THEN
    RAISE EXCEPTION 'Deletion audit request % not found for tenant %', p_request_id, p_tenant_id;
  END IF;

  IF request_status NOT IN ('executing', 'r2_deleted') THEN
    RAISE EXCEPTION 'Deletion audit request % is in state %, expected executing or r2_deleted', p_request_id, request_status;
  END IF;

  IF current_token IS NULL OR current_token <> p_execution_token THEN
    RAISE EXCEPTION 'Deletion execution fencing token mismatch for request %', p_request_id;
  END IF;

  BEGIN
    PERFORM set_config('app.order_data_deletion_active', 'on', true);

    DELETE FROM app_private.order_outcome_lines WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_lines = ROW_COUNT;

    DELETE FROM app_private.order_outcome_quarantine WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_quarantine = ROW_COUNT;

    DELETE FROM app_private.order_outcome_conflicts WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_conflicts = ROW_COUNT;

    DELETE FROM app_private.order_outcome_import_batches WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_batches = ROW_COUNT;

    PERFORM set_config('app.order_data_deletion_active', 'off', true);
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('app.order_data_deletion_active', 'off', true);
      RAISE;
  END;

  RETURN QUERY SELECT v_batches, v_lines, v_quarantine, v_conflicts;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) FROM peekaplate_runtime;
GRANT EXECUTE ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) TO peekaplate_deletion_operator;

-- H2: Operator-only helper to list DB deletion records for DB-to-R2 missing_in_r2 reconciliation (no order rows/CSV data)
CREATE OR REPLACE FUNCTION app_private.list_order_deletion_requests_for_reconcile()
RETURNS TABLE (
  tenant_id uuid,
  id uuid,
  status text,
  executed_by uuid,
  completed_at timestamptz
)
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  IF app_private.is_runtime_role(session_user) THEN
    RAISE EXCEPTION 'Runtime role % cannot execute list_order_deletion_requests_for_reconcile', session_user;
  END IF;
  IF NOT (
    pg_has_role(session_user, 'peekaplate_deletion_operator', 'member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper)
  ) THEN
    RAISE EXCEPTION 'Session role % is not authorized to list order deletion requests for reconciliation', session_user;
  END IF;
  RETURN QUERY
  SELECT r.tenant_id, r.id, r.status, r.executed_by, r.completed_at
  FROM app_private.order_data_deletion_requests r
  WHERE r.status IN ('db_deleted', 'awaiting_verification', 'verified');
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.list_order_deletion_requests_for_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_order_deletion_requests_for_reconcile() TO peekaplate_deletion_operator;

-- L2: Safe bounded tenant discovery for scheduled durable orphan-cleanup retries (no CSV/PII data)
CREATE OR REPLACE FUNCTION app_private.list_pending_orphan_cleanup_tenants()
RETURNS TABLE (tenant_id uuid)
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT c.tenant_id
  FROM app_private.order_import_orphan_cleanups c
  WHERE c.status = 'pending'
  ORDER BY c.tenant_id
  LIMIT 100;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app_private.list_pending_orphan_cleanup_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_pending_orphan_cleanup_tenants() TO peekaplate_runtime, peekaplate_deletion_operator;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'S6-DATA-14 hardening rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
