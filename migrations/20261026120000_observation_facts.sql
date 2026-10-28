-- migrate:up
-- ADR 0015 typed observation facts for the P0 diner events (field table: matrix v0.1g).
-- The Queue consumer writes one observation_event row and one detail row in the same transaction
-- as the accepted observation_index row. Rejected items and quarantined conflicts get no facts.
-- Owner reports read only the owner_* views, which keep live traffic and leave time ranges,
-- privacy floors and metric arithmetic to the report query.

-- Facts may only reference an accepted index row of the same event type.
ALTER TABLE app_private.observation_index
  ADD CONSTRAINT observation_index_typed_identity UNIQUE (tenant_id, event_id, event_type, disposition);

-- Envelope fields that the index does not hold. occurred_at and receipt times stay in the index.
-- traffic_class is server-derived from the menu token; only live traffic reaches owner views.
-- Integer bounds match the ingestion contract's Number.MAX_SAFE_INTEGER limit.
CREATE TABLE app_private.observation_event (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  disposition text NOT NULL DEFAULT 'accepted' CHECK (disposition = 'accepted'),
  session_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  local_sequence bigint NOT NULL CHECK (local_sequence BETWEEN 0 AND 9007199254740991),
  publication_revision_id uuid NOT NULL,
  traffic_class text NOT NULL CHECK (traffic_class IN ('live', 'test', 'demo')),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, event_id, event_type),
  FOREIGN KEY (tenant_id, event_id, event_type, disposition)
    REFERENCES app_private.observation_index (tenant_id, event_id, event_type, disposition)
);

CREATE TABLE app_private.observation_menu_view (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'menu_viewed' CHECK (event_type = 'menu_viewed'),
  entry_source text NOT NULL CHECK (entry_source IN ('qr', 'direct_link', 'unknown')),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

-- A card exposure: at least 50% visible for one continuous second.
CREATE TABLE app_private.observation_exposure (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_viewed' CHECK (event_type = 'dish_viewed'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  exposure_id uuid NOT NULL,
  surface text NOT NULL CHECK (surface = 'menu_list'),
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 9007199254740991),
  exposure_basis text NOT NULL CHECK (exposure_basis = 'viewport_50pct_1s'),
  category_filter text CHECK (length(category_filter) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, exposure_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

-- from_exposure_id is not a foreign key: delivery order is not guaranteed.
CREATE TABLE app_private.observation_opening (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_detail_opened' CHECK (event_type = 'dish_detail_opened'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('menu_card', 'compare_view', 'direct', 'saved_screen')),
  from_exposure_id uuid,
  nav_relation text CHECK (nav_relation IN ('none', 'from_compare', 'back_navigation')),
  save_available boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, opening_id),
  CHECK (source <> 'direct' OR from_exposure_id IS NULL),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

-- active_ms is cumulative per opening; readers take the greatest value and never sum checkpoints.
CREATE TABLE app_private.observation_activity (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_activity_checkpoint'
    CHECK (event_type = 'dish_activity_checkpoint'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  active_ms integer NOT NULL CHECK (active_ms BETWEEN 0 AND 300000),
  final boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

CREATE TABLE app_private.observation_closing (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_detail_closed' CHECK (event_type = 'dish_detail_closed'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

CREATE TABLE app_private.observation_comparison (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'dish_compared' CHECK (event_type = 'dish_compared'),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  other_dish_id uuid NOT NULL,
  other_dish_revision_id uuid NOT NULL,
  comparison_id uuid NOT NULL,
  compare_action text NOT NULL CHECK (compare_action IN ('start', 'replace')),
  save_available boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CHECK (other_dish_id <> dish_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

-- dish_saved and dish_unsaved share one table. An Undo restore is dish_saved with
-- save_origin = 'undo'; save adoption counts only save_origin = 'direct'.
CREATE TABLE app_private.observation_save (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('dish_saved', 'dish_unsaved')),
  dish_id uuid NOT NULL,
  dish_revision_id uuid NOT NULL,
  save_origin text CHECK (save_origin IN ('direct', 'undo')),
  surface text NOT NULL CHECK (surface IN ('menu_card', 'dish_detail', 'compare_view', 'saved_screen')),
  shortlist_size integer NOT NULL CHECK (shortlist_size >= 0),
  PRIMARY KEY (tenant_id, event_id),
  CHECK ((event_type = 'dish_saved') = (save_origin IS NOT NULL)),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

CREATE TABLE app_private.observation_shortlist_view (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL DEFAULT 'shortlist_viewed' CHECK (event_type = 'shortlist_viewed'),
  shortlist_size integer NOT NULL CHECK (shortlist_size >= 0),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id, event_type)
    REFERENCES app_private.observation_event (tenant_id, event_id, event_type)
);

DO $$
DECLARE
  fact text;
BEGIN
  FOREACH fact IN ARRAY ARRAY[
    'observation_event', 'observation_menu_view', 'observation_exposure', 'observation_opening',
    'observation_activity', 'observation_closing', 'observation_comparison', 'observation_save',
    'observation_shortlist_view'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$s_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.%1$I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change()', fact);
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', fact);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', fact);
    EXECUTE format(
      'CREATE POLICY %1$s_tenant_scope ON app_private.%1$I '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', fact);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC', fact);
    EXECUTE format('GRANT SELECT, INSERT ON app_private.%I TO peekaplate_runtime', fact);
  END LOOP;
END;
$$;

-- One row per accepted live event. security_invoker keeps the caller's tenant RLS in force.
CREATE VIEW app_private.owner_observation_v1
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  e.tenant_id,
  e.event_id,
  e.event_type,
  e.session_id,
  e.publication_revision_id,
  i.authorized_publication_id,
  i.occurred_at,
  i.first_received_at,
  coalesce(x.dish_id, o.dish_id, a.dish_id, cl.dish_id, c.dish_id, s.dish_id) AS dish_id,
  coalesce(x.dish_revision_id, o.dish_revision_id, a.dish_revision_id, cl.dish_revision_id,
    c.dish_revision_id, s.dish_revision_id) AS dish_revision_id,
  m.entry_source,
  coalesce(x.exposure_id, o.from_exposure_id) AS exposure_id,
  x.position,
  x.category_filter,
  coalesce(o.opening_id, a.opening_id, cl.opening_id) AS opening_id,
  o.source AS opening_source,
  o.nav_relation,
  coalesce(o.save_available, c.save_available) AS save_available,
  a.active_ms,
  a.final AS activity_final,
  c.other_dish_id,
  c.other_dish_revision_id,
  c.comparison_id,
  c.compare_action,
  s.save_origin,
  s.surface AS save_surface,
  coalesce(s.shortlist_size, sv.shortlist_size) AS shortlist_size
FROM app_private.observation_event e
JOIN app_private.observation_index i USING (tenant_id, event_id)
LEFT JOIN app_private.observation_menu_view m USING (tenant_id, event_id)
LEFT JOIN app_private.observation_exposure x USING (tenant_id, event_id)
LEFT JOIN app_private.observation_opening o USING (tenant_id, event_id)
LEFT JOIN app_private.observation_activity a USING (tenant_id, event_id)
LEFT JOIN app_private.observation_closing cl USING (tenant_id, event_id)
LEFT JOIN app_private.observation_comparison c USING (tenant_id, event_id)
LEFT JOIN app_private.observation_save s USING (tenant_id, event_id)
LEFT JOIN app_private.observation_shortlist_view sv USING (tenant_id, event_id)
WHERE e.traffic_class = 'live';

-- Active time per opening: the greatest valid cumulative checkpoint, never a sum.
CREATE VIEW app_private.owner_opening_activity_v1
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  tenant_id,
  opening_id,
  dish_id,
  dish_revision_id,
  max(active_ms) AS active_ms,
  bool_or(activity_final) AS has_final_checkpoint,
  count(*) AS checkpoint_count
FROM app_private.owner_observation_v1
WHERE event_type = 'dish_activity_checkpoint'
GROUP BY tenant_id, opening_id, dish_id, dish_revision_id;

REVOKE ALL ON app_private.owner_observation_v1, app_private.owner_opening_activity_v1 FROM PUBLIC;
GRANT SELECT ON app_private.owner_observation_v1, app_private.owner_opening_activity_v1
  TO peekaplate_runtime;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Observation fact rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
