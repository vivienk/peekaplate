-- migrate:up
CREATE TABLE app_private.menu_review_subject (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  menu_id uuid NOT NULL,
  menu_revision_id uuid NOT NULL,
  content_approval_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  asset_approval_id uuid NOT NULL,
  asset_manifest_hash text NOT NULL CHECK (asset_manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, menu_id, menu_revision_id),
  UNIQUE (
    tenant_id,
    menu_id,
    menu_revision_id,
    content_approval_id,
    content_hash,
    asset_approval_id,
    asset_manifest_hash
  )
);

CREATE TABLE app_private.menu_approval (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  approval_id uuid NOT NULL,
  menu_id uuid NOT NULL,
  review_version integer NOT NULL CHECK (review_version > 0),
  menu_revision_id uuid NOT NULL,
  content_approval_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  asset_approval_id uuid NOT NULL,
  asset_manifest_hash text NOT NULL CHECK (asset_manifest_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, approval_id),
  UNIQUE (tenant_id, menu_id, review_version),
  UNIQUE (tenant_id, menu_id, approval_id),
  FOREIGN KEY (
    tenant_id,
    menu_id,
    menu_revision_id,
    content_approval_id,
    content_hash,
    asset_approval_id,
    asset_manifest_hash
  ) REFERENCES app_private.menu_review_subject (
    tenant_id,
    menu_id,
    menu_revision_id,
    content_approval_id,
    content_hash,
    asset_approval_id,
    asset_manifest_hash
  ) ON DELETE RESTRICT
);

CREATE TABLE app_private.menu_review_current (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  menu_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  approval_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, menu_id),
  FOREIGN KEY (tenant_id, menu_id, approval_id)
    REFERENCES app_private.menu_approval(tenant_id, menu_id, approval_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.menu_publication_current (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  menu_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  publication_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  publication_hash text NOT NULL CHECK (publication_hash ~ '^[0-9a-f]{64}$'),
  availability_version integer NOT NULL CHECK (availability_version > 0),
  status text NOT NULL CHECK (status IN ('published', 'withdrawn')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, menu_id),
  UNIQUE (tenant_id, publication_id),
  FOREIGN KEY (tenant_id, menu_id, approval_id)
    REFERENCES app_private.menu_approval(tenant_id, menu_id, approval_id) ON DELETE RESTRICT
);

CREATE TRIGGER menu_review_subject_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.menu_review_subject
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();
CREATE TRIGGER menu_approval_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.menu_approval
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.menu_review_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_review_subject FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_review_subject_tenant_scope ON app_private.menu_review_subject
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.menu_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_approval_tenant_scope ON app_private.menu_approval
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.menu_review_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_review_current FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_review_current_tenant_scope ON app_private.menu_review_current
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app_private.menu_publication_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.menu_publication_current FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_publication_current_tenant_scope ON app_private.menu_publication_current
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON app_private.menu_review_subject TO peekaplate_runtime;
GRANT SELECT, INSERT ON app_private.menu_approval TO peekaplate_runtime;
GRANT SELECT, INSERT, UPDATE ON app_private.menu_review_current TO peekaplate_runtime;
GRANT SELECT, INSERT, UPDATE ON app_private.menu_publication_current TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Menu publication rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
