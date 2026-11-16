-- migrate:up
CREATE TABLE app_private.restaurant_profile_current (
  tenant_id uuid PRIMARY KEY REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  details jsonb NOT NULL,
  logo jsonb
);
ALTER TABLE app_private.restaurant_profile_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.restaurant_profile_current FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_profile_tenant_scope ON app_private.restaurant_profile_current
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app_private.restaurant_profile_current TO peekaplate_runtime;
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Use a forward corrective migration for restaurant profile history.'; END $$;
