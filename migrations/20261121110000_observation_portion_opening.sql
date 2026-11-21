-- migrate:up
ALTER TABLE app_private.observation_index
  DROP CONSTRAINT observation_index_event_type_check,
  ADD CONSTRAINT observation_index_event_type_check CHECK (event_type IN (
    'menu_viewed', 'dish_viewed', 'dish_detail_opened', 'dish_detail_closed',
    'dish_activity_checkpoint', 'dish_compared', 'dish_portion_opened', 'dish_saved',
    'dish_unsaved', 'shortlist_viewed'
  )) NOT VALID;

ALTER TABLE app_private.observation_index VALIDATE CONSTRAINT observation_index_event_type_check;

CREATE TABLE app_private.observation_portion_opening (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_portion_opened' CHECK (event_type = 'dish_portion_opened'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

CREATE TRIGGER observation_portion_opening_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.observation_portion_opening
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();

ALTER TABLE app_private.observation_portion_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.observation_portion_opening FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_portion_opening_tenant_scope ON app_private.observation_portion_opening
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON app_private.observation_portion_opening FROM PUBLIC;
GRANT SELECT, INSERT ON app_private.observation_portion_opening TO peekaplate_runtime;

-- Keep preview evidence independent of the existing engagement and activity views.
CREATE VIEW app_private.owner_portion_opening_v1
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  fact.tenant_id,
  fact.event_id,
  fact.dish_id,
  fact.dish_revision_id,
  event.session_id,
  idx.authorized_publication_id,
  idx.occurred_at
FROM app_private.observation_portion_opening fact
JOIN app_private.observation_event event USING (tenant_id, event_id)
JOIN app_private.observation_index idx USING (tenant_id, event_id)
WHERE event.traffic_class = 'live';

REVOKE ALL ON app_private.owner_portion_opening_v1 FROM PUBLIC;
GRANT SELECT ON app_private.owner_portion_opening_v1 TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Portion opening observation rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
