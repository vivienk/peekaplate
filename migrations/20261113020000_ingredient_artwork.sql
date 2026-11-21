-- migrate:up
-- Decorative artwork only; never an ingredient, allergen or menu approval.
CREATE TABLE app_private.ingredient_artwork_current (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  stream_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('approved', 'revoked')),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, label),
  UNIQUE (tenant_id, stream_id),
  CHECK ((status = 'approved') = (sha256 IS NOT NULL))
);
ALTER TABLE app_private.ingredient_artwork_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.ingredient_artwork_current FORCE ROW LEVEL SECURITY;
CREATE POLICY ingredient_artwork_tenant_scope ON app_private.ingredient_artwork_current
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app_private.ingredient_artwork_current TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Use a forward corrective migration for artwork history.'; END $$;
