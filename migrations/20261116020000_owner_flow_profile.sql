-- migrate:up
ALTER TABLE app_private.dish_drafts ADD COLUMN removed_at timestamptz,
  ADD COLUMN removal_version integer NOT NULL DEFAULT 0 CHECK (removal_version >= 0);
CREATE TABLE app_private.restaurant_profile_photo (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id),
  id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 12000000),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_hash)
);
CREATE TABLE app_private.restaurant_profile (
  tenant_id uuid PRIMARY KEY REFERENCES app_private.venues(id),
  version integer NOT NULL CHECK (version > 0),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Owners can submit details, but only the team's trusted verification path can mark them verified.
CREATE FUNCTION app_private.reset_restaurant_profile_verification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.fields IS DISTINCT FROM OLD.fields THEN NEW.status := 'submitted'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.reset_restaurant_profile_verification() FROM PUBLIC;
CREATE TRIGGER restaurant_profile_recheck BEFORE UPDATE OF fields ON app_private.restaurant_profile
  FOR EACH ROW EXECUTE FUNCTION app_private.reset_restaurant_profile_verification();
ALTER TABLE app_private.restaurant_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.restaurant_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_profile_tenant ON app_private.restaurant_profile
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE app_private.restaurant_profile_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.restaurant_profile_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_profile_photo_tenant ON app_private.restaurant_profile_photo
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON app_private.restaurant_profile,app_private.restaurant_profile_photo TO peekaplate_runtime;
GRANT INSERT(tenant_id,version,fields), UPDATE(version,fields,updated_at)
  ON app_private.restaurant_profile TO peekaplate_runtime;
GRANT INSERT ON app_private.restaurant_profile_photo TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Owner profiles require a forward corrective migration.'; END $$;
