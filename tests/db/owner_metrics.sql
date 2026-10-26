-- =====================================================================
-- PEEKAPLATE - S3-DATA-02 INTEGRATION TESTS (pgTAP ORACLE EDITION v4)
-- PATH: tests/db/owner_metrics.sql
-- DRI: Louis Dieme | Reviewers: Jeffin Sam Joji & Zhiliang Wang
-- Note: temp_events is a temporary scaffold; will switch to the 
-- canonical view boundary once frozen in PR #32.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgtap;

BEGIN;

SELECT plan(11);

CREATE TEMPORARY TABLE temp_events (
    id SERIAL PRIMARY KEY,
    venue_id TEXT,
    event_id TEXT,
    session_id TEXT,
    event_type TEXT,
    payload_checksum TEXT,
    traffic_class TEXT,
    occurred_at TIMESTAMP, 
    received_at TIMESTAMP
);

-- Inserting boundary test fixtures (9 / 10 / 11) and abnormal scenarios
INSERT INTO temp_events (venue_id, event_id, session_id, event_type, payload_checksum, traffic_class, occurred_at, received_at) VALUES
    -- CASE 9: Frontier 9 (Must be suppressed and counts hidden)
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha_A', 'live', NOW(), NOW()),
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha_A', 'live', NOW(), NOW()), 
    ('resto_9', 'evt_102', 'sess_02', 'dish_detail_opened', 'sha_B', 'live', NOW(), NOW()),
    ('resto_9', 'evt_103', 'sess_03', 'dish_detail_opened', 'sha_C', 'live', NOW(), NOW()),
    ('resto_9', 'evt_104', 'sess_04', 'dish_detail_opened', 'sha_D', 'live', NOW(), NOW()),
    ('resto_9', 'evt_105', 'sess_05', 'dish_detail_opened', 'sha_E', 'live', NOW(), NOW()),
    ('resto_9', 'evt_106', 'sess_06', 'dish_detail_opened', 'sha_F', 'live', NOW(), NOW()),
    ('resto_9', 'evt_107', 'sess_07', 'dish_detail_opened', 'sha_G', 'live', NOW(), NOW()),
    ('resto_9', 'evt_108', 'sess_08', 'dish_detail_opened', 'sha_H', 'live', NOW(), NOW()),
    ('resto_9', 'evt_109', 'sess_09', 'dish_detail_opened', 'sha_I', 'live', NOW(), NOW()),

    -- CASE 10: Frontier 10 (Must show metrics normally = 10)
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha_1', 'live', NOW(), NOW()),
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha_1', 'live', NOW(), NOW()), 
    ('resto_10', 'evt_202', 'sess_B', 'dish_detail_opened', 'sha_2', 'live', NOW(), NOW()),
    ('resto_10', 'evt_203', 'sess_C', 'dish_detail_opened', 'sha_3', 'live', NOW(), NOW()),
    ('resto_10', 'evt_204', 'sess_D', 'dish_detail_opened', 'sha_4', 'live', NOW(), NOW()),
    ('resto_10', 'evt_205', 'sess_E', 'dish_detail_opened', 'sha_5', 'live', NOW(), NOW()),
    ('resto_10', 'evt_206', 'sess_F', 'dish_detail_opened', 'sha_6', 'live', NOW(), NOW()),
    ('resto_10', 'evt_207', 'sess_G', 'dish_detail_opened', 'sha_7', 'live', NOW(), NOW()),
    ('resto_10', 'evt_208', 'sess_H', 'dish_detail_opened', 'sha_8', 'live', NOW(), NOW()),
    ('resto_10', 'evt_209', 'sess_I', 'dish_detail_opened', 'sha_9', 'live', NOW(), NOW()),
    ('resto_10', 'evt_210', 'sess_J', 'dish_detail_opened', 'sha_10', 'live', NOW(), NOW()),

    -- CASE 11: Frontier 11 (Must show metrics normally = 11)
    ('resto_11', 'evt_301', 'sess_x1', 'dish_detail_opened', 'sha_x', 'live', NOW(), NOW()),
    ('resto_11', 'evt_302', 'sess_x2', 'dish_detail_opened', 'sha_y', 'live', NOW(), NOW()),
    ('resto_11', 'evt_303', 'sess_x3', 'dish_detail_opened', 'sha_z', 'live', NOW(), NOW()),
    ('resto_11', 'evt_304', 'sess_x4', 'dish_detail_opened', 'sha_4', 'live', NOW(), NOW()),
    ('resto_11', 'evt_305', 'sess_x5', 'dish_detail_opened', 'sha_5', 'live', NOW(), NOW()),
    ('resto_11', 'evt_306', 'sess_x6', 'dish_detail_opened', 'sha_6', 'live', NOW(), NOW()),
    ('resto_11', 'evt_307', 'sess_x7', 'dish_detail_opened', 'sha_7', 'live', NOW(), NOW()),
    ('resto_11', 'evt_308', 'sess_x8', 'dish_detail_opened', 'sha_8', 'live', NOW(), NOW()),
    ('resto_11', 'evt_309', 'sess_x9', 'dish_detail_opened', 'sha_9', 'live', NOW(), NOW()),
    ('resto_11', 'evt_310', 'sess_x10', 'dish_detail_opened', 'sha_10', 'live', NOW(), NOW()),
    ('resto_11', 'evt_311', 'sess_x11', 'dish_detail_opened', 'sha_11', 'live', NOW(), NOW()),

    -- CASE EMPTY: Real Zero-Denominator (All events are excluded)
    ('resto_empty', 'evt_901', 'bad_sess_1', 'dish_detail_opened', 'sha_11', 'internal_test', NOW(), NOW()), 
    ('resto_empty', 'evt_902', 'bad_sess_2', 'dish_detail_opened', 'sha_11', 'live', NOW() - INTERVAL '25 hours', NOW()), 
    ('resto_empty', 'evt_903', 'bad_sess_3', 'dish_detail_opened', 'sha_11', 'live', NOW() + INTERVAL '6 minutes', NOW()), 
    ('resto_empty', 'evt_904', 'bad_sess_4', 'unknown_type', 'sha_11', 'live', NOW(), NOW()), 
    ('resto_empty', NULL, 'bad_sess_5', 'dish_detail_opened', 'sha_11', 'live', NOW(), NOW()), 
    ('resto_empty', 'evt_905', 'bad_sess_6', 'dish_detail_opened', 'sha_conf_A', 'live', NOW(), NOW()),
    ('resto_empty', 'evt_905', 'bad_sess_7', 'dish_detail_opened', 'sha_conf_B', 'live', NOW(), NOW());

-- 4. Analytical calculation view (Excluding venue/publication authorization logic per contract guidance)
CREATE TEMPORARY TABLE temp_report_results AS
SELECT 
    v.venue_id,
    CASE 
        WHEN COUNT(DISTINCT ce.session_id) = 0 THEN NULL
        WHEN COUNT(DISTINCT ce.session_id) < 10 THEN NULL 
        ELSE COUNT(ce.event_id) 
    END AS total_clicks,
    CASE 
        WHEN COUNT(DISTINCT ce.session_id) = 0 THEN NULL
        WHEN COUNT(DISTINCT ce.session_id) < 10 THEN NULL 
        ELSE COUNT(DISTINCT ce.session_id) 
    END AS raw_unique_sessions,
    -- Using canonical string tokens for insufficient data boundaries
    CASE 
        WHEN COUNT(DISTINCT ce.session_id) = 0 THEN 'not measurable'
        WHEN COUNT(DISTINCT ce.session_id) < 10 THEN 'insufficient_data' 
        ELSE CAST(COUNT(DISTINCT ce.session_id) AS TEXT) 
    END AS reconciled_sessions,
    CASE 
        WHEN COUNT(DISTINCT ce.session_id) = 0 THEN 'NOT MEASURABLE'
        WHEN COUNT(DISTINCT ce.session_id) < 10 THEN 'SUPPRESSED' 
        ELSE 'NORMAL' 
    END AS status
FROM (SELECT DISTINCT venue_id FROM temp_events) v
LEFT JOIN (
    SELECT MIN(id) as id, venue_id, event_id, session_id
    FROM temp_events
    WHERE 
        traffic_class = 'live'
        AND event_type = 'dish_detail_opened'
        AND event_id IS NOT NULL
        AND occurred_at >= received_at - INTERVAL '24 hours'
        AND occurred_at <= received_at + INTERVAL '5 minutes'
        AND (venue_id, event_id) NOT IN (
            SELECT venue_id, event_id FROM temp_events GROUP BY venue_id, event_id HAVING COUNT(DISTINCT payload_checksum) > 1
        )
    GROUP BY venue_id, event_id, session_id
) AS ce ON v.venue_id = ce.venue_id
GROUP BY v.venue_id;

-- =====================================================================
-- PGTAP ASSERTS
-- =====================================================================

-- RESTO_9 TESTS (Suppressed Frontier)
SELECT is(status, 'SUPPRESSED', 'Resto_9 status must be SUPPRESSED') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(total_clicks, NULL::bigint, 'Resto_9 total_clicks must be NULL::bigint') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(raw_unique_sessions, NULL::bigint, 'Resto_9 raw_unique_sessions must be NULL::bigint') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(reconciled_sessions, 'insufficient_data', 'Resto_9 display text must be canonical insufficient_data') FROM temp_report_results WHERE venue_id = 'resto_9';

-- RESTO_10 TESTS (Normal Frontier)
SELECT is(status, 'NORMAL', 'Resto_10 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(total_clicks, 10::bigint, 'Resto_10 total_clicks must be 10::bigint') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(raw_unique_sessions, 10::bigint, 'Resto_10 unique sessions must be 10::bigint') FROM temp_report_results WHERE venue_id = 'resto_10';

-- RESTO_11 TESTS (Linear Clearance Check)
SELECT is(status, 'NORMAL', 'Resto_11 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_11';
SELECT is(total_clicks, 11::bigint, 'Resto_11 total_clicks must match clean live events only') FROM temp_report_results WHERE venue_id = 'resto_11';
SELECT is(raw_unique_sessions, 11::bigint, 'Resto_11 unique sessions must match exactly 11') FROM temp_report_results WHERE venue_id = 'resto_11';

-- RESTO_EMPTY TESTS (Zero-denominator boundary returns 'not measurable')
SELECT is(reconciled_sessions, 'not measurable', 'Empty restaurant must return not measurable instead of being omitted') FROM temp_report_results WHERE venue_id = 'resto_empty';

SELECT * FROM finish();

ROLLBACK;
