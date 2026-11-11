-- migrate:up
CREATE TABLE app_private.extraction_review_session (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  extraction_id text NOT NULL CHECK (length(btrim(extraction_id)) > 0 AND length(extraction_id) <= 128),
  schema_version integer NOT NULL CHECK (schema_version IN (1, 2)),
  pipeline_version text NOT NULL CHECK (pipeline_version IN ('2', '3')),
  extraction_status text NOT NULL CHECK (extraction_status IN ('complete', 'incomplete', 'failed')),
  source_id text NOT NULL CHECK (source_id = 'sha256:' || source_sha256),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  job_id uuid,
  private_artifact_key text CHECK (private_artifact_key IS NULL OR length(btrim(private_artifact_key)) > 0),
  private_artifact_sha256 text CHECK (private_artifact_sha256 IS NULL OR private_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, extraction_id),
  CHECK ((schema_version = 1 AND pipeline_version = '2') OR (schema_version = 2 AND pipeline_version = '3')),
  CHECK ((private_artifact_key IS NULL) = (private_artifact_sha256 IS NULL))
);

CREATE TRIGGER extraction_review_session_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.extraction_review_session
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

CREATE TABLE app_private.candidate_review_current (
  tenant_id uuid NOT NULL,
  extraction_id text NOT NULL,
  candidate_id text NOT NULL CHECK (length(btrim(candidate_id)) > 0 AND length(candidate_id) <= 128),
  stream_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  revision_id uuid NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('corrected', 'rejected', 'incomplete')),
  corrected_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(corrected_fields) = 'object'),
  edited_fields text[] NOT NULL DEFAULT '{}'::text[],
  incomplete_fields text[] NOT NULL DEFAULT '{}'::text[],
  review_note text CHECK (review_note IS NULL OR length(btrim(review_note)) > 0),
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, extraction_id, candidate_id),
  UNIQUE (tenant_id, revision_id),
  UNIQUE (tenant_id, stream_id),
  FOREIGN KEY (tenant_id, extraction_id) REFERENCES app_private.extraction_review_session(tenant_id, extraction_id) ON DELETE RESTRICT,
  CHECK (review_status != 'rejected' OR (corrected_fields = '{}'::jsonb AND cardinality(edited_fields) = 0)),
  CHECK (review_status != 'incomplete' OR cardinality(incomplete_fields) > 0),
  CHECK (review_status != 'corrected' OR cardinality(edited_fields) > 0)
);

ALTER TABLE app_private.extraction_review_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.extraction_review_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_tenant_scope ON app_private.extraction_review_session
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.candidate_review_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.candidate_review_current FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_review_tenant_scope ON app_private.candidate_review_current
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON app_private.extraction_review_session TO peekaplate_runtime;
GRANT SELECT, INSERT, UPDATE ON app_private.candidate_review_current TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Review candidate persistence rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
