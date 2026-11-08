BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Tenant A'),
  ('00000000-0000-0000-0000-000000000102', 'Tenant B');

SELECT has_table('app_private', 'extraction_review_session', 'extraction_review_session exists');
SELECT has_table('app_private', 'candidate_review_current', 'candidate_review_current exists');

SELECT is(
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.extraction_review_session'::regclass),
  true,
  'extraction_review_session RLS is forced'
);
SELECT is(
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.candidate_review_current'::regclass),
  true,
  'candidate_review_current RLS is forced'
);

SELECT is(
  (SELECT has_table_privilege('peekaplate_runtime', 'app_private.extraction_review_session', 'select, insert')),
  true,
  'runtime can select and insert extraction_review_session'
);
SELECT is(
  (SELECT has_table_privilege('peekaplate_runtime', 'app_private.extraction_review_session', 'update, delete')),
  false,
  'runtime cannot update or delete extraction_review_session'
);

SELECT is(
  (SELECT has_table_privilege('peekaplate_runtime', 'app_private.candidate_review_current', 'select, insert, update')),
  true,
  'runtime can select, insert, update candidate_review_current'
);
SELECT is(
  (SELECT has_table_privilege('peekaplate_runtime', 'app_private.candidate_review_current', 'delete')),
  false,
  'runtime cannot delete candidate_review_current'
);

-- Superuser creates a valid session for Tenant A
INSERT INTO app_private.extraction_review_session (
  tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
  source_id, source_sha256, payload, created_by
) VALUES (
  '00000000-0000-0000-0000-000000000101',
  'extraction:001',
  2,
  '3',
  'complete',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"candidates":[]}'::jsonb,
  '00000000-0000-0000-0000-000000000201'
);

-- Check append-only trigger prevents updates/deletes on extraction_review_session even by superuser
SELECT throws_like(
  $$UPDATE app_private.extraction_review_session SET extraction_status = 'failed' WHERE extraction_id = 'extraction:001'$$,
  'append-only table extraction_review_session rejects UPDATE',
  'extraction_review_session rejects UPDATE via append-only trigger'
);
SELECT throws_like(
  $$DELETE FROM app_private.extraction_review_session WHERE extraction_id = 'extraction:001'$$,
  'append-only table extraction_review_session rejects DELETE',
  'extraction_review_session rejects DELETE via append-only trigger'
);

-- Switch to peekaplate_runtime and test RLS
SET ROLE peekaplate_runtime;

-- Without tenant context, returns 0 rows
SELECT is(
  (SELECT count(*) FROM app_private.extraction_review_session),
  0::bigint,
  'runtime sees 0 sessions without app.tenant_id'
);

-- Set tenant to Tenant A
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000101', true);
SELECT is(
  (SELECT count(*) FROM app_private.extraction_review_session WHERE extraction_id = 'extraction:001'),
  1::bigint,
  'runtime sees own tenant session'
);

-- Tenant A creates a candidate review
SELECT lives_ok(
  $$INSERT INTO app_private.candidate_review_current (
      tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
      review_status, corrected_fields, edited_fields, incomplete_fields, reviewed_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:001', 'draft:c01',
      '00000000-0000-0000-0000-000000000501', 1, '00000000-0000-0000-0000-000000000601',
      'corrected', '{"name":"Soup"}'::jsonb, ARRAY['name'], '{}'::text[],
      '00000000-0000-0000-0000-000000000201'
    )$$,
  'runtime can insert candidate review in own tenant'
);

-- Tenant A updates the review
SELECT lives_ok(
  $$UPDATE app_private.candidate_review_current
    SET version = 2, revision_id = '00000000-0000-0000-0000-000000000602',
        corrected_fields = '{"name":"Soup 2"}'::jsonb
    WHERE extraction_id = 'extraction:001' AND candidate_id = 'draft:c01'$$,
  'runtime can update candidate review in own tenant'
);

-- Switch to Tenant B
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000102', true);
SELECT is(
  (SELECT count(*) FROM app_private.extraction_review_session),
  0::bigint,
  'Tenant B sees 0 Tenant A sessions'
);
SELECT is(
  (SELECT count(*) FROM app_private.candidate_review_current),
  0::bigint,
  'Tenant B sees 0 Tenant A candidate reviews'
);

-- Cross-tenant write by Tenant B targeting Tenant A fails RLS
SELECT throws_like(
  $$INSERT INTO app_private.candidate_review_current (
      tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
      review_status, corrected_fields, edited_fields, incomplete_fields, reviewed_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:001', 'draft:c02',
      '00000000-0000-0000-0000-000000000502', 1, '00000000-0000-0000-0000-000000000603',
      'rejected', '{}'::jsonb, '{}'::text[], '{}'::text[],
      '00000000-0000-0000-0000-000000000201'
    )$$,
  'new row violates row-level security policy for table "candidate_review_current"%',
  'cross-tenant insert blocked by RLS'
);

RESET ROLE;

-- Check constraints tests (run as superuser to isolate constraint violations)
-- 1. Invalid schema / pipeline pairing
SELECT throws_like(
  $$INSERT INTO app_private.extraction_review_session (
      tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
      source_id, source_sha256, payload, created_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:002', 1, '3', 'complete',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '{"candidates":[]}'::jsonb, '00000000-0000-0000-0000-000000000201'
    )$$,
  '%check constraint%extraction_review_session_check%',
  'schema 1 with pipeline 3 violates check constraint'
);

-- 2. Rejected candidate review with non-empty corrected_fields
SELECT throws_like(
  $$INSERT INTO app_private.candidate_review_current (
      tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
      review_status, corrected_fields, edited_fields, incomplete_fields, reviewed_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:001', 'draft:c_bad_rej',
      '00000000-0000-0000-0000-000000000503', 1, '00000000-0000-0000-0000-000000000604',
      'rejected', '{"name":"Bad"}'::jsonb, ARRAY['name'], '{}'::text[],
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%check constraint%candidate_review_current_check%',
  'rejected candidate with corrected_fields violates check constraint'
);

-- 3. Incomplete candidate review with empty incomplete_fields
SELECT throws_like(
  $$INSERT INTO app_private.candidate_review_current (
      tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
      review_status, corrected_fields, edited_fields, incomplete_fields, reviewed_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:001', 'draft:c_bad_inc',
      '00000000-0000-0000-0000-000000000504', 1, '00000000-0000-0000-0000-000000000605',
      'incomplete', '{}'::jsonb, '{}'::text[], '{}'::text[],
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%check constraint%candidate_review_current_check1%',
  'incomplete candidate with empty incomplete_fields violates check constraint'
);

-- 4. Corrected candidate review with empty edited_fields
SELECT throws_like(
  $$INSERT INTO app_private.candidate_review_current (
      tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
      review_status, corrected_fields, edited_fields, incomplete_fields, reviewed_by
    ) VALUES (
      '00000000-0000-0000-0000-000000000101', 'extraction:001', 'draft:c_bad_cor',
      '00000000-0000-0000-0000-000000000505', 1, '00000000-0000-0000-0000-000000000606',
      'corrected', '{}'::jsonb, '{}'::text[], '{}'::text[],
      '00000000-0000-0000-0000-000000000201'
    )$$,
  '%check constraint%candidate_review_current_check2%',
  'corrected candidate with empty edited_fields violates check constraint'
);

SELECT * FROM finish();
ROLLBACK;
