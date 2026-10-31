BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

-- Setup test venues
INSERT INTO app_private.venues (id, name) VALUES
  ('00000000-0000-0000-0000-000000000501', 'Ingestion Venue A'),
  ('00000000-0000-0000-0000-000000000502', 'Ingestion Venue B');

-- 1. Table existence and RLS verification
SELECT has_table('app_private', 'menu_ingestion_jobs', 'menu_ingestion_jobs table exists');
SELECT has_table('app_private', 'dish_drafts', 'dish_drafts table exists');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.menu_ingestion_jobs'::regclass), true, 'jobs RLS is forced');
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app_private.dish_drafts'::regclass), true, 'drafts RLS is forced');

-- 2. Privileges
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.menu_ingestion_jobs', 'insert, update, select')), true, 'runtime has job CRUD (no delete)');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.menu_ingestion_jobs', 'delete')), false, 'runtime cannot delete jobs');
SELECT is((SELECT has_table_privilege('peekaplate_runtime', 'app_private.dish_drafts', 'delete')), false, 'runtime cannot delete drafts');

-- 3. Runtime execution under tenant context
SET ROLE peekaplate_runtime;

-- Missing tenant context fails closed
SELECT throws_like(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key)
    VALUES ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000501', 'pdf', 'key_1')$$,
  'new row violates row-level security policy for table "menu_ingestion_jobs"%',
  'runtime cannot insert job without app.tenant_id context'
);

-- Establish Venue A context
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000501', true);

SELECT lives_ok(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key, status)
    VALUES ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000501', 'pdf', 'key_1', 'queued')$$,
  'runtime can insert job for own tenant'
);

-- Insert draft with unconstrained numeric price and explicit zero price
SELECT lives_ok(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, draft_index, name, description, category, price_amount, price_currency, source_id, source_text, evidence)
    VALUES
      ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000601',
       'draft:soup_01', 0, 'Tomato Soup', 'Warm soup', 'Starters', 0.00, 'CAD', 'src_1', 'Tomato Soup $0.00', '{"spans": [{"start": 0, "end": 17}]}'::jsonb)$$,
  'runtime can insert draft with explicit 0.00 price'
);

-- Insert draft preserving subcategory, category_page_number, price_text, candidate_id with null price_amount (multi-option)
SELECT lives_ok(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, candidate_id, draft_index, name, description, category, subcategory, category_page_number, price_text, price_amount, price_currency, source_id, source_text, evidence)
    VALUES
      ('00000000-0000-0000-0000-000000000707', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000601',
       'draft:soup_v2', 'cand:soup_v2', 3, 'Split Pea Soup', 'Hot soup', 'Starters', 'Soups', 1, '8.50 / 12.50 CAD', NULL, 'CAD', 'src_1', 'Split Pea Soup 8.50 / 12.50 CAD', '{"spans": [{"start": 0, "end": 31}]}'::jsonb)$$,
  'runtime can insert draft with subcategory, category_page_number, price_text, and null price_amount'
);

-- Rejects unauthorized extraction_status (must be needs_review)
SELECT throws_like(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, draft_index, name, source_id, source_text, evidence, extraction_status)
    VALUES
      ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000601',
       'draft:soup_02', 1, 'Bread', 'src_1', 'Bread $2.00', '{}'::jsonb, 'approved')$$,
  'new row for relation "dish_drafts" violates check constraint "dish_drafts_extraction_status_check"%',
  'extraction_status rejects approved on draft creation'
);

-- Rejects review_status pending when reviewed_by is populated
SELECT throws_like(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, draft_index, name, source_id, source_text, evidence, review_status, reviewed_by)
    VALUES
      ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000601',
       'draft:soup_03', 2, 'Salad', 'src_1', 'Salad $5.00', '{}'::jsonb, 'pending', '00000000-0000-0000-0000-000000000801')$$,
  'new row for relation "dish_drafts" violates check constraint "dish_drafts_check%',
  'pending draft cannot have reviewed_by populated'
);

-- Duplicate idempotency key fails
SELECT throws_like(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key)
    VALUES ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000501', 'pdf', 'key_1')$$,
  'duplicate key value violates unique constraint "menu_ingestion_jobs_tenant_id_idempotency_key_key"%',
  'duplicate idempotency key rejected for same venue'
);

-- Switch tenant context to Venue B
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000502', true);

-- Venue B cannot see Venue A jobs or drafts
SELECT is((SELECT count(*) FROM app_private.menu_ingestion_jobs), 0::bigint, 'Venue B sees 0 jobs from Venue A');
SELECT is((SELECT count(*) FROM app_private.dish_drafts), 0::bigint, 'Venue B sees 0 drafts from Venue A');

-- Cross-tenant foreign key violation (Venue B trying to create draft for Venue A job)
SELECT throws_like(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, draft_index, name, source_id, source_text, evidence)
    VALUES
      ('00000000-0000-0000-0000-000000000704', '00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000601',
       'draft:cross', 0, 'Cross Draft', 'src_1', 'Cross', '{}'::jsonb)$$,
  'insert or update on table "dish_drafts" violates foreign key constraint%',
  'cross-tenant foreign key between draft and job rejected'
);

-- 4. Composite Foreign Key Deletion Behavior Verification
-- Setup published dish in dish_current for Venue B
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000502', true);
INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key, status, started_at, finished_at)
  VALUES ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000502', 'pdf', 'key_b1', 'complete', now(), now());

INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
  VALUES ('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000888', 1, '00000000-0000-0000-0000-000000000999', 'Active Dish', 'Desc');

-- Draft referencing published dish
INSERT INTO app_private.dish_drafts
  (id, tenant_id, job_id, draft_id, draft_index, name, source_id, source_text, evidence, review_status, reviewed_by, reviewed_at, published_dish_id)
VALUES
  ('00000000-0000-0000-0000-000000000705', '00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000603',
   'draft:pub', 0, 'Active Dish', 'src_1', 'Active Dish', '{}'::jsonb, 'accepted', '00000000-0000-0000-0000-000000000201', now(), '00000000-0000-0000-0000-000000000888');

RESET ROLE;

-- Admin deletes from dish_current; asserts ON DELETE SET NULL (published_dish_id) unlinks publication without violating tenant_id NOT NULL
DELETE FROM app_private.dish_current WHERE tenant_id = '00000000-0000-0000-0000-000000000502' AND dish_id = '00000000-0000-0000-0000-000000000888';

SELECT is(
  (SELECT published_dish_id FROM app_private.dish_drafts WHERE id = '00000000-0000-0000-0000-000000000705'),
  NULL,
  'ON DELETE SET NULL (published_dish_id) unlinks published_dish_id while preserving draft'
);
SELECT is(
  (SELECT tenant_id FROM app_private.dish_drafts WHERE id = '00000000-0000-0000-0000-000000000705'),
  '00000000-0000-0000-0000-000000000502'::uuid,
  'draft tenant_id remains preserved and NOT NULL'
);

-- 5. Automated supersession without human reviewer metadata
SET ROLE peekaplate_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000502', true);
SELECT lives_ok(
  $$INSERT INTO app_private.dish_drafts
      (id, tenant_id, job_id, draft_id, draft_index, name, source_id, source_text, evidence, review_status, review_warnings)
    VALUES
      ('00000000-0000-0000-0000-000000000706', '00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000603',
       'draft:superseded_01', 1, 'Old Item', 'src_1', 'Old Item', '{}'::jsonb, 'superseded', ARRAY['superseded_by_retry'])$$,
  'runtime can create superseded draft without reviewed_by/reviewed_at'
);

-- 6. Finding C: Incomplete job requires finished_at timestamptz (check constraint verification)
SELECT throws_like(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key, status, finished_at)
    VALUES ('00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000502', 'pdf', 'key_inc_null', 'incomplete', NULL)$$,
  'new row for relation "menu_ingestion_jobs" violates check constraint "menu_ingestion_jobs_check%',
  'incomplete job requires finished_at NOT NULL'
);

SELECT lives_ok(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key, status, started_at, finished_at)
    VALUES ('00000000-0000-0000-0000-000000000605', '00000000-0000-0000-0000-000000000502', 'pdf', 'key_inc_ok', 'incomplete', now(), now())$$,
  'incomplete job with finished_at populated satisfies check constraint'
);

SELECT lives_ok(
  $$INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key, status, started_at, finished_at)
    VALUES ('00000000-0000-0000-0000-000000000606', '00000000-0000-0000-0000-000000000502', 'pdf', 'key_failed_ok', 'failed', now(), now())$$,
  'failed job with finished_at populated satisfies check constraint'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
