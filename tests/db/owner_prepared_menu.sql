BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-00000000c001', 'Prepared Tenant A'),
  ('00000000-0000-0000-0000-00000000c002', 'Prepared Tenant B');
INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000a0001', 'owner'),
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000a0002', 'editor');

SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
            WHERE oid = 'app_private.admit_owner_prepared_menu(uuid,uuid,uuid,text,uuid,text,text)'::regprocedure),
  'admit function is security definer with a pinned search path');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc, LATERAL aclexplode(proacl) a
            WHERE oid = 'app_private.admit_owner_prepared_menu(uuid,uuid,uuid,text,uuid,text,text)'::regprocedure
              AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'PUBLIC cannot execute the admit function');
SELECT ok(has_function_privilege('peekaplate_runtime',
  'app_private.admit_owner_prepared_menu(uuid,uuid,uuid,text,uuid,text,text)', 'EXECUTE'), 'runtime can execute it');
SELECT ok(NOT has_table_privilege('peekaplate_runtime', 'app_private.menu_review_subject', 'INSERT'),
  'runtime still cannot insert review subjects directly');
SELECT ok(NOT has_table_privilege('peekaplate_runtime', 'app_private.public_menu_bundle', 'INSERT'),
  'runtime still cannot insert public bundles directly');
SELECT ok((SELECT NOT rolbypassrls AND NOT rolsuper AND NOT rolcanlogin FROM pg_roles
            WHERE rolname = 'peekaplate_menu_preparer'), 'preparer role cannot log in or bypass RLS');
SELECT ok(NOT pg_has_role('peekaplate_runtime', 'peekaplate_menu_preparer', 'MEMBER'),
  'runtime cannot become the preparer role');

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000c001', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-0000000a0001', true);
SELECT is(app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0002',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c001/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0002.json'),
  'inserted', 'an owner admits a prepared menu for their own venue');
SELECT is(app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0002',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c001/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0002.json'),
  'already_present', 'an identical retry changes nothing');
SELECT throws_ok($$SELECT app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0002',
  '00000000-0000-0000-0000-0000000b0003', repeat('c', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c001/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0002.json')$$,
  '23505', NULL, 'a different hash for the same revision is a conflict');
SELECT throws_ok($$SELECT app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0009',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://evil.example.test/menu.json')$$,
  '22023', NULL, 'any other bundle address is rejected');
SELECT throws_ok($$SELECT app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0009',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c002/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0009.json')$$,
  '22023', NULL, 'a bundle address for another venue is rejected');

SELECT set_config('app.actor_id', '00000000-0000-0000-0000-0000000a0002', true);
SELECT throws_ok($$SELECT app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0005',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c001/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0005.json')$$,
  '42501', NULL, 'an editor cannot admit a menu');
SELECT set_config('app.actor_id', '', true);
SELECT throws_ok($$SELECT app_private.admit_owner_prepared_menu(
  '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0006',
  '00000000-0000-0000-0000-0000000b0003', repeat('a', 64),
  '00000000-0000-0000-0000-0000000b0004', repeat('b', 64),
  'https://api.example.test/public/prepared-bundles/00000000-0000-0000-0000-00000000c001/00000000-0000-0000-0000-0000000b0001/00000000-0000-0000-0000-0000000b0006.json')$$,
  '42501', NULL, 'no signed-in actor admits nothing');

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000c002', true);
SELECT is((SELECT count(*)::integer FROM app_private.menu_review_subject), 0,
  'another venue sees no prepared menu');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM app_private.menu_approval
            WHERE tenant_id = '00000000-0000-0000-0000-00000000c001'), 0,
  'admission approves nothing (the owner still approves and publishes in S13)');

SELECT * FROM finish();
ROLLBACK;
