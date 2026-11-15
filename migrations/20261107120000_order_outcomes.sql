-- migrate:up
-- S5-DATA-07: Controlled Pilot Order-Outcome Import
-- Dedicated order outcome persistence domain, completely decoupled from diner interaction observations.
-- All tables reside in app_private, enforce tenant isolation via forced RLS, and use append-only trigger protection.

CREATE TABLE app_private.order_outcome_import_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  schema_version text NOT NULL CHECK (schema_version = 'pilot_order_outcome.v1'),
  source_filename text NOT NULL CHECK (length(btrim(source_filename)) > 0 AND length(source_filename) <= 255),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL CHECK (length(btrim(storage_key)) > 0 AND length(storage_key) <= 1024),
  total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  accepted_rows integer NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  duplicate_rows integer NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  quarantined_rows integer NOT NULL DEFAULT 0 CHECK (quarantined_rows >= 0),
  conflict_rows integer NOT NULL DEFAULT 0 CHECK (conflict_rows >= 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, file_sha256),
  UNIQUE (tenant_id, id),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (status != 'completed' OR finished_at IS NOT NULL)
);

CREATE TABLE app_private.order_outcome_lines (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  order_id text NOT NULL CHECK (order_id ~ '^[A-Za-z0-9_\-\.:]{1,128}$'),
  order_line_id text NOT NULL CHECK (order_line_id ~ '^[A-Za-z0-9_\-\.:]{1,128}$'),
  batch_id uuid NOT NULL,
  ordered_at timestamptz NOT NULL,
  menu_revision_id uuid NOT NULL,
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  outcome_type text NOT NULL CHECK (outcome_type IN ('ordered', 'refunded', 'voided')),
  quantity integer NOT NULL CHECK (quantity >= 1 AND quantity <= 999),
  unit_price numeric(10, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  payload_checksum text NOT NULL CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id, order_line_id, outcome_type),
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES app_private.order_outcome_import_batches(tenant_id, id)
    ON DELETE RESTRICT,
  CHECK ((unit_price IS NULL) = (currency IS NULL))
);

CREATE TABLE app_private.order_outcome_quarantine (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index >= 1),
  reason_code text NOT NULL CHECK (reason_code IN (
    'malformed_row',
    'missing_required_field',
    'invalid_format',
    'unmatched_dish',
    'ambiguous_dish_match',
    'missing_pos_identifier',
    'missing_pos_mapping',
    'unreviewed_pos_mapping',
    'missing_tracking_start_evidence',
    'before_tracking_start',
    'out_of_revision_window',
    'unsupported_menu_revision',
    'unsupported_dish_revision',
    'future_timestamp',
    'too_old',
    'cross_venue_forbidden',
    'prohibited_identifier',
    'schema_version_unsupported',
    'unexpected_header',
    'price_currency_mismatch',
    'payload_too_large',
    'empty_file',
    'duplicate_line_in_batch',
    'conflict_in_batch'
  )),
  field_name text CHECK (field_name IS NULL OR length(field_name) <= 64),
  diagnostic_message text NOT NULL CHECK (length(diagnostic_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES app_private.order_outcome_import_batches(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE app_private.order_outcome_conflicts (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  order_id text NOT NULL,
  order_line_id text NOT NULL,
  outcome_type text NOT NULL CHECK (outcome_type IN ('ordered', 'refunded', 'voided')),
  batch_id uuid NOT NULL,
  existing_checksum text NOT NULL CHECK (existing_checksum ~ '^[0-9a-f]{64}$'),
  incoming_checksum text NOT NULL CHECK (incoming_checksum ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id, order_line_id, outcome_type, incoming_checksum),
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES app_private.order_outcome_import_batches(tenant_id, id)
    ON DELETE RESTRICT
);

-- Reviewed POS dish mapping: maps restaurant POS item codes to canonical PeekaPlate dishes
-- Enforces that approved mappings have verified reviewer provenance and authorized reviewer role
CREATE TABLE app_private.pos_dish_mappings (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  pos_item_code text NOT NULL CHECK (length(btrim(pos_item_code)) > 0 AND length(pos_item_code) <= 128),
  dish_id uuid NOT NULL,
  dish_name text CHECK (dish_name IS NULL OR length(dish_name) <= 160),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pos_item_code),
  CHECK ((review_status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL) OR (review_status <> 'approved')),
  FOREIGN KEY (tenant_id, reviewed_by)
    REFERENCES app_private.staff_membership(tenant_id, actor_id)
    ON DELETE RESTRICT
);

-- Enforce reviewer authorization and prevent silent mutations on approved mappings
CREATE OR REPLACE FUNCTION app_private.enforce_pos_dish_mapping_review()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  session_actor text;
  session_permission text;
BEGIN
  -- 1. Strictly require authenticated, trusted session actor context (app.actor_id)
  session_actor := NULLIF(btrim(current_setting('app.actor_id', true)), '');
  IF session_actor IS NULL THEN
    RAISE EXCEPTION 'Trusted session actor context (app.actor_id) is required';
  END IF;

  IF session_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid actor context (app.actor_id must be a valid UUID)';
  END IF;

  -- 2. Verify acting session actor is an authorized owner or editor for this venue
  SELECT permission INTO session_permission
  FROM app_private.staff_membership
  WHERE tenant_id = NEW.tenant_id AND actor_id = session_actor::uuid;

  IF session_permission IS NULL OR session_permission NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Current actor is not authorized to create or modify POS dish mappings';
  END IF;

  -- 3. Reviewer identity binding and status invariant
  IF NEW.review_status = 'approved' THEN
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'Approved POS dish mapping requires reviewed_by and reviewed_at';
    END IF;

    -- Reviewer identity MUST strictly match the authenticated acting session actor
    IF NEW.reviewed_by <> session_actor::uuid THEN
      RAISE EXCEPTION 'Reviewer identity must match the authenticated session actor';
    END IF;
  ELSE
    -- Pending or rejected mappings cannot carry reviewer credentials
    IF NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Unapproved POS dish mapping cannot carry reviewer identity or review timestamp';
    END IF;
  END IF;

  -- 4. Mutation and re-review guard on UPDATE
  IF TG_OP = 'UPDATE' THEN
    -- Modifying mapped dish or code requires re-review; cannot silently retain approved status
    IF (NEW.dish_id <> OLD.dish_id OR NEW.pos_item_code <> OLD.pos_item_code) AND
       NEW.review_status = 'approved' AND
       (OLD.review_status = 'approved' AND NEW.reviewed_at = OLD.reviewed_at) THEN
      RAISE EXCEPTION 'Modifying mapped dish requires re-review; cannot silently retain approved status';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pos_dish_mapping_review_enforcement
  BEFORE INSERT OR UPDATE ON app_private.pos_dish_mappings
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_pos_dish_mapping_review();

-- Venue tracking activation: server-controlled explicit timestamp establishing when live tracking was enabled for a venue
CREATE TABLE app_private.venue_tracking_activations (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NOT NULL,
  source text NOT NULL DEFAULT 'menu_publication' CHECK (source IN ('menu_publication', 'administrative')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

CREATE OR REPLACE FUNCTION app_private.enforce_venue_tracking_activation()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Authoritative timestamp is strictly generated by the server/database.
    -- Reject any attempt by a caller to supply an explicit or non-server timestamp.
    IF NEW.activated_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'Client-supplied activation timestamp is prohibited; server controls activation timestamp';
    END IF;
    NEW.activated_at := now();
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Modifying venue tracking activation timestamp is prohibited';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deleting venue tracking activation record is prohibited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER venue_tracking_activations_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON app_private.venue_tracking_activations
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_venue_tracking_activation();

-- Batch lifecycle enforcement: permits narrow, valid state transitions (processing -> completed/failed)
-- while rejecting record deletions and mutations of immutable provenance columns
CREATE OR REPLACE FUNCTION app_private.enforce_order_outcome_batch_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Deleting or truncating order outcome import batches is prohibited';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Immutable provenance fields cannot be altered
    IF NEW.id <> OLD.id OR
       NEW.tenant_id <> OLD.tenant_id OR
       NEW.schema_version <> OLD.schema_version OR
       NEW.file_sha256 <> OLD.file_sha256 OR
       NEW.created_by <> OLD.created_by OR
       NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Mutation of immutable import batch provenance fields is prohibited';
    END IF;

    -- Valid lifecycle transitions only:
    -- 'queued' -> 'processing' or 'failed'
    -- 'processing' -> 'completed' or 'failed'
    -- 'completed' -> terminal (no transitions permitted)
    -- 'failed' -> terminal (no transitions permitted)
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

CREATE TRIGGER order_outcome_import_batches_lifecycle
  BEFORE UPDATE OR DELETE ON app_private.order_outcome_import_batches
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_order_outcome_batch_lifecycle();

-- Append-only trigger enforcement on immutable fact and diagnostic tables
CREATE TRIGGER order_outcome_lines_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

CREATE TRIGGER order_outcome_quarantine_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

CREATE TRIGGER order_outcome_conflicts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.order_outcome_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

-- Enable & Force Row Level Security across all four tables
ALTER TABLE app_private.order_outcome_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_outcome_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY order_outcome_import_batches_tenant_scope ON app_private.order_outcome_import_batches
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.order_outcome_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_outcome_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY order_outcome_lines_tenant_scope ON app_private.order_outcome_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.order_outcome_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_outcome_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY order_outcome_quarantine_tenant_scope ON app_private.order_outcome_quarantine
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.order_outcome_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.order_outcome_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY order_outcome_conflicts_tenant_scope ON app_private.order_outcome_conflicts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.pos_dish_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.pos_dish_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_dish_mappings_tenant_scope ON app_private.pos_dish_mappings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.venue_tracking_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.venue_tracking_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY venue_tracking_activations_tenant_scope ON app_private.venue_tracking_activations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Query and audit indices
CREATE INDEX order_outcome_import_batches_tenant_status_idx
  ON app_private.order_outcome_import_batches (tenant_id, status, created_at DESC);

CREATE INDEX order_outcome_lines_batch_idx
  ON app_private.order_outcome_lines (tenant_id, batch_id);

CREATE INDEX order_outcome_lines_ordered_at_idx
  ON app_private.order_outcome_lines (tenant_id, ordered_at DESC);

CREATE INDEX order_outcome_quarantine_batch_idx
  ON app_private.order_outcome_quarantine (tenant_id, batch_id);

CREATE INDEX order_outcome_conflicts_batch_idx
  ON app_private.order_outcome_conflicts (tenant_id, batch_id);

-- Privilege grants for peekaplate_runtime
-- Runtime only needs SELECT on pos_dish_mappings for resolution during ingestion;
-- INSERT/UPDATE on pos_dish_mappings is strictly restricted to administrative procedures.
GRANT SELECT, INSERT, UPDATE ON app_private.order_outcome_import_batches TO peekaplate_runtime;
GRANT SELECT, INSERT ON app_private.order_outcome_lines TO peekaplate_runtime;
GRANT SELECT, INSERT ON app_private.order_outcome_quarantine TO peekaplate_runtime;
GRANT SELECT, INSERT ON app_private.order_outcome_conflicts TO peekaplate_runtime;
GRANT SELECT ON app_private.pos_dish_mappings TO peekaplate_runtime;
GRANT SELECT, INSERT ON app_private.venue_tracking_activations TO peekaplate_runtime;
GRANT EXECUTE ON FUNCTION app_private.enforce_venue_tracking_activation() TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Order outcome rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
