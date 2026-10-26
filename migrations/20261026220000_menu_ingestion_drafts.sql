-- migrate:up
CREATE TABLE app_private.menu_ingestion_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('url', 'pdf', 'photo', 'text')),
  source_url text CHECK (source_url IS NULL OR length(btrim(source_url)) > 0),
  source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
  source_storage_key text CHECK (source_storage_key IS NULL OR length(btrim(source_storage_key)) > 0),
  result_storage_key text CHECK (result_storage_key IS NULL OR length(btrim(result_storage_key)) > 0),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'incomplete', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  claim_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  locked_at timestamptz,
  locked_by text CHECK (locked_by IS NULL OR length(btrim(locked_by)) > 0),
  error_code text CHECK (error_code IS NULL OR length(btrim(error_code)) > 0),
  error_details text CHECK (error_details IS NULL OR length(btrim(error_details)) > 0),
  draft_count integer NOT NULL DEFAULT 0 CHECK (draft_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (status != 'running' OR started_at IS NOT NULL),
  CHECK (status NOT IN ('complete', 'incomplete', 'failed') OR finished_at IS NOT NULL),
  CHECK (status != 'running' OR claim_token IS NOT NULL)
);

CREATE INDEX menu_ingestion_jobs_tenant_status_idx
  ON app_private.menu_ingestion_jobs (tenant_id, status, created_at DESC);

CREATE INDEX menu_ingestion_jobs_recovery_idx
  ON app_private.menu_ingestion_jobs (status, locked_at)
  WHERE status = 'running';

CREATE TABLE app_private.dish_drafts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  draft_id text NOT NULL CHECK (length(btrim(draft_id)) > 0),
  draft_index integer NOT NULL CHECK (draft_index >= 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 160),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  category text CHECK (category IS NULL OR length(btrim(category)) > 0),
  price_amount numeric CHECK (price_amount IS NULL OR price_amount >= 0),
  price_currency text CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
  ingredients jsonb CHECK (ingredients IS NULL OR jsonb_typeof(ingredients) = 'array'),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_text text NOT NULL CHECK (length(btrim(source_text)) > 0),
  image_id text CHECK (image_id IS NULL OR length(btrim(image_id)) > 0),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  review_warnings text[] NOT NULL DEFAULT '{}'::text[],
  extraction_status text NOT NULL DEFAULT 'needs_review' CHECK (extraction_status = 'needs_review'),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'accepted', 'rejected', 'edited', 'superseded')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  published_dish_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id, draft_index),
  UNIQUE (tenant_id, job_id, draft_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES app_private.menu_ingestion_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, published_dish_id) REFERENCES app_private.dish_current(tenant_id, dish_id) ON DELETE SET NULL (published_dish_id),
  CHECK (review_status NOT IN ('pending', 'superseded') OR (published_dish_id IS NULL)),
  CHECK (review_status != 'pending' OR (reviewed_at IS NULL AND reviewed_by IS NULL)),
  CHECK (review_status NOT IN ('accepted', 'rejected', 'edited') OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CHECK (published_dish_id IS NULL OR review_status IN ('accepted', 'edited'))
);

CREATE INDEX dish_drafts_tenant_job_idx
  ON app_private.dish_drafts (tenant_id, job_id, draft_index);

CREATE INDEX dish_drafts_tenant_review_idx
  ON app_private.dish_drafts (tenant_id, review_status, created_at);

ALTER TABLE app_private.menu_ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_ingestion_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_ingestion_jobs_tenant_scope ON app_private.menu_ingestion_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.dish_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.dish_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY dish_drafts_tenant_scope ON app_private.dish_drafts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON app_private.menu_ingestion_jobs TO peekaplate_runtime;
GRANT SELECT, INSERT, UPDATE ON app_private.dish_drafts TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Menu ingestion rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
