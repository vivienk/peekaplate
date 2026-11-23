-- migrate:up
-- Isolated canonical test observations; the live owner view remains unchanged.
CREATE VIEW app_private.owner_test_observation_v1
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
WHERE e.traffic_class = 'test';

REVOKE ALL ON app_private.owner_test_observation_v1 FROM PUBLIC;
GRANT SELECT ON app_private.owner_test_observation_v1 TO peekaplate_runtime;

-- migrate:down
DROP VIEW app_private.owner_test_observation_v1;
