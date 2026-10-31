-- migrate:up
-- Internal staging diagnostics only. No direct analytics grants to the app runtime.
CREATE SCHEMA team_api_private;
REVOKE ALL ON SCHEMA team_api_private FROM PUBLIC;
CREATE ROLE peekaplate_analytics_reader NOLOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT peekaplate_analytics_reader TO CURRENT_USER;
CREATE TABLE team_api_private.project_scope (
  project_id integer PRIMARY KEY CHECK (project_id > 0)
);
INSERT INTO team_api_private.project_scope VALUES (675372);
REVOKE ALL ON team_api_private.project_scope FROM PUBLIC;
GRANT USAGE ON SCHEMA team_api_private, analytics_private TO peekaplate_analytics_reader;
GRANT SELECT ON team_api_private.project_scope,
  analytics_private.posthog_events_deduplicated TO peekaplate_analytics_reader;
CREATE INDEX posthog_events_timestamp ON analytics_private.posthog_events (team_id, timestamp);

CREATE FUNCTION team_api_private.read_analytics(
  p_project integer, p_kind text,
  p_from timestamptz, p_until timestamptz, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_events jsonb := '[]'::jsonb;
  v_counts jsonb := '[]'::jsonb;
  v_truncated boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team_api_private.project_scope
    WHERE project_id = p_project) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('events', 'summary')
    OR p_from IS NULL OR p_until IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_until)
    OR p_until <= p_from OR p_until - p_from > interval '7 days'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'events' THEN
    SELECT coalesce(jsonb_agg(item ORDER BY event_time DESC, identity), '[]'::jsonb), count(*) > p_limit
    INTO v_events, v_truncated
    FROM (
      SELECT timestamp AS event_time, uuid AS identity,
        jsonb_build_object(
          'id', uuid, 'event', event, 'timestamp', timestamp, 'surface', properties->>'surface',
          'properties', jsonb_strip_nulls(jsonb_build_object(
            'schema_version', CASE WHEN properties->'schema_version' = '1'::jsonb THEN 1 END,
            'event_id', CASE WHEN properties->>'event_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN properties->>'event_id' END,
            'publication_hash', CASE WHEN properties->>'publication_hash' ~ '^[a-f0-9]{64}$' THEN properties->>'publication_hash' END,
            'dish_revision_hash', CASE WHEN properties->>'dish_revision_hash' ~ '^[a-f0-9]{64}$' THEN properties->>'dish_revision_hash' END,
            'manifest_hash', CASE WHEN properties->>'manifest_hash' ~ '^[a-f0-9]{64}$' THEN properties->>'manifest_hash' END,
            'displayed_tier', CASE WHEN properties->>'displayed_tier' IN ('T0','T1','T2') THEN properties->>'displayed_tier' END,
            'availability_version', CASE WHEN jsonb_typeof(properties->'availability_version') = 'number'
              AND (properties->>'availability_version')::numeric BETWEEN 0 AND 9007199254740991
              AND trunc((properties->>'availability_version')::numeric) = (properties->>'availability_version')::numeric
              THEN properties->'availability_version' END
          ))
        ) AS item
      FROM analytics_private.posthog_events_deduplicated
      WHERE team_id = p_project AND properties->>'environment' = 'staging'
        AND properties->>'surface' IN ('diner','console')
        AND event IN ('app_shell_viewed','dish_open','portion_compare')
        AND timestamp >= p_from AND timestamp < p_until
      ORDER BY timestamp DESC, uuid LIMIT p_limit + 1
    ) selected;
    -- Fetch one extra row to signal truncation without exposing an unbounded result.
    v_events := (SELECT coalesce(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(v_events) WITH ORDINALITY WHERE ordinality <= p_limit);
  ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object('event', event, 'surface', surface, 'count', count)
      ORDER BY event, surface), '[]'::jsonb) INTO v_counts
    FROM (
      SELECT event, properties->>'surface' AS surface, count(*) AS count
      FROM analytics_private.posthog_events_deduplicated
      WHERE team_id = p_project AND properties->>'environment' = 'staging'
        AND properties->>'surface' IN ('diner','console')
        AND event IN ('app_shell_viewed','dish_open','portion_compare')
        AND timestamp >= p_from AND timestamp < p_until
      GROUP BY event, properties->>'surface'
    ) counted;
  END IF;
  RETURN jsonb_build_object(
    'source','posthog_supabase_export', 'environment','staging', 'projectId',p_project,
    'from',p_from, 'until',p_until, 'computedAt',statement_timestamp(),
    'freshness','hourly_export_delay', 'kind',p_kind,
    'events',v_events, 'counts',v_counts, 'truncated',v_truncated
  );
END;
$$;
REVOKE ALL ON FUNCTION team_api_private.read_analytics(integer,text,timestamptz,timestamptz,integer) FROM PUBLIC;
-- Transfer ownership to a non-login role with only the required read privileges.
GRANT CREATE ON SCHEMA team_api_private TO peekaplate_analytics_reader;
ALTER FUNCTION team_api_private.read_analytics(integer,text,timestamptz,timestamptz,integer)
  OWNER TO peekaplate_analytics_reader;
REVOKE CREATE ON SCHEMA team_api_private FROM peekaplate_analytics_reader;
GRANT USAGE ON SCHEMA team_api_private TO peekaplate_runtime;
GRANT EXECUTE ON FUNCTION team_api_private.read_analytics(integer,text,timestamptz,timestamptz,integer)
  TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Use a forward corrective migration for team analytics access.';
END; $$;
