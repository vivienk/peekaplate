BEGIN;
SELECT plan(8);
INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Staff venue'),
  ('00000000-0000-0000-0000-000000000102', 'Other venue');
INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000201', 'editor'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000202', 'viewer'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000201', 'owner');
INSERT INTO app_private.menu_review_subject
  (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash,
   asset_approval_id, asset_manifest_hash)
VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000501',
   '00000000-0000-0000-0000-000000000511', '00000000-0000-0000-0000-000000000521',
   repeat('a', 64), '00000000-0000-0000-0000-000000000531', repeat('b', 64)),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000502',
   '00000000-0000-0000-0000-000000000512', '00000000-0000-0000-0000-000000000522',
   repeat('c', 64), '00000000-0000-0000-0000-000000000532', repeat('d', 64));
INSERT INTO app_private.menu_approval
  (tenant_id, approval_id, menu_id, review_version, menu_revision_id,
   content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000541',
   '00000000-0000-0000-0000-000000000501', 1, '00000000-0000-0000-0000-000000000511',
   '00000000-0000-0000-0000-000000000521', repeat('a', 64),
   '00000000-0000-0000-0000-000000000531', repeat('b', 64),
   '00000000-0000-0000-0000-000000000201'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000542',
   '00000000-0000-0000-0000-000000000502', 1, '00000000-0000-0000-0000-000000000512',
   '00000000-0000-0000-0000-000000000522', repeat('c', 64),
   '00000000-0000-0000-0000-000000000532', repeat('d', 64),
   '00000000-0000-0000-0000-000000000201');

INSERT INTO app_private.menu_publication_current
(tenant_id,menu_id,version,publication_id,approval_id,publication_hash,availability_version,status)
VALUES ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000501',1,'00000000-0000-0000-0000-000000000551','00000000-0000-0000-0000-000000000541',repeat('e',64),1,'published'),
('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000502',1,'00000000-0000-0000-0000-000000000552','00000000-0000-0000-0000-000000000542',repeat('f',64),1,'withdrawn');
SET LOCAL ROLE peekaplate_runtime;
SELECT is((SELECT count(*) FROM app_private.list_published_restaurants(NULL)),1::bigint,'discovery sees published scope without tenant session');
SELECT is((SELECT "menuId"::text FROM app_private.list_published_restaurants(NULL)),'00000000-0000-0000-0000-000000000501','withdrawn menu excluded');
SELECT is((SELECT count(*) FROM app_private.list_published_restaurants('00000000-0000-0000-0000-000000000101')),0::bigint,'cursor excludes delivered venue');
RESET ROLE;
UPDATE app_private.menu_publication_current SET status='withdrawn';
SET LOCAL ROLE peekaplate_runtime;
SELECT is((SELECT count(*) FROM app_private.list_published_restaurants(NULL)),0::bigint,'withdrawal removes venue immediately');
RESET ROLE;
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid='app_private.list_published_restaurants(uuid)'::regprocedure), 'directory pins definer search path');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc, LATERAL aclexplode(proacl) a WHERE oid='app_private.list_published_restaurants(uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'), 'PUBLIC cannot execute directory function');
SELECT ok(has_function_privilege('peekaplate_runtime','app_private.list_published_restaurants(uuid)','EXECUTE'), 'runtime can read public scopes');
SELECT ok(NOT pg_has_role('peekaplate_runtime','peekaplate_public_link_reader','MEMBER'), 'runtime cannot become directory owner');
SELECT * FROM finish();
ROLLBACK;
