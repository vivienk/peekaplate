-- migrate:up
ALTER TABLE app_private.menu_ingestion_jobs DROP CONSTRAINT menu_ingestion_jobs_status_check;
ALTER TABLE app_private.menu_ingestion_jobs ADD CONSTRAINT menu_ingestion_jobs_status_check
  CHECK (status IN ('queued', 'running', 'complete', 'incomplete', 'failed', 'cancelled'));
ALTER TABLE app_private.menu_ingestion_jobs ADD COLUMN upload_group_id uuid;
ALTER TABLE app_private.menu_ingestion_jobs ADD COLUMN upload_index integer CHECK (upload_index BETWEEN 0 AND 4);
ALTER TABLE app_private.menu_ingestion_jobs ADD COLUMN source_uploaded boolean NOT NULL DEFAULT true;
ALTER TABLE app_private.menu_ingestion_jobs ADD COLUMN source_provenance jsonb CHECK (source_provenance IS NULL OR jsonb_typeof(source_provenance)='object');
ALTER TABLE app_private.menu_ingestion_jobs ADD CONSTRAINT upload_group_order
  CHECK ((upload_group_id IS NULL) = (upload_index IS NULL));
CREATE UNIQUE INDEX menu_ingestion_group_order ON app_private.menu_ingestion_jobs(tenant_id, upload_group_id, upload_index);

CREATE TABLE app_private.menu_upload_group (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id),
  id uuid NOT NULL,
  idempotency_key text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array' AND jsonb_array_length(manifest) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE app_private.menu_ingestion_jobs ADD CONSTRAINT upload_group_fk
  FOREIGN KEY (tenant_id, upload_group_id) REFERENCES app_private.menu_upload_group(tenant_id, id);

ALTER TABLE app_private.dish_drafts ADD COLUMN origin text NOT NULL DEFAULT 'extracted' CHECK (origin IN ('extracted', 'manual'));
ALTER TABLE app_private.dish_drafts ADD COLUMN draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0);
ALTER TABLE app_private.dish_drafts ADD COLUMN manual_fields jsonb CHECK (manual_fields IS NULL OR jsonb_typeof(manual_fields) = 'object');
ALTER TABLE app_private.dish_drafts ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE app_private.dish_drafts ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE app_private.dish_drafts ALTER COLUMN source_text DROP NOT NULL;
ALTER TABLE app_private.dish_drafts ALTER COLUMN name DROP NOT NULL;
ALTER TABLE app_private.dish_drafts ADD CONSTRAINT draft_origin_evidence CHECK (
  (origin = 'extracted' AND job_id IS NOT NULL AND source_id IS NOT NULL AND source_text IS NOT NULL AND name IS NOT NULL AND manual_fields IS NULL)
  OR (origin = 'manual' AND job_id IS NULL AND source_id IS NULL AND source_text IS NULL AND manual_fields IS NOT NULL)
);
ALTER TABLE app_private.dish_drafts ADD CONSTRAINT dish_draft_tenant_identity UNIQUE (tenant_id, id);
ALTER TABLE app_private.dish_current ADD COLUMN approved_facts jsonb CHECK (approved_facts IS NULL OR jsonb_typeof(approved_facts) = 'object');

CREATE TABLE app_private.dish_draft_photo (
  tenant_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 12000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, draft_id, source_hash),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES app_private.dish_drafts(tenant_id, id)
);

ALTER TABLE app_private.menu_upload_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_upload_group FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_upload_group_tenant ON app_private.menu_upload_group
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE app_private.dish_draft_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.dish_draft_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY dish_draft_photo_tenant ON app_private.dish_draft_photo
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app_private.menu_upload_group, app_private.dish_draft_photo TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Owner menu workspace requires a forward corrective migration.'; END $$;
