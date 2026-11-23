BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-4000-8000-00000000aa01', 'Synthetic report A'),
  ('00000000-0000-4000-8000-00000000aa02', 'Synthetic report B');

CREATE TEMP TABLE test_report_events AS
SELECT gen_random_uuid() AS event_id, venue.id AS tenant_id, traffic.class
FROM (VALUES ('00000000-0000-4000-8000-00000000aa01'::uuid),
             ('00000000-0000-4000-8000-00000000aa02'::uuid)) venue(id)
CROSS JOIN (VALUES ('live'), ('test'), ('demo')) traffic(class);

INSERT INTO app_private.observation_index
  (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type,
   authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition)
SELECT tenant_id, event_id, repeat('a', 64), 'observation.v2', 'menu_viewed',
  '00000000-0000-4000-8000-00000000aa03', '2026-11-17T10:00:00Z',
  '2026-11-17T10:01:00Z', 'synthetic-test-report/' || event_id, 'accepted'
FROM test_report_events;

INSERT INTO app_private.observation_event
  (tenant_id, event_id, event_type, session_id, producer_id, local_sequence,
   publication_revision_id, traffic_class)
SELECT tenant_id, event_id, 'menu_viewed', gen_random_uuid(), gen_random_uuid(), 0,
  '00000000-0000-4000-8000-00000000aa03', class
FROM test_report_events;

SELECT is(has_table_privilege('public', 'app_private.owner_test_observation_v1', 'select'), false,
  'public cannot read test observations');
SELECT is(has_table_privilege('peekaplate_runtime', 'app_private.owner_test_observation_v1', 'select'), true,
  'runtime can read the isolated test view');
SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-00000000aa01', true);
SELECT is((SELECT count(*) FROM app_private.owner_test_observation_v1), 1::bigint,
  'test view includes only test traffic in the current tenant');
SELECT is((SELECT count(*) FROM app_private.owner_observation_v1), 1::bigint,
  'live view still includes only live traffic');
SELECT is((SELECT count(*) FROM app_private.owner_test_observation_v1 t
  JOIN app_private.observation_event e USING (tenant_id, event_id) WHERE e.traffic_class <> 'test'),
  0::bigint, 'test view excludes live and demo');
SELECT is((SELECT first_received_at FROM app_private.owner_test_observation_v1),
  '2026-11-17T10:01:00Z'::timestamptz, 'server ingestion timestamp is retained');
SELECT is((SELECT occurred_at FROM app_private.owner_test_observation_v1),
  '2026-11-17T10:00:00Z'::timestamptz, 'canonical event timestamp is retained');
SELECT is((SELECT count(*) FROM app_private.owner_test_observation_v1
  WHERE tenant_id = '00000000-0000-4000-8000-00000000aa02'), 0::bigint,
  'test view preserves cross-tenant RLS');
SELECT set_config('app.tenant_id', '', true);
SELECT is((SELECT count(*) FROM app_private.owner_test_observation_v1), 0::bigint,
  'runtime without a tenant sees no test observations');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
