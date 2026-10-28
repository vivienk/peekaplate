BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(33);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Fact venue one'),
  ('00000000-0000-0000-0000-0000000000b2', 'Fact venue two');

-- Index rows are written by the owner here; fact writes below run as the runtime role.
CREATE TEMPORARY TABLE fact_index (event_id uuid, event_type text, disposition text, tenant uuid);
INSERT INTO fact_index VALUES
  ('61000000-0000-4000-8000-000000000001', 'menu_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000002', 'dish_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000003', 'dish_detail_opened', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000004', 'dish_activity_checkpoint', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000005', 'dish_activity_checkpoint', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000006', 'dish_compared', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000007', 'dish_saved', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000008', 'dish_unsaved', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000009', 'dish_saved', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000010', 'shortlist_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000011', 'dish_detail_closed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000012', 'menu_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000013', 'dish_detail_opened', 'rejected', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000014', 'dish_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000015', 'dish_compared', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000016', 'dish_saved', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000017', 'dish_unsaved', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000018', 'dish_activity_checkpoint', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000019', 'dish_detail_opened', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000020', 'menu_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b2'),
  ('61000000-0000-4000-8000-000000000021', 'dish_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000022', 'dish_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1'),
  ('61000000-0000-4000-8000-000000000023', 'dish_viewed', 'accepted', '00000000-0000-0000-0000-0000000000b1');
INSERT INTO app_private.observation_index (tenant_id, event_id, canonical_payload_checksum, schema_version,
  event_type, authorized_publication_id, occurred_at, first_received_at, r2_archive_key, disposition, reason_code)
SELECT tenant, event_id, repeat('c', 64), 'observation.v2', event_type, '71000000-0000-4000-8000-000000000001',
  '2026-10-26 10:00:00Z', '2026-10-26 10:00:02Z', 'raw/observations/b/' || event_id || '.json', disposition,
  CASE WHEN disposition = 'rejected' THEN 'publication_not_allowed' END
FROM fact_index;

CREATE TEMPORARY TABLE fact_tables (name text);
INSERT INTO fact_tables VALUES ('observation_event'), ('observation_menu_view'), ('observation_exposure'),
  ('observation_opening'), ('observation_activity'), ('observation_closing'), ('observation_comparison'),
  ('observation_save'), ('observation_shortlist_view');
GRANT SELECT ON fact_tables, fact_index TO peekaplate_runtime;

SELECT is((SELECT count(*) FROM fact_tables f JOIN pg_class c ON c.relname = f.name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app_private'), 9::bigint, 'all nine fact tables exist');
SELECT is((SELECT count(*) FROM fact_tables f JOIN pg_class c ON c.relname = f.name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app_private'
  WHERE c.relrowsecurity AND c.relforcerowsecurity), 9::bigint, 'RLS is forced on every fact table');
SELECT is((SELECT count(*) FROM fact_tables WHERE has_table_privilege('public', 'app_private.' || name, 'select')),
  0::bigint, 'public cannot read any fact table');
SELECT is((SELECT count(*) FROM fact_tables WHERE has_table_privilege('peekaplate_runtime', 'app_private.' || name, 'select, insert')),
  9::bigint, 'runtime reads and inserts every fact table');
SELECT is((SELECT count(*) FROM fact_tables WHERE has_table_privilege('peekaplate_runtime', 'app_private.' || name, 'update')
  OR has_table_privilege('peekaplate_runtime', 'app_private.' || name, 'delete')), 0::bigint, 'runtime cannot update or delete facts');
SELECT is(has_table_privilege('public', 'app_private.owner_observation_v1', 'select'), false, 'public cannot read the owner view');
SELECT is(has_table_privilege('peekaplate_runtime', 'app_private.owner_observation_v1', 'select'), true, 'runtime reads the owner view');

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000b1', false);

-- Envelopes: one per accepted event; event 012 is test traffic and stays out of owner views.
SELECT lives_ok($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  SELECT tenant, event_id, event_type, '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    row_number() OVER (ORDER BY event_id), '72000000-0000-4000-8000-000000000001',
    CASE WHEN event_id = '61000000-0000-4000-8000-000000000012' THEN 'test' ELSE 'live' END
  FROM fact_index
  WHERE disposition = 'accepted' AND tenant = '00000000-0000-0000-0000-0000000000b1'
    AND event_id <= '61000000-0000-4000-8000-000000000012'
$$, 'runtime records envelopes for accepted events');
SELECT throws_like($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  VALUES ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000013', 'dish_detail_opened',
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 99, '72000000-0000-4000-8000-000000000001', 'live')
$$, '%violates foreign key constraint%', 'a rejected observation gets no facts');
SELECT throws_like($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  VALUES ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000099', 'menu_viewed',
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 99, '72000000-0000-4000-8000-000000000001', 'live')
$$, '%violates foreign key constraint%', 'facts need an indexed observation');
SELECT throws_like($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  VALUES ('00000000-0000-0000-0000-0000000000b2', '61000000-0000-4000-8000-000000000020', 'menu_viewed',
    '81000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', 1, '72000000-0000-4000-8000-000000000001', 'live')
$$, 'new row violates row-level security policy for table "observation_event"%', 'tenant cannot write another tenant facts');

SELECT lives_ok($$
  INSERT INTO app_private.observation_menu_view (tenant_id, event_id, entry_source) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000001', 'qr'),
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000012', 'direct_link');
  INSERT INTO app_private.observation_exposure (tenant_id, event_id, dish_id, dish_revision_id, exposure_id,
    surface, position, exposure_basis) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'menu_list', 1, 'viewport_50pct_1s');
  INSERT INTO app_private.observation_opening (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source,
    from_exposure_id, nav_relation, save_available) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'menu_card',
     '93000000-0000-4000-8000-000000000001', 'none', true);
  INSERT INTO app_private.observation_activity (tenant_id, event_id, dish_id, dish_revision_id, opening_id, active_ms, final) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 5000, false),
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 10000, true);
  INSERT INTO app_private.observation_comparison (tenant_id, event_id, dish_id, dish_revision_id, other_dish_id,
    other_dish_revision_id, comparison_id, compare_action, save_available) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000002',
     '95000000-0000-4000-8000-000000000001', 'start', true);
  INSERT INTO app_private.observation_save (tenant_id, event_id, event_type, dish_id, dish_revision_id, save_origin,
    surface, shortlist_size) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000007', 'dish_saved', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', 'direct', 'dish_detail', 1),
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000008', 'dish_unsaved', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', NULL, 'saved_screen', 0),
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000009', 'dish_saved', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', 'undo', 'saved_screen', 1);
  INSERT INTO app_private.observation_shortlist_view (tenant_id, event_id, shortlist_size) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000010', 1);
  INSERT INTO app_private.observation_closing (tenant_id, event_id, dish_id, dish_revision_id, opening_id) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000011', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001');
$$, 'runtime records typed facts for every P0 event');

SELECT throws_like($$
  INSERT INTO app_private.observation_exposure (tenant_id, event_id, dish_id, dish_revision_id, exposure_id,
    surface, position, exposure_basis) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000009', 'menu_list', 1, 'viewport_50pct_1s')
$$, '%violates foreign key constraint%', 'a detail row must match its event type');
SELECT throws_like($$
  INSERT INTO app_private.observation_exposure (tenant_id, event_id, dish_id, dish_revision_id, exposure_id,
    surface, position, exposure_basis) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000014', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'menu_list', 2, 'viewport_50pct_1s')
$$, 'duplicate key value violates unique constraint%', 'an exposure_id identifies one exposure');
SELECT throws_like($$
  INSERT INTO app_private.observation_opening (tenant_id, event_id, dish_id, dish_revision_id, opening_id, source,
    from_exposure_id, save_available) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000019', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000002', 'direct',
     '93000000-0000-4000-8000-000000000001', true)
$$, 'new row for relation "observation_opening" violates check constraint%', 'a direct opening has no exposure link');
SELECT throws_like($$
  INSERT INTO app_private.observation_comparison (tenant_id, event_id, dish_id, dish_revision_id, other_dish_id,
    other_dish_revision_id, comparison_id, compare_action, save_available) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000015', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000003',
     '95000000-0000-4000-8000-000000000002', 'start', true)
$$, 'new row for relation "observation_comparison" violates check constraint%', 'a dish cannot be compared with itself');
SELECT throws_like($$
  INSERT INTO app_private.observation_save (tenant_id, event_id, event_type, dish_id, dish_revision_id, surface, shortlist_size) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000016', 'dish_saved', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', 'menu_card', 1)
$$, 'new row for relation "observation_save" violates check constraint%', 'a save needs its origin');
SELECT throws_like($$
  INSERT INTO app_private.observation_save (tenant_id, event_id, event_type, dish_id, dish_revision_id, save_origin, surface, shortlist_size) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000017', 'dish_unsaved', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', 'undo', 'menu_card', 0)
$$, 'new row for relation "observation_save" violates check constraint%', 'an unsave has no save origin');
SELECT throws_like($$
  INSERT INTO app_private.observation_activity (tenant_id, event_id, dish_id, dish_revision_id, opening_id, active_ms, final) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000018', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 300001, true)
$$, 'new row for relation "observation_activity" violates check constraint%', 'active time is capped at five minutes per opening');
-- Contract-sized integers: at, just above and at the top of the old int4 range; test traffic keeps the view count.
SELECT lives_ok($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  SELECT '00000000-0000-0000-0000-0000000000b1', event_id, 'dish_viewed', '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001', n, '72000000-0000-4000-8000-000000000001', 'test'
  FROM (VALUES ('61000000-0000-4000-8000-000000000021'::uuid, 2147483647::bigint),
    ('61000000-0000-4000-8000-000000000022'::uuid, 2147483648::bigint),
    ('61000000-0000-4000-8000-000000000023'::uuid, 9007199254740991::bigint)) AS v (event_id, n)
$$, 'local_sequence accepts every contract-valid integer');
SELECT throws_like($$
  INSERT INTO app_private.observation_event (tenant_id, event_id, event_type, session_id, producer_id,
    local_sequence, publication_revision_id, traffic_class)
  VALUES ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000099', 'dish_viewed',
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 9007199254740992,
    '72000000-0000-4000-8000-000000000001', 'test')
$$, 'new row for relation "observation_event" violates check constraint%', 'local_sequence stops at the contract maximum');
SELECT lives_ok($$
  INSERT INTO app_private.observation_exposure (tenant_id, event_id, dish_id, dish_revision_id, exposure_id,
    surface, position, exposure_basis)
  SELECT '00000000-0000-0000-0000-0000000000b1', event_id, '91000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001', exposure_id, 'menu_list', n, 'viewport_50pct_1s'
  FROM (VALUES ('61000000-0000-4000-8000-000000000021'::uuid, '93000000-0000-4000-8000-000000000021'::uuid, 2147483647::bigint),
    ('61000000-0000-4000-8000-000000000022'::uuid, '93000000-0000-4000-8000-000000000022'::uuid, 2147483648::bigint),
    ('61000000-0000-4000-8000-000000000023'::uuid, '93000000-0000-4000-8000-000000000023'::uuid, 9007199254740991::bigint))
    AS v (event_id, exposure_id, n)
$$, 'exposure position accepts every contract-valid integer');
SELECT throws_like($$
  INSERT INTO app_private.observation_exposure (tenant_id, event_id, dish_id, dish_revision_id, exposure_id,
    surface, position, exposure_basis) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '61000000-0000-4000-8000-000000000014', '91000000-0000-4000-8000-000000000001',
     '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000024', 'menu_list', 9007199254740992, 'viewport_50pct_1s')
$$, 'new row for relation "observation_exposure" violates check constraint%', 'exposure position stops at the contract maximum');
SELECT throws_like($$UPDATE app_private.observation_save SET save_origin = 'direct'$$,
  'permission denied for table observation_save%', 'runtime cannot rewrite a fact');

SELECT is((SELECT count(*) FROM app_private.owner_observation_v1), 11::bigint, 'owner view holds accepted live events only');
SELECT is((SELECT count(*) FROM app_private.owner_observation_v1 WHERE event_id = '61000000-0000-4000-8000-000000000012'),
  0::bigint, 'test traffic is excluded from the owner view');
SELECT is((SELECT active_ms FROM app_private.owner_opening_activity_v1 WHERE opening_id = '94000000-0000-4000-8000-000000000001'),
  10000, 'opening active time is the greatest checkpoint, not the sum');
SELECT is((SELECT count(*) FROM app_private.owner_observation_v1 WHERE event_type = 'dish_saved' AND save_origin = 'direct'),
  1::bigint, 'an Undo restore is distinguishable from a direct save');
SELECT is((SELECT exposure_id FROM app_private.owner_observation_v1 WHERE event_type = 'dish_detail_opened'),
  '93000000-0000-4000-8000-000000000001'::uuid, 'an opening carries its source exposure');
SELECT is((SELECT occurred_at FROM app_private.owner_observation_v1 WHERE event_type = 'menu_viewed'),
  '2026-10-26 10:00:00Z'::timestamptz, 'owner view takes event time from the canonical index');

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000b2', false);
SELECT is((SELECT count(*) FROM app_private.owner_observation_v1) + (SELECT count(*) FROM app_private.owner_opening_activity_v1),
  0::bigint, 'tenant cannot read another tenant owner rows');
SELECT set_config('app.tenant_id', '', false);
SELECT is((SELECT count(*) FROM app_private.observation_event), 0::bigint, 'runtime without tenant context reads no facts');
RESET ROLE;

SELECT throws_ok($$DELETE FROM app_private.observation_event$$,
  'append-only table observation_event rejects DELETE', 'facts reject deletes even by their owner');

SELECT * FROM finish();
ROLLBACK;
