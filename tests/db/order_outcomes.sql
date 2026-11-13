BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(111);

-- Setup test venues and staff memberships
INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000801', 'Order Test Venue A'),
  ('00000000-0000-0000-0000-000000000802', 'Order Test Venue B');

INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission) VALUES
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000002', 'viewer'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000003', 'editor');

-- 1. Table existence & Forced RLS
SELECT has_table('app_private', 'order_outcome_import_batches', 'order_outcome_import_batches exists');
SELECT has_table('app_private', 'order_outcome_lines', 'order_outcome_lines exists');
SELECT has_table('app_private', 'order_outcome_quarantine', 'order_outcome_quarantine exists');
SELECT has_table('app_private', 'order_outcome_conflicts', 'order_outcome_conflicts exists');
SELECT has_table('app_private', 'pos_dish_mappings', 'pos_dish_mappings exists');
SELECT has_table('app_private', 'venue_tracking_activations', 'venue_tracking_activations exists');

SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.order_outcome_import_batches'::regclass), true, 'batches RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.order_outcome_lines'::regclass), true, 'lines RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.order_outcome_quarantine'::regclass), true, 'quarantine RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.order_outcome_conflicts'::regclass), true, 'conflicts RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.pos_dish_mappings'::regclass), true, 'pos_dish_mappings RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.venue_tracking_activations'::regclass), true, 'venue_tracking_activations RLS is forced');

-- 2. Privileges
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_outcome_import_batches', 'insert, update, select')), true, 'runtime has batch insert/update/select');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_outcome_import_batches', 'delete')), false, 'runtime cannot delete batches');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_outcome_lines', 'insert, select')), true, 'runtime has lines insert/select');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_outcome_lines', 'update')), false, 'runtime cannot update lines');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_outcome_lines', 'delete')), false, 'runtime cannot delete lines');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.venue_tracking_activations', 'insert, select')), true, 'runtime has venue_tracking_activations insert/select');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.venue_tracking_activations', 'update')), false, 'runtime cannot update venue_tracking_activations');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.venue_tracking_activations', 'delete')), false, 'runtime cannot delete venue_tracking_activations');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.pos_dish_mappings', 'select')), true, 'runtime has pos_dish_mappings select');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.pos_dish_mappings', 'insert')), false, 'runtime cannot insert pos_dish_mappings');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.pos_dish_mappings', 'update')), false, 'runtime cannot update pos_dish_mappings');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.pos_dish_mappings', 'delete')), false, 'runtime cannot delete pos_dish_mappings');

-- 3. Execution under peekaplate_runtime without tenant context fails closed
SET ROLE peekaplate_runtime;

SELECT throws_like(
  $$INSERT INTO app_private.order_outcome_import_batches
      (id, tenant_id, schema_version, source_filename, file_sha256, storage_key, created_by)
    VALUES
      ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000801',
       'pilot_order_outcome.v1', 'orders.csv', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'order-imports/801/901/source.csv', '00000000-0000-0000-0000-000000000001')$$,
  'new row violates row-level security policy for table "order_outcome_import_batches"%',
  'runtime cannot insert batch without app.tenant_id'
);

-- 4. Establish Venue A context
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);

SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_import_batches
      (id, tenant_id, schema_version, source_filename, file_sha256, storage_key, status, created_by)
    VALUES
      ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000801',
       'pilot_order_outcome.v1', 'orders.csv', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'order-imports/801/901/source.csv', 'processing', '00000000-0000-0000-0000-000000000001')$$,
  'runtime can insert batch for own tenant'
);

SELECT lives_ok(
  $$INSERT INTO app_private.venue_tracking_activations
      (tenant_id, activated_at, activated_by, source)
    VALUES
      ('00000000-0000-0000-0000-000000000801', now(), '00000000-0000-0000-0000-000000000001', 'menu_publication')$$,
  'runtime can insert server-controlled venue tracking activation'
);

SELECT throws_like(
  $$INSERT INTO app_private.venue_tracking_activations
      (tenant_id, activated_at, activated_by, source)
    VALUES
      ('00000000-0000-0000-0000-000000000801', now() - interval '10 days', '00000000-0000-0000-0000-000000000001', 'administrative')$$,
  '%Client-supplied activation timestamp is prohibited%',
  'trigger rejects client backdated activation timestamp'
);

SELECT throws_like(
  $$INSERT INTO app_private.venue_tracking_activations
      (tenant_id, activated_at, activated_by, source)
    VALUES
      ('00000000-0000-0000-0000-000000000801', now() - interval '2 seconds', '00000000-0000-0000-0000-000000000001', 'administrative')$$,
  '%Client-supplied activation timestamp is prohibited%',
  'trigger rejects client arbitrary timestamp even within seconds'
);

-- Unique (tenant_id, file_sha256) enforcement
SELECT throws_like(
  $$INSERT INTO app_private.order_outcome_import_batches
      (id, tenant_id, schema_version, source_filename, file_sha256, storage_key, created_by)
    VALUES
      ('00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000801',
       'pilot_order_outcome.v1', 'orders_copy.csv', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'order-imports/801/902/source.csv', '00000000-0000-0000-0000-000000000001')$$,
  '%order_outcome_import_batches_tenant_id_file_sha256_key%',
  'cannot insert duplicate file_sha256 for same tenant'
);

-- Permitted batch lifecycle transition: processing -> completed
SELECT lives_ok(
  $$UPDATE app_private.order_outcome_import_batches
    SET status = 'completed', finished_at = now(), accepted_rows = 1
    WHERE id = '00000000-0000-0000-0000-000000000901'$$,
  'lifecycle trigger permits processing -> completed batch transition'
);

-- Prohibited batch status transition: modifying terminal completed batch
SELECT throws_like(
  $$UPDATE app_private.order_outcome_import_batches
    SET status = 'processing'
    WHERE id = '00000000-0000-0000-0000-000000000901'$$,
  '%Cannot modify status of terminal import batch%',
  'lifecycle trigger rejects modifying terminal completed batch'
);

-- Prohibited provenance column mutation
SELECT throws_like(
  $$UPDATE app_private.order_outcome_import_batches
    SET file_sha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    WHERE id = '00000000-0000-0000-0000-000000000901'$$,
  '%Mutation of immutable import batch provenance fields is prohibited%',
  'lifecycle trigger rejects mutating file_sha256 provenance'
);

-- Prohibited batch deletion
RESET ROLE;
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_import_batches
    WHERE id = '00000000-0000-0000-0000-000000000901'$$,
  '%Deleting or truncating order outcome import batches is prohibited%',
  'lifecycle trigger rejects deleting batch'
);
SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);

-- Insert accepted line
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_lines
      (tenant_id, order_id, order_line_id, batch_id, ordered_at, menu_revision_id, dish_id, dish_revision_id,
       outcome_type, quantity, unit_price, currency, payload_checksum)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'ORD-101', 'LINE-1', '00000000-0000-0000-0000-000000000901',
       now(), '00000000-0000-4000-8000-000000000101', '11111111-1111-4000-8000-000000000001',
       '22222222-2222-4000-8000-000000000002', 'ordered', 1, 12.50, 'USD',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')$$,
  'runtime can insert valid order outcome line'
);

-- Distinct outcome_type (refunded) coexists on the same order_id and order_line_id append-only
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_lines
      (tenant_id, order_id, order_line_id, batch_id, ordered_at, menu_revision_id, dish_id, dish_revision_id,
       outcome_type, quantity, unit_price, currency, payload_checksum)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'ORD-101', 'LINE-1', '00000000-0000-0000-0000-000000000901',
       now(), '00000000-0000-4000-8000-000000000101', '11111111-1111-4000-8000-000000000001',
       '22222222-2222-4000-8000-000000000002', 'refunded', 1, 12.50, 'USD',
       'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')$$,
  'refunded outcome coexists append-only with ordered outcome on same order line'
);

-- Mutual price and currency constraint check
SELECT throws_like(
  $$INSERT INTO app_private.order_outcome_lines
      (tenant_id, order_id, order_line_id, batch_id, ordered_at, menu_revision_id, dish_id, dish_revision_id,
       outcome_type, quantity, unit_price, currency, payload_checksum)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'ORD-102', 'LINE-1', '00000000-0000-0000-0000-000000000901',
       now(), '00000000-0000-4000-8000-000000000101', '11111111-1111-4000-8000-000000000001',
       '22222222-2222-4000-8000-000000000002', 'ordered', 1, 12.50, NULL,
       'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$$,
  '%order_outcome_lines_check%',
  'price without currency violates check constraint'
);

-- Insert quarantine row
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_quarantine
      (id, tenant_id, batch_id, row_index, reason_code, field_name, diagnostic_message)
    VALUES
      ('00000000-0000-0000-0000-000000000903', '00000000-0000-0000-0000-000000000801',
       '00000000-0000-0000-0000-000000000901', 3, 'unmatched_dish', 'dish_id',
       'Dish not found in published menu bundle')$$,
  'runtime can insert quarantine record'
);

-- Insert quarantine row with before_tracking_start
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_quarantine
      (id, tenant_id, batch_id, row_index, reason_code, field_name, diagnostic_message)
    VALUES
      ('00000000-0000-0000-0000-000000000904', '00000000-0000-0000-0000-000000000801',
       '00000000-0000-0000-0000-000000000901', 4, 'before_tracking_start', 'ordered_at',
       'Order timestamp is before restaurant tracking start date')$$,
  'runtime can insert quarantine record for before_tracking_start'
);

-- Insert quarantine row with missing_tracking_start_evidence
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_quarantine
      (id, tenant_id, batch_id, row_index, reason_code, field_name, diagnostic_message)
    VALUES
      ('00000000-0000-0000-0000-000000000905', '00000000-0000-0000-0000-000000000801',
       '00000000-0000-0000-0000-000000000901', 5, 'missing_tracking_start_evidence', 'ordered_at',
       'Venue tracking start evidence is not established')$$,
  'runtime can insert quarantine record for missing_tracking_start_evidence'
);

-- Security Trust Boundary: peekaplate_runtime cannot insert into pos_dish_mappings
-- Even if a runtime caller attempts to forge app.actor_id to an authorized owner UUID,
-- table-level permissions strictly deny INSERT to peekaplate_runtime
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000001', true);
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status, reviewed_by, reviewed_at)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001',
       'approved', '00000000-0000-0000-0000-000000000001', now())$$,
  '%permission denied for table pos_dish_mappings%',
  'runtime caller cannot insert POS dish mapping even with forged app.actor_id'
);

-- Administrative POS dish mapping workflow (executed via administrative role / migration runner)
RESET ROLE;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);

-- POS dish mapping: missing app.actor_id is rejected
SELECT set_config('app.actor_id', '', true);
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001', 'pending')$$,
  '%Trusted session actor context (app.actor_id) is required%',
  'mapping insertion with missing app.actor_id is rejected'
);

-- POS dish mapping: empty/whitespace app.actor_id is rejected
SELECT set_config('app.actor_id', '   ', true);
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001', 'pending')$$,
  '%Trusted session actor context (app.actor_id) is required%',
  'mapping insertion with empty actor is rejected'
);

-- POS dish mapping: invalid non-UUID app.actor_id is rejected
SELECT set_config('app.actor_id', 'invalid-non-uuid-actor', true);
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001', 'pending')$$,
  '%Invalid actor context (app.actor_id must be a valid UUID)%',
  'mapping insertion with non-UUID actor is rejected'
);

-- POS dish mapping: viewer cannot create or modify mappings
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000002', true); -- Actor 2 is viewer
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001', 'pending')$$,
  '%Current actor is not authorized to create or modify POS dish mappings%',
  'authenticated session viewer cannot insert POS dish mapping'
);

-- POS dish mapping: approved status requires reviewed_by and reviewed_at
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000001', true); -- Actor 1 is owner
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status, reviewed_by, reviewed_at)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001',
       'approved', NULL, NULL)$$,
  '%Approved POS dish mapping requires reviewed_by and reviewed_at%',
  'approved POS mapping requires reviewed_by and reviewed_at'
);

-- POS dish mapping: impersonation prevention (reviewed_by must match authenticated session actor)
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status, reviewed_by, reviewed_at)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001',
       'approved', '00000000-0000-0000-0000-000000000003', now())$$, -- Actor 3 is editor
  '%Reviewer identity must match the authenticated session actor%',
  'actor cannot impersonate another authorized reviewer'
);

-- Valid approved POS mapping by staff owner
SELECT lives_ok(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status, reviewed_by, reviewed_at)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-01', '11111111-1111-4000-8000-000000000001',
       'approved', '00000000-0000-0000-0000-000000000001', now())$$,
  'authenticated staff owner can insert reviewed approved POS dish mapping'
);

-- Preserve reviewer history during membership removal (Finding C)
-- Normal membership removal operation succeeds without 23503 foreign key violation
SELECT lives_ok(
  $$DELETE FROM app_private.staff_membership
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'
      AND actor_id = '00000000-0000-0000-0000-000000000001'$$,
  'removing membership for past reviewer succeeds'
);

-- Historical mapping retains reviewer UUID provenance
SELECT is(
  (SELECT reviewed_by FROM app_private.pos_dish_mappings
   WHERE tenant_id = '00000000-0000-0000-0000-000000000801' AND pos_item_code = 'POS-ITEM-01'),
  '00000000-0000-0000-0000-000000000001'::uuid,
  'historical mapping preserves reviewer UUID provenance after membership removal'
);

-- Removed member can no longer create or modify mappings
SELECT throws_like(
  $$INSERT INTO app_private.pos_dish_mappings
      (tenant_id, pos_item_code, dish_id, review_status)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'POS-ITEM-02', '11111111-1111-4000-8000-000000000001', 'pending')$$,
  '%Current actor is not authorized to create or modify POS dish mappings%',
  'removed staff actor cannot create POS dish mapping'
);

-- Re-establish owner membership for subsequent tests
INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission)
VALUES ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000001', 'owner');

-- Modifying mapped dish without re-review is rejected
SELECT throws_like(
  $$UPDATE app_private.pos_dish_mappings
    SET dish_id = '22222222-2222-4000-8000-000000000002'
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801' AND pos_item_code = 'POS-ITEM-01'$$,
  '%Modifying mapped dish requires re-review; cannot silently retain approved status%',
  'trigger rejects silently modifying dish_id of approved mapping without re-review'
);

-- Verify runtime can SELECT approved mapping for ingestion resolution, but cannot UPDATE
SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);

SELECT is(
  (SELECT count(*)::int FROM app_private.pos_dish_mappings WHERE review_status = 'approved'),
  1,
  'runtime caller can select approved POS dish mappings for ingestion resolution'
);

SELECT throws_like(
  $$UPDATE app_private.pos_dish_mappings
    SET dish_name = 'Tampered Dish Name'
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801' AND pos_item_code = 'POS-ITEM-01'$$,
  '%permission denied for table pos_dish_mappings%',
  'runtime caller cannot update POS dish mappings'
);

-- Insert conflict row
SELECT lives_ok(
  $$INSERT INTO app_private.order_outcome_conflicts
      (tenant_id, order_id, order_line_id, outcome_type, batch_id, existing_checksum, incoming_checksum)
    VALUES
      ('00000000-0000-0000-0000-000000000801', 'ORD-101', 'LINE-1', 'ordered', '00000000-0000-0000-0000-000000000901',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')$$,
  'runtime can insert conflict record'
);

-- Reset to superuser to test append-only trigger rejection
RESET ROLE;

SELECT throws_like(
  $$UPDATE app_private.order_outcome_lines
    SET quantity = 5
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801' AND order_id = 'ORD-101'$$,
  '%append-only table order_outcome_lines rejects UPDATE%',
  'append-only trigger rejects UPDATE on order_outcome_lines'
);

SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_lines
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%append-only table order_outcome_lines rejects DELETE%',
  'append-only trigger rejects DELETE on order_outcome_lines'
);

SELECT throws_like(
  $$UPDATE app_private.order_outcome_quarantine
    SET diagnostic_message = 'edited'
    WHERE id = '00000000-0000-0000-0000-000000000903'$$,
  '%append-only table order_outcome_quarantine rejects UPDATE%',
  'append-only trigger rejects UPDATE on order_outcome_quarantine'
);

SELECT throws_like(
  $$UPDATE app_private.order_outcome_conflicts
    SET incoming_checksum = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    WHERE order_id = 'ORD-101'$$,
  '%append-only table order_outcome_conflicts rejects UPDATE%',
  'append-only trigger rejects UPDATE on order_outcome_conflicts'
);

SELECT throws_like(
  $$UPDATE app_private.venue_tracking_activations
    SET activated_at = now()
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%Modifying venue tracking activation timestamp is prohibited%',
  'trigger rejects modifying venue tracking activation'
);

SELECT throws_like(
  $$DELETE FROM app_private.venue_tracking_activations
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%Deleting venue tracking activation record is prohibited%',
  'trigger rejects deleting venue tracking activation'
);

-- Cross-tenant RLS isolation: Venue B context cannot see Venue A records
SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000802', true);

SELECT is((SELECT count(*)::int FROM app_private.order_outcome_import_batches), 0, 'Venue B sees 0 batches from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.order_outcome_lines), 0, 'Venue B sees 0 lines from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.order_outcome_quarantine), 0, 'Venue B sees 0 quarantine rows from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.order_outcome_conflicts), 0, 'Venue B sees 0 conflict rows from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.venue_tracking_activations), 0, 'Venue B sees 0 activations from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.pos_dish_mappings), 0, 'Venue B sees 0 POS mappings from Venue A');

-- 5. Reporting isolation check: owner_observation_v1 remains completely unaffected
SELECT is((SELECT count(*)::int FROM app_private.owner_observation_v1 WHERE tenant_id = '00000000-0000-0000-0000-000000000801'), 0, 'owner_observation_v1 is unaffected by order outcomes');

-- 6. S6-DATA-14.1 & 14.2: Agreement acceptance, deletion requests, and bypass protection
RESET ROLE;
SELECT has_table('app_private', 'pilot_order_agreement_acceptances', 'pilot_order_agreement_acceptances exists');
SELECT has_table('app_private', 'order_data_deletion_requests', 'order_data_deletion_requests exists');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.pilot_order_agreement_acceptances'::regclass), true, 'agreement acceptances RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.order_data_deletion_requests'::regclass), true, 'deletion requests RLS is forced');

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000003', true);

SELECT throws_like(
  $$INSERT INTO app_private.pilot_order_agreement_acceptances (tenant_id, agreement_version, accepted_by)
    VALUES ('00000000-0000-0000-0000-000000000801', 'v0.1', '00000000-0000-0000-0000-000000000003')$$,
  '%owner%',
  'editor cannot accept pilot order agreement'
);

SELECT throws_like(
  $$INSERT INTO app_private.order_data_deletion_requests (id, tenant_id, requested_by, reason, status)
    VALUES ('00000000-0000-4000-8000-000000000999', '00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000003', 'pilot_withdrawal', 'requested')$$,
  '%owner%',
  'editor cannot submit order-data deletion request'
);

SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000001', true);
SELECT lives_ok(
  $$INSERT INTO app_private.order_data_deletion_requests (id, tenant_id, requested_by, reason, status)
    VALUES ('00000000-0000-4000-8000-000000000998', '00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000001', 'pilot_withdrawal', 'requested')$$,
  'owner can submit order-data deletion request'
);

SELECT set_config('app.order_data_deletion_active', 'on', true);
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_lines
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%permission denied for table order_outcome_lines%',
  'runtime lacks DELETE privilege even when spoofing deletion GUC'
);
SELECT set_config('app.order_data_deletion_active', 'off', true);

RESET ROLE;
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_lines
    WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%append-only table order_outcome_lines rejects DELETE%',
  'append-only trigger rejects DELETE for privileged role when deletion GUC is off'
);
SET ROLE peekaplate_runtime;

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000802', true);
SELECT is((SELECT count(*)::int FROM app_private.pilot_order_agreement_acceptances), 0, 'Venue B sees 0 agreement acceptances from Venue A');
SELECT is((SELECT count(*)::int FROM app_private.order_data_deletion_requests), 0, 'Venue B sees 0 deletion requests from Venue A');

-- 7. S6-DATA-14 Hardening: Role separation, lifecycle state machine, and verification constraints
RESET ROLE;
SELECT is((SELECT has_function_privilege('peekaplate_runtime', 'app_private.delete_venue_order_data(uuid,uuid,uuid,uuid)', 'execute')), false, 'runtime lacks EXECUTE on delete_venue_order_data');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.order_data_deletion_requests', 'update')), false, 'runtime lacks UPDATE on order_data_deletion_requests');
SELECT is((SELECT has_function_privilege('peekaplate_deletion_operator', 'app_private.delete_venue_order_data(uuid,uuid,uuid,uuid)', 'execute')), true, 'operator has EXECUTE on delete_venue_order_data');
SELECT is((SELECT has_function_privilege('peekaplate_deletion_checker', 'app_private.delete_venue_order_data(uuid,uuid,uuid,uuid)', 'execute')), false, 'checker lacks EXECUTE on delete_venue_order_data');
SELECT is((SELECT has_function_privilege('peekaplate_deletion_checker', 'app_private.record_deletion_verification(uuid,uuid,uuid,text,text)', 'execute')), true, 'checker has EXECUTE on record_deletion_verification');
SELECT is((SELECT has_table_privilege('peekaplate_deletion_checker', 'app_private.order_data_deletion_requests', 'update')), false, 'checker lacks direct UPDATE on order_data_deletion_requests');

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000001', true);
SELECT throws_like(
  $$UPDATE app_private.order_data_deletion_requests
    SET status = 'executing'
    WHERE id = '00000000-0000-4000-8000-000000000998'$$,
  '%permission denied%',
  'runtime cannot UPDATE order_data_deletion_requests'
);
SELECT throws_like(
  $$SELECT * FROM app_private.delete_venue_order_data(
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-4000-8000-000000000998',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-4000-8000-000000000777'
    )$$,
  '%permission denied%',
  'runtime cannot EXECUTE delete_venue_order_data'
);

SELECT set_config('app.deletion_lifecycle_context', 'reconciliation', true);
SELECT throws_like(
  $$INSERT INTO app_private.order_data_deletion_requests
      (id, tenant_id, requested_by, reason, status, reconciled_from_r2, verified_by, verification_outcome)
    VALUES
      ('00000000-0000-4000-8000-000000000997', '00000000-0000-0000-0000-000000000801',
       '00000000-0000-0000-0000-000000000001', 'pilot_withdrawal', 'verified', true,
       '00000000-0000-0000-0000-000000000001', 'PASS')$$,
  '%cannot insert%',
  'runtime cannot forge reconciled_from_r2 or verified status even when spoofing lifecycle GUC'
);
SELECT set_config('app.deletion_lifecycle_context', '', true);

SELECT set_config('app.order_data_deletion_active', 'on', true);
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_quarantine WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%permission denied%',
  'runtime lacks DELETE on order_outcome_quarantine even with deletion GUC'
);
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_conflicts WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%permission denied%',
  'runtime lacks DELETE on order_outcome_conflicts even with deletion GUC'
);
SELECT throws_like(
  $$DELETE FROM app_private.order_outcome_import_batches WHERE tenant_id = '00000000-0000-0000-0000-000000000801'$$,
  '%permission denied%',
  'runtime lacks DELETE on order_outcome_import_batches even with deletion GUC'
);
SELECT set_config('app.order_data_deletion_active', 'off', true);

-- Seed control batch in Venue B to verify purge isolation
RESET ROLE;
INSERT INTO app_private.order_outcome_import_batches
  (id, tenant_id, schema_version, created_by, source_filename, file_sha256, storage_key, status, finished_at)
VALUES
  ('00000000-0000-0000-0000-000000000909', '00000000-0000-0000-0000-000000000802', 'pilot_order_outcome.v1',
   '00000000-0000-0000-0000-000000000001', 'control.csv',
   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
   'order-imports/00000000-0000-0000-0000-000000000802/control/source.csv', 'completed', now());

SET ROLE peekaplate_deletion_operator;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000099', true);
SELECT throws_like(
  $$UPDATE app_private.order_data_deletion_requests
    SET status = 'verified'
    WHERE id = '00000000-0000-4000-8000-000000000998'$$,
  '%Illegal deletion lifecycle transition%',
  'operator cannot skip directly from requested to verified'
);

SELECT throws_like(
  $$SELECT * FROM app_private.delete_venue_order_data(
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-4000-8000-000000000998',
      '00000000-0000-0000-0000-000000000099',
      '00000000-0000-4000-8000-000000000777'
    )$$,
  '%executing or r2_deleted%',
  'delete_venue_order_data rejects requests still in requested state'
);

UPDATE app_private.order_data_deletion_requests
SET status = 'executing',
    executed_by = '00000000-0000-0000-0000-000000000099',
    execution_token = '00000000-0000-4000-8000-000000000777',
    execution_lease_expires_at = now() + interval '5 minutes'
WHERE id = '00000000-0000-4000-8000-000000000998';

UPDATE app_private.order_data_deletion_requests
SET status = 'r2_deleted', r2_objects_deleted = 1
WHERE id = '00000000-0000-4000-8000-000000000998';

SELECT is(
  (SELECT batches_deleted >= 1 FROM app_private.delete_venue_order_data(
    '00000000-0000-0000-0000-000000000801',
    '00000000-0000-4000-8000-000000000998',
    '00000000-0000-0000-0000-000000000099',
    '00000000-0000-4000-8000-000000000777'
  )),
  true,
  'operator purges Venue A order data via delete_venue_order_data'
);

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM app_private.order_outcome_import_batches WHERE tenant_id = '00000000-0000-0000-0000-000000000802'),
  1,
  'Venue B control data is preserved after Venue A deletion'
);

SET ROLE peekaplate_deletion_operator;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000099', true);
UPDATE app_private.order_data_deletion_requests
SET status = 'db_deleted',
    completed_at = now()
WHERE id = '00000000-0000-4000-8000-000000000998';
SELECT lives_ok(
  $$UPDATE app_private.order_data_deletion_requests
    SET status = 'awaiting_verification',
        completed_at = now(),
        receipt_written_at = now(),
        execution_token = NULL,
        execution_lease_expires_at = NULL
    WHERE id = '00000000-0000-4000-8000-000000000998'$$,
  'operator transitions db_deleted request to awaiting_verification'
);

SET ROLE peekaplate_deletion_checker;
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000099', true);
SELECT throws_like(
  $$SELECT * FROM app_private.record_deletion_verification(
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-4000-8000-000000000998',
      '00000000-0000-0000-0000-000000000099',
      'PASS',
      'CU-166'
    )$$,
  '%Independent checker cannot be the requester or executing operator%',
  'checker cannot self-approve deletion executed by same actor'
);

SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000088', true);
SELECT is(
  (SELECT status FROM app_private.record_deletion_verification(
    '00000000-0000-0000-0000-000000000801',
    '00000000-0000-4000-8000-000000000998',
    '00000000-0000-0000-0000-000000000088',
    'FAIL',
    'CU-166'
  )),
  'awaiting_verification',
  'checker FAIL keeps request in awaiting_verification'
);

SELECT is(
  (SELECT status FROM app_private.record_deletion_verification(
    '00000000-0000-0000-0000-000000000801',
    '00000000-0000-4000-8000-000000000998',
    '00000000-0000-0000-0000-000000000088',
    'PASS',
    'CU-166'
  )),
  'verified',
  'checker PASS transitions request to verified'
);

SET ROLE peekaplate_deletion_operator;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000099', true);
SELECT throws_like(
  $$UPDATE app_private.order_data_deletion_requests
    SET status = 'executing'
    WHERE id = '00000000-0000-4000-8000-000000000998'$$,
  '%Illegal deletion lifecycle transition%',
  'verified deletion request is immutable against operator updates'
);

SELECT is(
  (SELECT count(*) >= 1 FROM app_private.list_order_deletion_requests_for_reconcile()),
  true,
  'operator can list deletion requests for restore reconciliation'
);

SELECT lives_ok(
  $$SELECT * FROM app_private.reconcile_venue_order_deletion(
      '00000000-0000-4000-8000-000000000701',
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-4000-8000-000000000996',
      '00000000-0000-0000-0000-000000000099',
      now(),
      now(),
      'completed',
      0,
      'order-deletion-ledger/test/completed.json'
    )$$,
  'operator can reconcile venue order deletion from R2 ledger'
);

-- C1 & L2 deep security checks: arbitrary postgres-owned SECURITY DEFINER bypasses, direct SQL, and orphan key scope
RESET ROLE;
CREATE OR REPLACE FUNCTION app_private.test_arbitrary_postgres_definer_insert()
RETURNS void
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  INSERT INTO app_private.order_data_deletion_requests
    (id, tenant_id, requested_by, reason, status, reconciled_from_r2, verified_by, verification_outcome)
  VALUES
    ('00000000-0000-4000-8000-000000000995', '00000000-0000-0000-0000-000000000801',
     '00000000-0000-0000-0000-000000000001', 'pilot_withdrawal', 'verified', true,
     '00000000-0000-0000-0000-000000000088', 'PASS');
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION app_private.test_arbitrary_postgres_definer_insert() TO peekaplate_runtime;

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.deletion_lifecycle_context', 'reconciliation', true);
SELECT throws_like(
  $$SELECT app_private.test_arbitrary_postgres_definer_insert()$$,
  '%cannot insert reconciliation or pre-completed deletion records%',
  'arbitrary postgres-owned SECURITY DEFINER function cannot bypass C1 guard even with spoofed GUC'
);

SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT throws_like(
  $$SELECT app_private.test_arbitrary_postgres_definer_insert()$$,
  '%cannot insert reconciliation or pre-completed deletion records%',
  'runtime calling postgres-owned SECURITY DEFINER function cannot bypass C1 guard'
);

SELECT throws_like(
  $$INSERT INTO app_private.deletion_privileged_tx_grants (txid, pid, operation, session_role)
    VALUES (pg_current_xact_id(), pg_backend_pid(), 'reconciliation', current_user)$$,
  '%permission denied%',
  'runtime cannot write to deletion_privileged_tx_grants'
);

SELECT throws_like(
  $$INSERT INTO app_private.order_import_orphan_cleanups (tenant_id, batch_id, storage_key)
    VALUES ('00000000-0000-0000-0000-000000000801', '00000000-0000-4000-8000-000000000123',
            'order-imports/00000000-0000-0000-0000-000000000802/00000000-0000-4000-8000-000000000123/source.csv')$$,
  '%order_import_orphan_cleanups_storage_key_check%',
  'orphan cleanup rejects cross-venue storage_key'
);

SET ROLE peekaplate_deletion_operator;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.deletion_lifecycle_context', 'verification', true);
SELECT throws_like(
  $$INSERT INTO app_private.order_data_deletion_requests (id, tenant_id, requested_by, reason, status)
    VALUES ('00000000-0000-4000-8000-000000000994', '00000000-0000-0000-0000-000000000801',
            '00000000-0000-0000-0000-000000000001', 'pilot_withdrawal', 'requested')$$,
  '%permission denied%',
  'operator cannot directly insert deletion requests'
);

RESET ROLE;
SELECT set_config('app.deletion_lifecycle_context', '', true);
SELECT throws_like(
  $$SELECT * FROM app_private.record_deletion_verification(
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-4000-8000-000000000996',
      '00000000-0000-0000-0000-000000000088',
      'PASS',
      'CU-166'
    )$$,
  '%Trusted actor context%',
  'direct superuser call without actor context is still gated'
);

CREATE OR REPLACE FUNCTION app_private.test_arbitrary_postgres_definer_update()
RETURNS void
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  UPDATE app_private.order_data_deletion_requests
  SET status = 'failed'
  WHERE id = '00000000-0000-4000-8000-000000000996';
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION app_private.test_arbitrary_postgres_definer_update() TO peekaplate_deletion_checker;

SET ROLE peekaplate_deletion_checker;
SELECT throws_like(
  $$SELECT app_private.test_arbitrary_postgres_definer_update()$$,
  '%not authorized to update deletion lifecycle records%',
  'checker calling arbitrary postgres-owned SECURITY DEFINER update function cannot escalate to operator'
);

RESET ROLE;
INSERT INTO app_private.order_import_orphan_cleanups (tenant_id, batch_id, storage_key, status)
VALUES ('00000000-0000-0000-0000-000000000801', '00000000-0000-4000-8000-000000000555',
        'order-imports/00000000-0000-0000-0000-000000000801/00000000-0000-4000-8000-000000000555/source.csv', 'pending');

SET ROLE peekaplate_deletion_operator;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000099', true);
SELECT * FROM app_private.reconcile_venue_order_deletion(
  '00000000-0000-4000-8000-000000000702',
  '00000000-0000-0000-0000-000000000801',
  '00000000-0000-4000-8000-000000000993',
  '00000000-0000-0000-0000-000000000099',
  NULL, NULL, 'intent_only', 0, 'intent.json'
);
RESET ROLE;
SELECT is(
  (SELECT status FROM app_private.order_import_orphan_cleanups WHERE batch_id = '00000000-0000-4000-8000-000000000555'),
  'pending',
  'intent_only reconciliation does not mark pending orphan cleanups as cleaned'
);

SELECT is(
  (SELECT has_function_privilege('peekaplate_runtime', 'app_private.list_pending_orphan_cleanup_tenants()', 'execute')),
  true,
  'runtime has EXECUTE on list_pending_orphan_cleanup_tenants for scheduled cleanup'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
