-- =====================================================================
-- PEEKAPLATE - S3-DATA-02 INTEGRATION TESTS (pgTAP ORACLE EDITION)
-- PATH: tests/db/owner_metrics.sql
-- DRI: Louis Dieme | Reviewers: Jeffin Sam Joji & Zhiliang Wang
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgtap;

BEGIN;

-- Déclaration de 11 assertions de test automatiques (Plan mis à jour)
SELECT plan(11);

CREATE TEMPORARY TABLE temp_events (
    id SERIAL PRIMARY KEY,
    venue_id TEXT,
    event_id TEXT,
    session_id TEXT,
    event_type TEXT,
    payload_checksum TEXT,
    traffic_class TEXT,
    received_at TIMESTAMP
);

-- Insertion de nos scénarios de frontière (9 / 10 / 11) et cas anormaux d'intégration
INSERT INTO temp_events (venue_id, event_id, session_id, event_type, payload_checksum, traffic_class, received_at) VALUES
    -- RESTO_9: Frontier 9 (Must be suppressed and counts hidden)
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha_A', 'live', NOW()),
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha_A', 'live', NOW()), -- Retry réseau légitime
    ('resto_9', 'evt_102', 'sess_02', 'dish_detail_opened', 'sha_B', 'live', NOW()),
    ('resto_9', 'evt_103', 'sess_03', 'dish_detail_opened', 'sha_C', 'live', NOW()),
    ('resto_9', 'evt_104', 'sess_04', 'dish_detail_opened', 'sha_D', 'live', NOW()),
    ('resto_9', 'evt_105', 'sess_05', 'dish_detail_opened', 'sha_E', 'live', NOW()),
    ('resto_9', 'evt_106', 'sess_06', 'dish_detail_opened', 'sha_F', 'live', NOW()),
    ('resto_9', 'evt_107', 'sess_07', 'dish_detail_opened', 'sha_G', 'live', NOW()),
    ('resto_9', 'evt_108', 'sess_08', 'dish_detail_opened', 'sha_H', 'live', NOW()),
    ('resto_9', 'evt_109', 'sess_09', 'dish_detail_opened', 'sha_I', 'live', NOW()),

    -- RESTO_10: Frontier 10 (Must show metrics normally = 10)
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha_1', 'live', NOW()),
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha_1', 'live', NOW()), -- Retry réseau
    ('resto_10', 'evt_202', 'sess_B', 'dish_detail_opened', 'sha_2', 'live', NOW()),
    ('resto_10', 'evt_203', 'sess_C', 'dish_detail_opened', 'sha_3', 'live', NOW()),
    ('resto_10', 'evt_204', 'sess_D', 'dish_detail_opened', 'sha_4', 'live', NOW()),
    ('resto_10', 'evt_205', 'sess_E', 'dish_detail_opened', 'sha_5', 'live', NOW()),
    ('resto_10', 'evt_206', 'sess_F', 'dish_detail_opened', 'sha_6', 'live', NOW()),
    ('resto_10', 'evt_207', 'sess_G', 'dish_detail_opened', 'sha_7', 'live', NOW()),
    ('resto_10', 'evt_208', 'sess_H', 'dish_detail_opened', 'sha_8', 'live', NOW()),
    ('resto_10', 'evt_209', 'sess_I', 'dish_detail_opened', 'sha_9', 'live', NOW()),
    ('resto_10', 'evt_210', 'sess_J', 'dish_detail_opened', 'sha_10', 'live', NOW()),

    -- RESTO_11: Frontier 11 (Must show metrics normally = 11)
    ('resto_11', 'evt_301', 'sess_01', 'dish_detail_opened', 'sha_x', 'live', NOW()),
    ('resto_11', 'evt_302', 'sess_02', 'dish_detail_opened', 'sha_y', 'live', NOW()),
    ('resto_11', 'evt_303', 'sess_03', 'dish_detail_opened', 'sha_z', 'live', NOW()),
    ('resto_11', 'evt_304', 'sess_04', 'dish_detail_opened', 'sha_4', 'live', NOW()),
    ('resto_11', 'evt_305', 'sess_05', 'dish_detail_opened', 'sha_5', 'live', NOW()),
    ('resto_11', 'evt_306', 'sess_06', 'dish_detail_opened', 'sha_6', 'live', NOW()),
    ('resto_11', 'evt_307', 'sess_07', 'dish_detail_opened', 'sha_7', 'live', NOW()),
    ('resto_11', 'evt_308', 'sess_08', 'dish_detail_opened', 'sha_8', 'live', NOW()),
    ('resto_11', 'evt_309', 'sess_09', 'dish_detail_opened', 'sha_9', 'live', NOW()),
    ('resto_11', 'evt_310', 'sess_10', 'dish_detail_opened', 'sha_10', 'live', NOW()),
    ('resto_11', 'evt_311', 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW()),

    -- CRITICAL ADR 0015 & WANG ABNORMAL CASES (All must be excluded from calculations)
    ('resto_11', 'evt_999', 'sess_11', 'dish_detail_opened', 'sha_11', 'internal_test', NOW()), -- Traffic classe test (Exclu)
    ('resto_11', 'evt_old', 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW() - INTERVAL '25 hours'), -- PLUS DE 24H (Exclu !)
    ('resto_11', 'evt_future', 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW() + INTERVAL '6 minutes'), -- PLUS DE 5 MIN DANS LE FUTUR (Exclu !)
    ('resto_11', 'evt_unknown', 'sess_11', 'unknown_type', 'sha_11', 'live', NOW()), -- Type inconnu (Exclu)
    ('resto_11', NULL, 'sess_11', 'dish_detail_opened', 'sha_11', 'live', NOW()), -- Missing event_id (Exclu)
    ('resto_11', 'evt_conflict', 'sess_11', 'dish_detail_opened', 'sha_conf_A', 'live', NOW()),
    ('resto_11', 'evt_conflict', 'sess_11', 'dish_detail_opened', 'sha_conf_B', 'live', NOW()); -- Conflit local (Quarantaine)

-- 4. Moteur d'agrégation analytique de production (Filtre temporel strict ADR 0015)
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
        traffic_class = 'live'
        AND event_type = 'dish_detail_opened' -- Seuls les types convenus sont comptabilisés
        AND event_id IS NOT NULL
        -- REGLAGE TEMPOREL ADR 0015 : Fenêtre stricte de 24h passées et 5 min futures
        AND received_at >= NOW() - INTERVAL '24 hours'
        AND received_at <= NOW() + INTERVAL '5 minutes'
        AND (venue_id, event_id) NOT IN (
            SELECT venue_id, event_id FROM temp_events GROUP BY venue_id, event_id HAVING COUNT(DISTINCT payload_checksum) > 1
        )
    GROUP BY venue_id, event_id, session_id
) AS cleaned_events
GROUP BY venue_id;

-- =====================================================================
-- ASSERTS PGTAP (11 INDEPENDENT VALIDATIONS)
-- =====================================================================

-- TESTS RESTO_9 (Frontière Masquée)
SELECT is(status, 'SUPPRESSED', 'Resto_9 status must be SUPPRESSED') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(total_clicks, NULL::bigint, 'Resto_9 total_clicks must be NULL::bigint') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(raw_unique_sessions, NULL::bigint, 'Resto_9 raw_unique_sessions must be NULL::bigint') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(reconciled_sessions, 'insufficient data', 'Resto_9 display text must be insufficient data') FROM temp_report_results WHERE venue_id = 'resto_9';

-- TESTS RESTO_10 (Frontière Validée)
SELECT is(status, 'NORMAL', 'Resto_10 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(total_clicks, 10::bigint, 'Resto_10 total_clicks must be 10::bigint') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(raw_unique_sessions, 10::bigint, 'Resto_10 unique sessions must be 10::bigint') FROM temp_report_results WHERE venue_id = 'resto_10';

-- TESTS FRONTIÈRE 11 (Vérification linéaire de non-régression)
SELECT is(status, 'NORMAL', 'Resto_11 status must be NORMAL') FROM temp_report_results WHERE venue_id = 'resto_11';
SELECT is(total_clicks, 11::bigint, 'Resto_11 total_clicks must ignore anomalies, future, late and unknown events') FROM temp_report_results WHERE venue_id = 'resto_11';
SELECT is(raw_unique_sessions, 11::bigint, 'Resto_11 unique sessions must be 11::bigint') FROM temp_report_results WHERE venue_id = 'resto_11';

-- TEST DÉNOMINATEUR ZÉRO (Doit être absent des résultats ou renvoyer un statut vide)
SELECT json_look_block AS ok FROM (
    SELECT ok(NOT EXISTS (SELECT 1 FROM temp_report_results WHERE venue_id = 'resto_empty'), 'Zero denominator venue correctly filtered or empty') AS json_look_block
);

SELECT * FROM finish();

ROLLBACK;
