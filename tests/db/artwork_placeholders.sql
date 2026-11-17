BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000a01', 'Placeholder Tenant A'),
  ('00000000-0000-0000-0000-000000000a02', 'Placeholder Tenant B');

SELECT has_table('app_private', 'ingredient_artwork_placeholder', 'placeholder table exists');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
           WHERE oid = 'app_private.ingredient_artwork_placeholder'::regclass), 'placeholder table forces RLS');
SELECT ok(has_table_privilege('peekaplate_runtime', 'app_private.ingredient_artwork_placeholder', 'SELECT, INSERT'),
  'runtime can read and record placeholders');
SELECT ok(NOT has_table_privilege('peekaplate_runtime', 'app_private.ingredient_artwork_placeholder', 'UPDATE'),
  'runtime cannot edit placeholders');
SELECT ok(NOT has_table_privilege('peekaplate_runtime', 'app_private.ingredient_artwork_placeholder', 'DELETE'),
  'runtime cannot delete placeholders');

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000a01', true);
SELECT lives_ok(
  $$INSERT INTO app_private.ingredient_artwork_placeholder (tenant_id, label, first_job_id)
    VALUES ('00000000-0000-0000-0000-000000000a01', 'basil', '00000000-0000-0000-0000-00000000b001')$$,
  'runtime records a placeholder for its own tenant');
SELECT lives_ok(
  $$INSERT INTO app_private.ingredient_artwork_placeholder (tenant_id, label, first_job_id)
    VALUES ('00000000-0000-0000-0000-000000000a01', 'basil', '00000000-0000-0000-0000-00000000b002')
    ON CONFLICT (tenant_id, label) DO NOTHING$$,
  'a repeated label is ignored');
SELECT is((SELECT first_job_id::text FROM app_private.ingredient_artwork_placeholder WHERE label = 'basil'),
  '00000000-0000-0000-0000-00000000b001', 'the first job that saw the label is kept');
SELECT throws_ok(
  $$INSERT INTO app_private.ingredient_artwork_placeholder (tenant_id, label, first_job_id)
    VALUES ('00000000-0000-0000-0000-000000000a02', 'mint', '00000000-0000-0000-0000-00000000b003')$$,
  '42501', NULL, 'runtime cannot record a placeholder for another tenant');
SELECT throws_ok(
  $$INSERT INTO app_private.ingredient_artwork_placeholder (tenant_id, label, first_job_id)
    VALUES ('00000000-0000-0000-0000-000000000a01', 'Basil ', '00000000-0000-0000-0000-00000000b004')$$,
  '23514', NULL, 'labels must already be normalized');
SELECT throws_ok(
  $$UPDATE app_private.ingredient_artwork_placeholder SET label = 'mint'$$,
  '42501', NULL, 'runtime update is denied');

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000a02', true);
SELECT is((SELECT count(*)::integer FROM app_private.ingredient_artwork_placeholder), 0,
  'another tenant sees no placeholders');
SELECT set_config('app.tenant_id', '', true);
SELECT is((SELECT count(*)::integer FROM app_private.ingredient_artwork_placeholder), 0,
  'no tenant set sees no placeholders');
RESET ROLE;

SELECT is((SELECT count(*)::integer FROM app_private.ingredient_artwork_current
           WHERE tenant_id = '00000000-0000-0000-0000-000000000a01'), 0,
  'recording a placeholder approves no artwork');

SELECT * FROM finish();
ROLLBACK;
