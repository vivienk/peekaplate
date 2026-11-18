BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);
SELECT is(has_table_privilege('peekaplate_runtime','app_private.venues','INSERT'),false,'runtime cannot insert venues directly');
SELECT is(has_table_privilege('peekaplate_runtime','app_private.staff_membership','INSERT'),false,'runtime cannot grant membership');
SELECT is(has_function_privilege('public','app_private.create_owner_venue(uuid,text)','EXECUTE'),false,'public cannot create restaurants');
SELECT is(has_function_privilege('peekaplate_runtime','app_private.create_owner_venue(uuid,text)','EXECUTE'),true,'runtime has narrow command execution');
SELECT is((SELECT rolbypassrls FROM pg_roles WHERE rolname='peekaplate_venue_creator'),false,'creator never bypasses RLS');
SELECT is(pg_has_role('peekaplate_runtime','peekaplate_venue_creator','MEMBER'),false,'runtime cannot assume creator role');
SET ROLE peekaplate_runtime;
SELECT set_config('app.actor_id','',true);
SELECT throws_ok($$SELECT app_private.create_owner_venue('00000000-0000-4000-8000-00000000cc01','Synthetic SQL cafe')$$,
  '42501','actor required','missing actor denied');
SELECT set_config('app.actor_id','00000000-0000-4000-8000-00000000cc02',true);
SELECT set_config('app.tenant_id','',true);
SELECT lives_ok($$SELECT app_private.create_owner_venue('00000000-0000-4000-8000-00000000cc01','Synthetic SQL cafe')$$,'fresh actor creates without existing membership');
SELECT lives_ok($$SELECT app_private.create_owner_venue('00000000-0000-4000-8000-00000000cc01','Synthetic SQL cafe')$$,'restricted replay works with initially empty tenant context');
SELECT throws_ok($$SELECT app_private.create_owner_venue('00000000-0000-4000-8000-00000000cc01','Changed cafe')$$,
  'P0003','command conflict','command identity cannot change payload');
SELECT is(current_setting('app.tenant_id',true),'','creation restores previous tenant context');
RESET ROLE;
SELECT is((SELECT count(*) FROM app_private.es_command WHERE actor_id='00000000-0000-4000-8000-00000000cc02'),1::bigint,'retry has one receipt');
SELECT is((SELECT count(*) FROM app_private.staff_membership WHERE actor_id='00000000-0000-4000-8000-00000000cc02' AND permission='owner'),1::bigint,'only current actor receives ownership');
SELECT * FROM finish();
ROLLBACK;
