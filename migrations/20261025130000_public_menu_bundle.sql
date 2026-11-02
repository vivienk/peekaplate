-- migrate:up
CREATE TABLE app_private.public_menu_bundle (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  menu_id uuid NOT NULL,
  menu_revision_id uuid NOT NULL,
  bundle_url text NOT NULL CHECK (bundle_url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, menu_id, menu_revision_id),
  FOREIGN KEY (tenant_id, menu_id, menu_revision_id)
    REFERENCES app_private.menu_review_subject(tenant_id, menu_id, menu_revision_id)
    ON DELETE RESTRICT
);

CREATE TRIGGER public_menu_bundle_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.public_menu_bundle
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.public_menu_bundle ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.public_menu_bundle FORCE ROW LEVEL SECURITY;
CREATE POLICY public_menu_bundle_tenant_scope ON app_private.public_menu_bundle
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON app_private.public_menu_bundle TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Public menu bundle rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
