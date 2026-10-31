BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);
SELECT has_table('analytics_private', 'posthog_events', 'PostHog has a separate private landing table');
SELECT ok(NOT has_schema_privilege('peekaplate_runtime', 'analytics_private', 'USAGE'), 'application runtime cannot access raw analytics');
SELECT ok(NOT has_schema_privilege('peekaplate_posthog_export', 'app_private', 'USAGE'), 'exporter cannot access restaurant records');
SELECT ok(NOT has_schema_privilege('peekaplate_posthog_export', 'analytics_private', 'CREATE'), 'exporter cannot create arbitrary objects');
SELECT ok(NOT has_table_privilege('peekaplate_posthog_export', 'analytics_private.posthog_events', 'UPDATE,DELETE,TRUNCATE'), 'exporter cannot overwrite or delete observations');
SELECT ok(NOT has_table_privilege('peekaplate_posthog_export', 'analytics_private.posthog_events_deduplicated', 'SELECT'), 'exporter does not receive reporting access');
SET LOCAL ROLE peekaplate_posthog_export;
COPY analytics_private.posthog_events (uuid, event, properties, team_id, timestamp) FROM STDIN;
fixture-1	app_shell_viewed	{"environment":"staging","surface":"diner"}	675372	2026-10-20T06:00:00Z
fixture-1	app_shell_viewed	{"environment":"staging","surface":"diner"}	675372	2026-10-20T06:00:00Z
fixture-1	app_shell_viewed	{"environment":"staging","surface":"console"}	2	2026-10-20T06:00:00Z
\.
SELECT is((SELECT count(*) FROM analytics_private.posthog_events), 3::bigint, 'exporter COPY accepts retries and repeated ids across projects');
RESET ROLE;
SELECT is((SELECT count(*) FROM analytics_private.posthog_events_deduplicated), 2::bigint, 'exact duplicate collapses while project identities stay separate');
INSERT INTO analytics_private.posthog_events (uuid,event,properties,team_id,timestamp)
VALUES ('fixture-1','app_shell_viewed','{"environment":"staging","surface":"console"}',675372,'2026-10-20T06:00:00Z');
SELECT is((SELECT count(*) FROM analytics_private.posthog_events_deduplicated WHERE team_id=675372), 0::bigint, 'conflicting copies are excluded instead of selecting an arbitrary winner');
SELECT is((SELECT count(*) FROM analytics_private.posthog_events WHERE team_id=675372), 3::bigint, 'conflict evidence remains in raw table');
INSERT INTO analytics_private.posthog_events (uuid,event,team_id) VALUES (NULL,'app_shell_viewed',675372),('missing-project','app_shell_viewed',NULL);
SELECT is((SELECT count(*) FROM analytics_private.posthog_events_deduplicated), 1::bigint, 'missing identities cannot enter deduplicated results');
SET LOCAL ROLE peekaplate_posthog_export;
SELECT throws_like($$SELECT * FROM app_private.venues$$, 'permission denied for schema app_private', 'exporter cannot read venue data');
SELECT throws_like($$DELETE FROM analytics_private.posthog_events$$, 'permission denied for table posthog_events', 'exporter delete fails');
RESET ROLE;
CREATE ROLE posthog_test_untrusted NOLOGIN;
SET LOCAL ROLE posthog_test_untrusted;
SELECT throws_like($$SELECT * FROM analytics_private.posthog_events$$, 'permission denied for schema analytics_private', 'ordinary roles cannot read imported data');
RESET ROLE;
SELECT ok(NOT (SELECT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole FROM pg_roles WHERE rolname='peekaplate_posthog_export'), 'migration creates no login credential or privileged role');
SELECT * FROM finish();
ROLLBACK;
