-- migrate:up
-- Optional client observations, never canonical restaurant events.
CREATE SCHEMA analytics_private;
REVOKE ALL ON SCHEMA analytics_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics_private REVOKE ALL ON TABLES FROM PUBLIC;

CREATE TABLE analytics_private.posthog_events (
  uuid varchar(200),
  event varchar(200),
  properties jsonb,
  elements jsonb,
  "set" jsonb,
  set_once jsonb,
  person_properties jsonb,
  person_id varchar(200),
  distinct_id varchar(200),
  team_id integer,
  ip varchar(200),
  site_url varchar(200),
  timestamp timestamptz
);
-- COPY-based exports may repeat rows after retries/backfills. A unique constraint
-- would fail the entire batch. Keep the raw copies for conflict investigation.
CREATE INDEX posthog_events_identity ON analytics_private.posthog_events (team_id, uuid);

CREATE VIEW analytics_private.posthog_events_deduplicated AS
SELECT DISTINCT e.*
FROM analytics_private.posthog_events e
WHERE e.team_id IS NOT NULL AND e.uuid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM analytics_private.posthog_events other
    WHERE other.team_id = e.team_id AND other.uuid = e.uuid
      AND to_jsonb(other) IS DISTINCT FROM to_jsonb(e)
  );

-- A deployment operator creates a separate LOGIN member with its own password.
-- Fail closed if a role with this reserved name already exists.
CREATE ROLE peekaplate_posthog_export NOLOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA analytics_private TO peekaplate_posthog_export;
GRANT SELECT, INSERT ON analytics_private.posthog_events TO peekaplate_posthog_export;
REVOKE ALL ON ALL TABLES IN SCHEMA analytics_private FROM PUBLIC;

COMMENT ON TABLE analytics_private.posthog_events IS
  'Private PostHog COPY landing table. No RLS: COPY compatibility; schema/table ACLs restrict access. Never expose via Data API. team_id is a PostHog project, not a restaurant.';
COMMENT ON VIEW analytics_private.posthog_events_deduplicated IS
  'Internal observations only. Exact duplicates collapse; conflicting or missing identities are excluded. Not tenant-authorized evidence or a complete event count.';

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'PostHog export rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
