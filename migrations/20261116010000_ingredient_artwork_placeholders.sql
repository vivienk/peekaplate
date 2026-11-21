-- migrate:up
-- One row per ingredient label a venue's extracted menu has used, recorded when
-- the OCR pipeline saves drafts. A placeholder only means "artwork may be
-- needed": it carries no image, approves nothing and never changes a recipe,
-- allergen or menu. Artwork review stays in ingredient_artwork_current.
CREATE TABLE app_private.ingredient_artwork_placeholder (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120 AND label = lower(btrim(label))),
  first_job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, label)
);
ALTER TABLE app_private.ingredient_artwork_placeholder ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.ingredient_artwork_placeholder FORCE ROW LEVEL SECURITY;
CREATE POLICY ingredient_artwork_placeholder_tenant_scope ON app_private.ingredient_artwork_placeholder
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Insert-only for the runtime: a placeholder is never edited or removed by requests.
GRANT SELECT, INSERT ON app_private.ingredient_artwork_placeholder TO peekaplate_runtime;

-- migrate:down
DROP TABLE app_private.ingredient_artwork_placeholder;
