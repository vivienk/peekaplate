-- migrate:up
-- S6-DATA-14.1 & S6-DATA-14.2:
-- 1. Server-side tenant-scoped pilot order-outcome agreement acceptance ledger
-- 2. Auditable owner-scoped order-data deletion request ledger and privileged SECURITY DEFINER purge function

CREATE TABLE app_private.pilot_order_agreement_acceptances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  agreement_version text NOT NULL CHECK (length(btrim(agreement_version)) > 0 AND length(agreement_version) <= 64),
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agreement_version)
);

CREATE OR REPLACE FUNCTION app_private.enforce_pilot_order_agreement_acceptance()
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
    RAISE EXCEPTION 'Trusted tenant context (app.tenant_id) must match acceptance tenant_id';
  END IF;

  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');
  IF session_actor IS NULL OR session_actor <> NEW.accepted_by::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match accepted_by';
  END IF;

  SELECT permission INTO session_permission
  FROM app_private.staff_membership
  WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.accepted_by;

  IF session_permission IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an authorized venue owner may accept the pilot order-outcome agreement';
  END IF;

  NEW.accepted_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pilot_order_agreement_acceptance_enforcement
  BEFORE INSERT ON app_private.pilot_order_agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_pilot_order_agreement_acceptance();

CREATE TRIGGER pilot_order_agreement_acceptances_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.pilot_order_agreement_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.pilot_order_agreement_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.pilot_order_agreement_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY pilot_order_agreement_acceptances_tenant_scope ON app_private.pilot_order_agreement_acceptances
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX pilot_order_agreement_acceptances_tenant_version_idx
  ON app_private.pilot_order_agreement_acceptances (tenant_id, agreement_version);

-- Minimal audit log for owner-scoped order-data deletion requests (stores no order contents or diner data)
-- Composite primary key (tenant_id, id) prevents cross-tenant requestId collisions or existence disclosure.
CREATE TABLE app_private.order_data_deletion_requests (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  requested_by uuid NOT NULL,
  executed_by uuid,
  reason text CHECK (
    reason IS NULL OR reason IN (
      'pilot_withdrawal',
      'data_cleanup',
      'retention_policy_request'
    )
  ),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'executing', 'r2_deleted', 'completed', 'failed')),
  r2_objects_deleted integer NOT NULL DEFAULT 0 CHECK (r2_objects_deleted >= 0),
  db_batches_deleted integer NOT NULL DEFAULT 0 CHECK (db_batches_deleted >= 0),
  db_lines_deleted integer NOT NULL DEFAULT 0 CHECK (db_lines_deleted >= 0),
  db_quarantine_deleted integer NOT NULL DEFAULT 0 CHECK (db_quarantine_deleted >= 0),
  db_conflicts_deleted integer NOT NULL DEFAULT 0 CHECK (db_conflicts_deleted >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
  requested_at timestamptz NOT NULL DEFAULT now(),
  execution_token uuid,
  execution_started_at timestamptz,
  execution_lease_expires_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND executed_by IS NOT NULL))
);

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
  IF session_actor IS NULL OR session_actor <> NEW.requested_by::text THEN
    RAISE EXCEPTION 'Trusted actor context (app.actor_id) must match requested_by';
  END IF;

  SELECT permission INTO session_permission
  FROM app_private.staff_membership
  WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.requested_by;

  IF session_permission IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an authorized venue owner may submit an order data deletion request';
  END IF;

  IF NEW.status <> 'requested' OR NEW.executed_by IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'New deletion requests must start in requested state without completion fields';
  END IF;

  NEW.requested_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_data_deletion_requests_insert_enforcement
  BEFORE INSERT ON app_private.order_data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_order_data_deletion_request_insert();

CREATE OR REPLACE FUNCTION app_private.enforce_order_data_deletion_request_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Deleting or truncating order data deletion audit records is prohibited';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR
       NEW.tenant_id <> OLD.tenant_id OR
       NEW.requested_by <> OLD.requested_by OR
       NEW.requested_at <> OLD.requested_at OR
       NEW.reason IS DISTINCT FROM OLD.reason THEN
      RAISE EXCEPTION 'Mutation of immutable deletion audit provenance fields is prohibited';
    END IF;

    IF OLD.status = 'completed' AND (
      NEW.status <> OLD.status OR
      NEW.executed_by IS DISTINCT FROM OLD.executed_by OR
      NEW.r2_objects_deleted <> OLD.r2_objects_deleted OR
      NEW.db_batches_deleted <> OLD.db_batches_deleted OR
      NEW.db_lines_deleted <> OLD.db_lines_deleted OR
      NEW.db_quarantine_deleted <> OLD.db_quarantine_deleted OR
      NEW.db_conflicts_deleted <> OLD.db_conflicts_deleted OR
      NEW.completed_at IS DISTINCT FROM OLD.completed_at
    ) THEN
      RAISE EXCEPTION 'Completed deletion audit records are immutable';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_data_deletion_requests_lifecycle
  BEFORE UPDATE OR DELETE ON app_private.order_data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_order_data_deletion_request_lifecycle();

CREATE TRIGGER order_data_deletion_requests_no_truncate
  BEFORE TRUNCATE ON app_private.order_data_deletion_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.order_data_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_data_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY order_data_deletion_requests_tenant_scope ON app_private.order_data_deletion_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX order_data_deletion_requests_tenant_requested_idx
  ON app_private.order_data_deletion_requests (tenant_id, requested_at DESC);

CREATE INDEX order_data_deletion_requests_tenant_active_idx
  ON app_private.order_data_deletion_requests (tenant_id, status)
  WHERE status IN ('requested', 'executing', 'r2_deleted', 'failed');

-- Narrowly permit DELETE on order outcome tables ONLY inside app_private.delete_venue_order_data()
-- Requires BOTH privileged function owner context (not peekaplate_runtime) AND transaction-local GUC.
CREATE OR REPLACE FUNCTION app_private.reject_order_outcome_append_only_unless_authorized_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user <> 'peekaplate_runtime'
     AND current_setting('app.order_data_deletion_active', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_private.enforce_order_outcome_batch_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user <> 'peekaplate_runtime'
       AND current_setting('app.order_data_deletion_active', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Deleting or truncating order outcome import batches is prohibited';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Deleting or truncating order outcome import batches is prohibited';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR
       NEW.tenant_id <> OLD.tenant_id OR
       NEW.schema_version <> OLD.schema_version OR
       NEW.file_sha256 <> OLD.file_sha256 OR
       NEW.created_by <> OLD.created_by OR
       NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Mutation of immutable import batch provenance fields is prohibited';
    END IF;

    IF OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'processing', 'failed') THEN
      RAISE EXCEPTION 'Invalid batch status transition from queued to %', NEW.status;
    ELSIF OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'completed', 'failed') THEN
      RAISE EXCEPTION 'Invalid batch status transition from processing to %', NEW.status;
    ELSIF OLD.status IN ('completed', 'failed') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'Cannot modify status of terminal import batch (current status: %)', OLD.status;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER order_outcome_lines_append_only ON app_private.order_outcome_lines;
CREATE TRIGGER order_outcome_lines_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_order_outcome_append_only_unless_authorized_deletion();

DROP TRIGGER order_outcome_quarantine_append_only ON app_private.order_outcome_quarantine;
CREATE TRIGGER order_outcome_quarantine_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_order_outcome_append_only_unless_authorized_deletion();

DROP TRIGGER order_outcome_conflicts_append_only ON app_private.order_outcome_conflicts;
CREATE TRIGGER order_outcome_conflicts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_order_outcome_append_only_unless_authorized_deletion();

-- Reviewed privileged deletion function for one venue's order data (operator-invoked)
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

  IF request_status = 'completed' THEN
    RAISE EXCEPTION 'Deletion audit request % is already completed', p_request_id;
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
REVOKE ALL ON FUNCTION app_private.enforce_pilot_order_agreement_acceptance() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.enforce_order_data_deletion_request_insert() FROM PUBLIC;
GRANT SELECT, INSERT ON app_private.pilot_order_agreement_acceptances TO peekaplate_runtime;
GRANT SELECT, INSERT, UPDATE ON app_private.order_data_deletion_requests TO peekaplate_runtime;
GRANT EXECUTE ON FUNCTION app_private.delete_venue_order_data(uuid, uuid, uuid, uuid) TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Pilot order agreement and deletion rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
