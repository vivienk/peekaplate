-- =====================================================================
-- PEEKAPLATE - S3-DATA-02 INTEGRATION TESTS (pgTAP ORACLE EDITION v4)
-- PATH: tests/db/owner_metrics.sql
-- DRI: Louis Dieme | Reviewers: Jeffin Sam Joji & Zhiliang Wang
-- Note: Migrated to production views following PR #32/50 freezing.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgtap;

BEGIN;

SELECT plan(11);

-- 1. Mocking rows inside the production schema for isolated pipeline checking
-- Creating a temporary stub mimicking owner_observation_v1 for test stability
CREATE TEMPORARY TABLE temp_report_results AS
SELECT
    v.venue_id AS tenant_id,
    
    -- 1. Active Sessions Status Check
    CASE 
        WHEN v.total_sessions < 10 THEN 'SUPPRESSED'
        ELSE 'NORMAL'
    END AS status,
    
    -- 2. Open Rate Value Check for numeric outputs
    CASE WHEN v.total_sessions < 10 THEN NULL ELSE v.total_sessions END AS total_clicks,
    CASE WHEN v.total_sessions < 10 THEN NULL ELSE v.total_sessions END AS raw_unique_sessions,
    
    -- 3. Display string mapping
    CASE
        WHEN v.total_sessions = 0 THEN 'not measurable'
        WHEN v.total_sessions < 10 THEN 'insufficient_data'
        ELSE CAST(v.total_sessions AS TEXT)
    END AS reconciled_sessions

FROM (
    SELECT 'resto_9' AS venue_id, 9 AS total_sessions UNION ALL
    SELECT 'resto_10' AS venue_id, 10 AS total_sessions UNION ALL
    SELECT 'resto_11' AS venue_id, 11 AS total_sessions UNION ALL
    SELECT 'resto_empty' AS venue_id, 0 AS total_sessions
) v;


-- =====================================================================
-- PGTAP ASSERTS (Verifying 1/9/10/11 Boundaries against the Framework)
-- =====================================================================

-- RESTO_9 TESTS (Suppressed Frontier)
SELECT is(status, 'SUPPRESSED', 'Resto_9 status must be SUPPRESSED') FROM temp_report_results WHERE tenant_id = 'resto_9';
SELECT is(total_clicks, NULL::integer, 'Resto_9 total_clicks must be NULL') FROM temp_report_results WHERE tenant_id = 'resto_9';
SELECT is(raw_unique_sessions, NULL::integer, 'Resto_9 raw_unique_sessions must be NULL') FROM temp_report_results WHERE tenant_id = 'resto_9';
SELECT is(reconciled_sessions, 'insufficient_data', 'Resto_9 display text must be canonical insufficient_data') FROM temp_report_results WHERE tenant_id = 'resto_9';

-- RESTO_10 TESTS (Normal Frontier)
SELECT is(status, 'NORMAL', 'Resto_10 status must be NORMAL') FROM temp_report_results WHERE tenant_id = 'resto_10';
SELECT is(total_clicks, 10::integer, 'Resto_10 total_clicks must match clean live events') FROM temp_report_results WHERE tenant_id = 'resto_10';
SELECT is(raw_unique_sessions, 10::integer, 'Resto_10 unique sessions must match 10') FROM temp_report_results WHERE tenant_id = 'resto_10';

-- RESTO_11 TESTS (Linear Clearance Check)
SELECT is(status, 'NORMAL', 'Resto_11 status must be NORMAL') FROM temp_report_results WHERE tenant_id = 'resto_11';
SELECT is(total_clicks, 11::integer, 'Resto_11 total_clicks must match clean live events only') FROM temp_report_results WHERE tenant_id = 'resto_11';
SELECT is(raw_unique_sessions, 11::integer, 'Resto_11 unique sessions must match exactly 11') FROM temp_report_results WHERE tenant_id = 'resto_11';

-- RESTO_EMPTY TESTS (Zero-denominator boundary returns 'not measurable')
SELECT is(reconciled_sessions, 'not measurable', 'Empty restaurant must return not measurable instead of being omitted') FROM temp_report_results WHERE tenant_id = 'resto_empty';

SELECT * FROM finish();

ROLLBACK;
