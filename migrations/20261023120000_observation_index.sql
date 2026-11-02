-- migrate:up
-- ADR 0015 canonical observation identity. The Queue consumer writes these rows after the
-- create-only R2 archive; owner reports read later typed fact views, never this index.
-- tenant_id is the server-derived venue_id, named to match the existing RLS setting.
CREATE TABLE app_private.observation_index (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  canonical_payload_checksum text NOT NULL CHECK (canonical_payload_checksum ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version = 'observation.v2'),
  event_type text NOT NULL CHECK (event_type IN (
    'menu_viewed', 'dish_viewed', 'dish_detail_opened', 'dish_detail_closed',
    'dish_activity_checkpoint', 'dish_compared', 'dish_saved', 'dish_unsaved', 'shortlist_viewed'
  )),
  authorized_publication_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  first_received_at timestamptz NOT NULL,
  r2_archive_key text NOT NULL CHECK (length(r2_archive_key) BETWEEN 1 AND 1024),
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  reason_code text CHECK (reason_code IN (
    'schema_invalid', 'unknown_type', 'too_old', 'future_time', 'publication_not_allowed'
  )),
  PRIMARY KEY (tenant_id, event_id),
  CHECK ((disposition = 'rejected') = (reason_code IS NOT NULL)),
  -- Accepted items passed the ingest time window when the Worker first received them.
  CHECK (disposition <> 'accepted' OR (
    occurred_at >= first_received_at - interval '24 hours'
    AND occurred_at <= first_received_at + interval '5 minutes'
  ))
);

-- Conflicting reuse of an indexed (tenant_id, event_id) is quarantined here and never replaces
-- the original. The raw payload stays in R2; a repeated delivery of the same conflict is unique.
CREATE TABLE app_private.observation_conflict (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  incoming_checksum text NOT NULL CHECK (incoming_checksum ~ '^[0-9a-f]{64}$'),
  r2_archive_key text NOT NULL CHECK (length(r2_archive_key) BETWEEN 1 AND 1024),
  received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id, incoming_checksum)
);

CREATE TRIGGER observation_index_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.observation_index
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();
CREATE TRIGGER observation_conflict_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.observation_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.observation_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.observation_index FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_index_tenant_scope ON app_private.observation_index
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.observation_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.observation_conflict FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_conflict_tenant_scope ON app_private.observation_conflict
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON app_private.observation_index, app_private.observation_conflict FROM PUBLIC;
GRANT SELECT, INSERT ON app_private.observation_index, app_private.observation_conflict
  TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Observation index rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
