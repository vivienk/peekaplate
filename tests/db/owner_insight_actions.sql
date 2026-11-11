BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Owner Actions Venue A'),
  ('00000000-0000-0000-0000-000000000102', 'Owner Actions Venue B');

INSERT INTO app_private.menu_review_subject
  (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash,
   asset_approval_id, asset_manifest_hash)
VALUES
  ('00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000501',
   '00000000-0000-0000-0000-000000000511',
   '00000000-0000-0000-0000-000000000521',
   repeat('a', 64),
   '00000000-0000-0000-0000-000000000531',
   repeat('b', 64)),
  ('00000000-0000-0000-0000-000000000102',
   '00000000-0000-0000-0000-000000000502',
   '00000000-0000-0000-0000-000000000512',
   '00000000-0000-0000-0000-000000000522',
   repeat('c', 64),
   '00000000-0000-0000-0000-000000000532',
   repeat('d', 64));

SELECT has_table(
  'app_private',
  'owner_insight_action_current',
  'owner insight action table exists'
);

SELECT is(
  (SELECT relforcerowsecurity
   FROM pg_class
   WHERE oid = 'app_private.owner_insight_action_current'::regclass),
  true,
  'owner insight action RLS is forced'
);

SELECT is(
  (SELECT has_table_privilege(
    'peekaplate_runtime',
    'app_private.owner_insight_action_current',
    'select, insert, update'
  )),
  true,
  'runtime can select, insert, and update owner actions'
);

SELECT is(
  (SELECT has_table_privilege(
    'peekaplate_runtime',
    'app_private.owner_insight_action_current',
    'delete'
  )),
  false,
  'runtime cannot delete owner actions'
);

SET ROLE peekaplate_runtime;

SELECT is(
  (SELECT count(*) FROM app_private.owner_insight_action_current),
  0::bigint,
  'runtime sees no actions without tenant context'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000601',
      'insight:missing-context',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  'new row violates row-level security policy for table "owner_insight_action_current"%',
  'runtime cannot insert an action without tenant context'
);

SELECT set_config(
  'app.tenant_id',
  '00000000-0000-0000-0000-000000000101',
  true
);

SELECT lives_ok(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       note, created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000601',
      'insight:menu:001',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      'Check menu details',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  'runtime can create an action for its own tenant and canonical revision'
);

SELECT is(
  (SELECT count(*)
   FROM app_private.owner_insight_action_current
   WHERE action_id = '00000000-0000-0000-0000-000000000601'),
  1::bigint,
  'runtime can read its own action'
);

SELECT lives_ok(
  $$UPDATE app_private.owner_insight_action_current
    SET status = 'active',
        note = 'Reviewed',
        version = version + 1,
        updated_by = '00000000-0000-0000-0000-000000000201',
        updated_at = now()
    WHERE action_id = '00000000-0000-0000-0000-000000000601'
      AND version = 1$$,
  'runtime can update an action in its own tenant'
);

SELECT is(
  (SELECT version
   FROM app_private.owner_insight_action_current
   WHERE action_id = '00000000-0000-0000-0000-000000000601'),
  2,
  'action update increments its version'
);

SELECT set_config(
  'app.tenant_id',
  '00000000-0000-0000-0000-000000000102',
  true
);

SELECT is(
  (SELECT count(*) FROM app_private.owner_insight_action_current),
  0::bigint,
  'Tenant B cannot read Tenant A actions'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000602',
      'insight:cross-tenant',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  'new row violates row-level security policy for table "owner_insight_action_current"%',
  'Tenant B cannot insert an action for Tenant A'
);

RESET ROLE;

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000102',
      '00000000-0000-0000-0000-000000000603',
      'insight:wrong-revision',
      '00000000-0000-0000-0000-000000000502',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%violates foreign key constraint%',
  'action cannot reference another tenant menu revision'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       status, created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000604',
      'insight:bad-status',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      'pending',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%violates check constraint%',
  'unsupported action status is rejected'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000605',
      'insight:bad-category',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'Invalid Category',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%violates check constraint%',
  'invalid category slug is rejected'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       note, created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000606',
      'insight:long-note',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      repeat('x', 501),
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%violates check constraint%',
  'note longer than 500 characters is rejected'
);

SELECT throws_like(
  $$INSERT INTO app_private.owner_insight_action_current
      (tenant_id, action_id, insight_key, menu_id, menu_revision_id, category,
       note, created_by, updated_by)
    VALUES (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000607',
      'insight:blank-note',
      '00000000-0000-0000-0000-000000000501',
      '00000000-0000-0000-0000-000000000511',
      'description_update',
      '   ',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%violates check constraint%',
  'blank note is rejected'
);

SELECT * FROM finish();
ROLLBACK;
