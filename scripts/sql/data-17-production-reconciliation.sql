-- DATA-17 Read-Only Redacted Production Aggregate Reconciliation Query
-- Usage: Run inside a read-only PostgreSQL session by an authorized database operator (Sai).
-- Returns ONLY aggregate per-dish counts (no session_id, event_id, producer_id, or diner PII).
-- Note: Output includes small-cohort (< 10) per-dish counts for internal reconciliation only; never expose to owners.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';

WITH target_venue AS (
  SELECT "venueId" AS venue_id
  FROM app_private.resolve_restaurant_link('peekaplate_production_qa_b_nov_21')
),
windows AS (
  SELECT
    'Batch A'::text AS batch_label,
    '2026-11-23T01:45:00Z'::timestamptz AS starts,
    '2026-11-23T01:50:00Z'::timestamptz AS ends
  UNION ALL
  SELECT
    'Batch B'::text AS batch_label,
    '2026-11-23T17:45:00Z'::timestamptz AS starts,
    '2026-11-23T17:50:00Z'::timestamptz AS ends
),
scoped AS (
  SELECT
    w.batch_label,
    w.starts,
    w.ends,
    obs.tenant_id,
    obs.dish_id,
    dish.name AS dish_name,
    obs.session_id,
    obs.event_type,
    obs.opening_id,
    (obs.authorized_publication_id = obs.publication_revision_id) AS pub_match,
    (canonical.source_environment = 'production') AS prod_provenance_match
  FROM windows w
  CROSS JOIN target_venue v
  JOIN app_private.owner_observation_v1 obs
    ON obs.tenant_id = v.venue_id
   AND obs.occurred_at >= w.starts
   AND obs.occurred_at < w.ends
  LEFT JOIN app_private.dish_current dish
    ON dish.tenant_id = obs.tenant_id
   AND dish.dish_id = obs.dish_id
  LEFT JOIN app_private.observation_event canonical
    ON canonical.tenant_id = obs.tenant_id
   AND canonical.event_id = obs.event_id
),
per_dish_session AS (
  SELECT
    batch_label,
    starts,
    ends,
    dish_id,
    MIN(dish_name) AS dish_name,
    session_id,
    BOOL_OR(event_type = 'dish_viewed') AS is_exposed,
    BOOL_OR(event_type = 'dish_detail_opened') AS is_opened
  FROM scoped
  WHERE dish_id IS NOT NULL
  GROUP BY batch_label, starts, ends, dish_id, session_id
),
per_dish_agg AS (
  SELECT
    s.batch_label,
    s.starts,
    s.ends,
    s.dish_id,
    MIN(s.dish_name) AS dish_name,
    COUNT(DISTINCT s.session_id) FILTER (WHERE s.is_exposed) AS total_sessions,
    COUNT(DISTINCT s.session_id) FILTER (WHERE s.is_opened) AS open_eligible_sessions,
    COUNT(DISTINCT s.session_id) FILTER (WHERE s.is_exposed AND s.is_opened) AS exposed_open_sessions
  FROM per_dish_session s
  GROUP BY s.batch_label, s.starts, s.ends, s.dish_id
),
per_dish_events AS (
  SELECT
    batch_label,
    dish_id,
    COUNT(*) FILTER (WHERE event_type = 'dish_detail_opened' AND opening_id IS NOT NULL) AS total_openings,
    COUNT(*) FILTER (WHERE pub_match) AS authorized_publication_match_count,
    COUNT(*) FILTER (WHERE prod_provenance_match) AS production_provenance_match_count
  FROM scoped
  WHERE dish_id IS NOT NULL
  GROUP BY batch_label, dish_id
)
SELECT
  a.batch_label,
  a.starts AS window_start_utc,
  a.ends AS window_end_utc,
  a.dish_id,
  a.dish_name,
  a.total_sessions,
  a.open_eligible_sessions,
  a.exposed_open_sessions,
  COALESCE(e.total_openings, 0) AS total_openings,
  COALESCE(e.authorized_publication_match_count, 0) AS authorized_publication_match_count,
  COALESCE(e.production_provenance_match_count, 0) AS production_provenance_match_count
FROM per_dish_agg a
LEFT JOIN per_dish_events e
  ON e.batch_label = a.batch_label
 AND e.dish_id = a.dish_id
ORDER BY a.batch_label, a.total_sessions DESC, a.dish_id;

ROLLBACK;
