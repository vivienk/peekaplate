-- migrate:up
CREATE TABLE app_private.owner_insight_action_current (
  tenant_id uuid NOT NULL REFERENCES app_private.venues(id) ON DELETE RESTRICT,
  action_id uuid NOT NULL,
  insight_key text NOT NULL
    CHECK (
      length(insight_key) BETWEEN 1 AND 128
      AND insight_key = btrim(insight_key)
      AND insight_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  menu_id uuid NOT NULL,
  menu_revision_id uuid NOT NULL,
  category text NOT NULL
    CHECK (category IN ('price_adjustment', 'item_rearrangement', 'description_update', 'promotion')),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'archived')),
  note text
    CHECK (
      note IS NULL
      OR (length(note) BETWEEN 1 AND 500 AND note = btrim(note))
    ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_id),
  FOREIGN KEY (tenant_id, menu_id, menu_revision_id)
    REFERENCES app_private.menu_review_subject
      (tenant_id, menu_id, menu_revision_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

ALTER TABLE app_private.owner_insight_action_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.owner_insight_action_current FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_insight_action_tenant_scope
  ON app_private.owner_insight_action_current
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE
  ON app_private.owner_insight_action_current TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Owner insight action rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
