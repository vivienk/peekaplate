-- migrate:up
-- Explicit operator onboarding only. No restaurant, menu or order is seeded by this migration.
CREATE TABLE app_private.dining_location (
 location_id text PRIMARY KEY CHECK (location_id ~ '^[a-z0-9-]{1,80}$'),
 venue_id uuid NOT NULL REFERENCES app_private.venues(id), menu_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE app_private.dining_catalog (
 tenant_id uuid NOT NULL REFERENCES app_private.venues(id), menu_id uuid NOT NULL,
 publication_id uuid NOT NULL, menu jsonb NOT NULL CHECK(jsonb_typeof(menu)='object'),
 PRIMARY KEY(tenant_id,menu_id)
);
CREATE TABLE app_private.dining_order (
 tenant_id uuid NOT NULL REFERENCES app_private.venues(id), order_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), receipt jsonb NOT NULL, lines jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,order_id)
);
ALTER TABLE app_private.dining_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.dining_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_catalog_tenant ON app_private.dining_catalog
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE app_private.dining_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.dining_order FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_order_tenant ON app_private.dining_order
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON app_private.dining_location, app_private.dining_catalog TO peekaplate_runtime;
GRANT UPDATE(enabled) ON app_private.dining_location TO peekaplate_runtime;
GRANT UPDATE(menu) ON app_private.dining_catalog TO peekaplate_runtime;
GRANT SELECT,INSERT ON app_private.dining_order TO peekaplate_runtime;
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Use a forward corrective migration; order history must be retained.'; END; $$;
