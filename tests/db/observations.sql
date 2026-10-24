BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Observation venue one'),
  ('00000000-0000-0000-0000-0000000000a2', 'Observation venue two');

SELECT has_table('app_private', 'observation_index', 'observation index exists');
SELECT has_table('app_private', 'observation_conflict', 'observation conflict table exists');
SELECT col_is_pk('app_private', 'observation_index', ARRAY['tenant_id', 'event_id'],
  'observation identity is (tenant_id, event_id)');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.observation_index'::regclass), true, 'index RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.observation_conflict'::regclass), true, 'conflict RLS is forced');
SELECT is(has_table_privilege('public', 'app_private.observation_index', 'select'), false, 'public has no index read grant');
SELECT is(has_table_privilege('public', 'app_private.observation_conflict', 'select'), false, 'public has no conflict read grant');
SELECT is(has_table_privilege('peekaplate_runtime', 'app_private.observation_index', 'select, insert'), true, 'runtime reads and inserts index rows');
SELECT is(has_table_privilege('peekaplate_runtime', 'app_private.observation_index', 'update'), false, 'runtime cannot update index rows');
SELECT is(has_table_privilege('peekaplate_runtime', 'app_private.observation_conflict', 'delete'), false, 'runtime cannot delete conflicts');

SET ROLE peekaplate_runtime;
SELECT is((SELECT count(*) FROM app_private.observation_index), 0::bigint, 'runtime without tenant context reads no index rows');
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000a1', false);
SELECT lives_ok(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000001', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a1/60000000-0000-4000-8000-000000000001.json', 'accepted')$$,
  'runtime indexes an accepted observation for its tenant');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000001', repeat('b', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:05Z', 'raw/observations/a1/other.json', 'accepted')$$,
  'duplicate key value violates unique constraint%', 'a reused tenant event_id cannot be indexed twice');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a2', '60000000-0000-4000-8000-000000000001', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000002', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a2/60000000-0000-4000-8000-000000000001.json', 'accepted')$$,
  'new row violates row-level security policy for table "observation_index"%', 'tenant cannot index another tenant observation');
SELECT throws_like(
  $$UPDATE app_private.observation_index SET disposition = 'rejected', reason_code = 'too_old'$$,
  'permission denied for table observation_index%', 'runtime cannot rewrite an indexed observation');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000002', repeat('a', 64), 'observation.v1', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a1/2.json', 'accepted')$$,
  'new row for relation "observation_index" violates check constraint%', 'only observation.v2 is indexed');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000003', repeat('a', 64), 'observation.v2', 'ingredient_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a1/3.json', 'accepted')$$,
  'new row for relation "observation_index" violates check constraint%', 'unknown event types are not indexed');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000004', 'not-a-checksum', 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a1/4.json', 'accepted')$$,
  'new row for relation "observation_index" violates check constraint%', 'checksum is SHA-256 hex');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000005', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-22 09:59:59Z', '2026-10-23 10:00:00Z', 'raw/observations/a1/5.json', 'accepted')$$,
  'new row for relation "observation_index" violates check constraint%', 'accepted occurred_at more than 24 hours old is refused');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000006', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:05:01Z', '2026-10-23 10:00:00Z', 'raw/observations/a1/6.json', 'accepted')$$,
  'new row for relation "observation_index" violates check constraint%', 'accepted occurred_at more than 5 minutes ahead is refused');
SELECT lives_ok(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition, reason_code) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000007', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-21 10:00:00Z', '2026-10-23 10:00:00Z', 'raw/observations/a1/7.json', 'rejected', 'too_old')$$,
  'a too_old rejection is recorded with its reason code');
SELECT throws_like(
  $$INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version, event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000008', repeat('a', 64), 'observation.v2', 'dish_detail_opened', '70000000-0000-4000-8000-000000000001', '2026-10-23 10:00:00Z', '2026-10-23 10:00:02Z', 'raw/observations/a1/8.json', 'rejected')$$,
  'new row for relation "observation_index" violates check constraint%', 'a rejection needs a reason code');
SELECT lives_ok(
  $$INSERT INTO app_private.observation_conflict (tenant_id, event_id, incoming_checksum, r2_archive_key, received_at) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000001', repeat('b', 64), 'raw/observations/a1/60000000-0000-4000-8000-000000000001-bbbb.json', '2026-10-23 10:00:05Z')$$,
  'conflicting reuse is quarantined without replacing the original');
SELECT throws_like(
  $$INSERT INTO app_private.observation_conflict (tenant_id, event_id, incoming_checksum, r2_archive_key, received_at) VALUES ('00000000-0000-0000-0000-0000000000a1', '60000000-0000-4000-8000-000000000001', repeat('b', 64), 'raw/observations/a1/60000000-0000-4000-8000-000000000001-bbbb.json', '2026-10-23 10:01:00Z')$$,
  'duplicate key value violates unique constraint%', 'a redelivered conflict is recorded once');
SELECT is((SELECT canonical_payload_checksum FROM app_private.observation_index WHERE event_id = '60000000-0000-4000-8000-000000000001'), repeat('a', 64), 'original payload checksum is kept');
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000a2', false);
SELECT is((SELECT count(*) FROM app_private.observation_index) + (SELECT count(*) FROM app_private.observation_conflict), 0::bigint, 'tenant cannot read another tenant observations or conflicts');
RESET ROLE;

SELECT throws_ok($$DELETE FROM app_private.observation_index$$, 'append-only table observation_index rejects DELETE', 'index rejects deletes even by its owner');

SELECT * FROM finish();
ROLLBACK;
