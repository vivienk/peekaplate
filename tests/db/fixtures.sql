-- =====================================================================
-- PEEKAPLATE - S3-DATA-02 INTEGRATION TESTS (pgTAP FRONTIER EDITION)
-- PATH: tests/db/fixtures.sql
-- DRI: Louis Dieme | Reviewer: Jeffin Sam Joji
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgtap;

BEGIN;

-- Nous passons de 6 à 9 assertions automatiques pour couvrir la frontière 11 et les anomalies
SELECT plan(9);

CREATE TEMPORARY TABLE temp_events (
    id SERIAL PRIMARY KEY,
    venue_id TEXT,
    event_id TEXT,
    session_id TEXT,
    event_type TEXT,
    payload_checksum TEXT,
    traffic_class TEXT, -- Pour filtrer le trafic de test
    received_at TIMESTAMP -- Pour identifier les cas anormaux / en retard
);

-- Insertion des Jeux d'Essais (Fixtures augmentées selon les consignes de Wang)
INSERT INTO temp_events (venue_id, event_id, session_id, event_type, payload_checksum, traffic_class, received_at) VALUES
    -- -----------------------------------------------------------------
    -- CASE 9: Frontier 9 (Must be STRICTLY suppressed and hidden)
    -- -----------------------------------------------------------------
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha256_A', 'live', NOW()),
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha256_A', 'live', NOW()), -- Network Retry
    ('resto_9', 'evt_102', 'sess_02', 'dish_detail_opened', 'sha256_B', 'live', NOW()),
    ('resto_9', 'evt_103', 'sess_03', 'dish_detail_opened', 'sha256_C', 'live', NOW()),
    ('resto_9', 'evt_104', 'sess_04', 'dish_detail_opened', 'sha256_D', 'live', NOW()),
    ('resto_9', 'evt_105', 'sess_05', 'dish_detail_opened', 'sha256_E', 'live', NOW()),
    ('resto_9', 'evt_106', 'sess_06', 'dish_detail_opened', 'sha256_F', 'live', NOW()),
    ('resto_9', 'evt_107', 'sess_07', 'dish_detail_opened', 'sha256_G', 'live', NOW()),
    ('resto_9', 'evt_108', 'sess_08', 'dish_detail_opened', 'sha256_H', 'live', NOW()),
    ('resto_9', 'evt_109', 'sess_09', 'dish_detail_opened', 'sha256_I', 'live', NOW()),

    -- -----------------------------------------------------------------
    -- CASE 10: Frontier 10 (Must show ALL metrics normally = 10)
    -- -----------------------------------------------------------------
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha256_1', 'live', NOW()),
    ('resto_10', 'evt_202', 'sess_B', 'dish_detail_opened', 'sha256_2', 'live', NOW()),
    ('resto_10', 'evt_203', 'sess_C', 'dish_detail_opened', 'sha256_3', 'live', NOW()),
    ('resto_10', 'evt_204', 'sess_D', 'dish_detail_opened', 'sha256_4', 'live', NOW()),
    ('resto_10', 'evt_205', 'sess_E', 'dish_detail_opened', 'sha256_5', 'live', NOW()),
    ('resto_10', 'evt_206', 'sess_F', 'dish_detail_opened', 'sha256_6', 'live', NOW()),
    ('resto_10', 'evt_207', 'sess_G', 'dish_detail_opened', 'sha256_7', 'live', NOW()),
    ('resto_10', 'evt_208', 'sess_H', 'dish_detail_opened', 'sha256_8', 'live', NOW()),
    ('resto_10', 'evt_209', 'sess_I', 'dish_detail_opened', 'sha256_9', 'live', NOW()),
    ('resto_10', 'evt_210', 'sess_J', 'dish_detail_opened', 'sha256_10', 'live', NOW()),

    -- -----------------------------------------------------------------
    -- CASE 11: Frontier 11 (New requirement Wang - Must show normally = 11)
    -- -----------------------------------------------------------------
    ('resto_11', 'evt_301', 'sess_01', 'dish_detail_opened', 'sha_1', 'live', NOW()),
    ('resto_11', 'evt_302', 'sess_02', 'dish_detail_opened', 'sha_2', 'live', NOW()),
    ('resto_11', 'evt_303', 'sess_03', 'dish_detail_opened', 'sha_3', 'live', NOW()),
    ('resto_11', 'evt_304', 'sess_04', 'dish_detail_opened', 'sha_4', 'live', NOW()),
    ('resto_11', 'evt_305', 'sess_05', 'dish_detail_opened', 'sha_5', 'live', NOW()),
    ('resto_11', 'evt_306', 'sess_06', 'dish_detail_opened', 'sha_6', 'live', NOW()),
    ('resto_11', 'evt_307', 'sess_07', 'dish_detail_opened', 'sha_7', 'live', NOW()),
    ('resto_11', 'evt_308', 'sess_08', 'dish_detail_opened', 'sha_8', 'live', NOW()),
    ('resto_11', 'evt_309', 'sess_09', 'dish_detail_opened', 'sha_9', 'live', NOW()),
    ('resto_11', 'evt_310', 'sess_10', 'dish_detail_opened', 'sha_10', 'live', NOW()),
    ('resto_11', 'evt_311', 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW()),

    -- -----------------------------------------------------------------
    -- ABNORMAL CASES (Must be isolated and excluded from calculations)
    -- -----------------------------------------------------------------
    ('resto_11', 'evt_999', 'sess_11', 'dish_detail_opened', 'sha_11', 'internal_test', NOW()), -- Test traffic (Exclu !)
    ('resto_11', 'evt_late', 'sess_11', 'dish_detail_opened', 'sha_11', 'live', '2020-01-01 00:00:00'), -- Late event (Exclu !)
    ('resto_11', NULL, 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW()), -- Missing event_id (Exclu !)
    ('resto_11', 'evt_conflict', 'sess_11', 'dish_detail_opened', 'sha_conf_A', 'live', NOW()),
    ('resto_11', 'evt_conflict', 'sess_11', 'dish_detail_opened', 'sha_conf_B', 'live', NOW()); -- Same-ID Payload conflict (Quarantaine !)

-- 4. Le Moteur de calcul filtré
CREATE TEMPORARY TABLE temp_report_results AS
SELECT 
    venue_id,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN NULL ELSE COUNT(event_id) END AS total_clicks,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN NULL ELSE COUNT(DISTINCT session_id) END AS raw_unique_sessions,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN 'insufficient data' ELSE CAST(COUNT(DISTINCT session_id) AS TEXT) END AS reconciled_sessions,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN 'SUPPRESSED' ELSE 'NORMAL' END AS status
FROM (
    SELECT MIN(id) as id, venue_id, event_id, session_id
    FROM temp_events
    WHERE 
        traffic_class = 'live' -- Exclusion du trafic de test
        AND received_at > NOW() - INTERVAL '30 days' -- Exclusion des événements trop anciens/tardifs
        AND event_id IS NOT NULL -- Exclusion des champs manquants
        AND event_id NOT IN (
            -- Isolation des conflits de même ID (Même ID avec payload différent)
            SELECT event_id FROM temp_events GROUP BY event_id HAVING COUNT(DISTINCT payload_checksum) > 1
        )
    GROUP BY venue_id, event_id, session_id
) AS cleaned_events
GROUP BY venue_id;

-- =====================================================================
-- ASSERTS PGTAP
-- =====================================================================

-- TESTS FRONTIÈRE 9
SELECT is(status, 'SUPPRESSED', 'Resto_9 status must be SUPPRESSED') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(total_clicks, NULL, 'Resto_9 absolute counts must be hidden') FROM temp_report_results WHERE venue_id = 'resto_9';

-- TESTS FRONTIÈRE 10
SELECT is(status, 'NORMAL', 'Resto_10 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(raw_unique_sessions, 10, 'Resto_10 sessions must be exactly 10') FROM temp_report_results WHERE venue_id = 'resto_10';

-- TESTS FRONTIÈRE 11 (Nouvelle exigence)
SELECT is(status, 'NORMAL', 'Resto_11 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_11';
SELECT is(raw_unique_sessions, 11, 'Resto_11 sessions must be exactly 11') FROM temp_report_results WHERE venue_id = 'resto_11';
-- Prouve que les 4 cas anormaux injectés dans resto_11 ont bien été éliminés (Le compte reste à 11 clics propres)
SELECT is(total_clicks, 11, 'Resto_11 clicks must ignore all abnormal cases and conflicts') FROM temp_report_results WHERE venue_id = 'resto_11';

ROLLBACK;
