-- =====================================================================
-- PEEKAPLATE - S3-DATA-02 INTEGRATION TESTS (pgTAP EDITION)
-- PATH: tests/db/fixtures.sql
-- DRI: Louis Dieme | Reviewer: Jeffin Sam Joji
-- =====================================================================

BEGIN; -- 1. Début de la transaction pour isoler les tests (Rollback à la fin)

-- Déclaration du nombre de tests prévus par pgTAP
SELECT plan(6);

-- 2. Création d'une table temporaire simulant la future table ARC-01
CREATE TEMPORARY TABLE temp_events (
    id SERIAL PRIMARY KEY,
    venue_id TEXT,
    event_id TEXT,
    session_id TEXT,
    event_type TEXT,
    payload_checksum TEXT
);

-- 3. Insertion des Jeux d'Essais (Fixtures) avec les cas aux frontières (9 vs 10)
INSERT INTO temp_events (venue_id, event_id, session_id, event_type, payload_checksum) VALUES
    -- FRONTIÈRE A : RESTO_9 (9 sessions uniques -> Doit être masqué anonyme)
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha256_A'),
    ('resto_9', 'evt_101', 'sess_01', 'dish_detail_opened', 'sha256_A'), -- Retry réseau légitime (Même id, même contenu)
    ('resto_9', 'evt_102', 'sess_02', 'dish_detail_opened', 'sha256_B'),
    ('resto_9', 'evt_103', 'sess_03', 'dish_detail_opened', 'sha256_C'),
    ('resto_9', 'evt_104', 'sess_04', 'dish_detail_opened', 'sha256_D'),
    ('resto_9', 'evt_105', 'sess_05', 'dish_detail_opened', 'sha256_E'),
    ('resto_9', 'evt_106', 'sess_06', 'dish_detail_opened', 'sha256_F'),
    ('resto_9', 'evt_107', 'sess_07', 'dish_detail_opened', 'sha256_G'),
    ('resto_9', 'evt_108', 'sess_08', 'dish_detail_opened', 'sha256_H'),
    ('resto_9', 'evt_109', 'sess_09', 'dish_detail_opened', 'sha256_I'),

    -- FRONTIÈRE B : RESTO_10 (10 sessions uniques -> Doit s'afficher normalement)
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha256_1'),
    ('resto_10', 'evt_201', 'sess_A', 'dish_detail_opened', 'sha256_1'), -- Retry réseau dans le cas 10 aussi !
    ('resto_10', 'evt_202', 'sess_B', 'dish_detail_opened', 'sha256_2'),
    ('resto_10', 'evt_203', 'sess_C', 'dish_detail_opened', 'sha256_3'),
    ('resto_10', 'evt_204', 'sess_D', 'dish_detail_opened', 'sha256_4'),
    ('resto_10', 'evt_205', 'sess_E', 'dish_detail_opened', 'sha256_5'),
    ('resto_10', 'evt_206', 'sess_F', 'dish_detail_opened', 'sha256_6'),
    ('resto_10', 'evt_207', 'sess_G', 'dish_detail_opened', 'sha256_7'),
    ('resto_10', 'evt_208', 'sess_H', 'dish_detail_opened', 'sha256_8'),
    ('resto_10', 'evt_209', 'sess_I', 'dish_detail_opened', 'sha256_9'),
    ('resto_10', 'evt_210', 'sess_J', 'dish_detail_opened', 'sha256_10'),

    -- CAS DE TEST CRITIQUE : Conflit de payload (Même event_id mais contenu différent -> Quarantaine)
    ('resto_10', 'evt_conflict_999', 'sess_J', 'dish_detail_opened', 'sha256_VALID'),
    ('resto_10', 'evt_conflict_999', 'sess_J', 'dish_detail_opened', 'sha256_FRAUDULENT');

-- 4. Création de la vue ou table de calcul (Moteur SQL réconcilié)
CREATE TEMPORARY TABLE temp_report_results AS
SELECT 
    venue_id,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN NULL ELSE COUNT(event_id) END AS total_clicks,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN NULL ELSE COUNT(DISTINCT session_id) END AS raw_unique_sessions,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN 'insufficient data' ELSE CAST(COUNT(DISTINCT session_id) AS TEXT) END AS reconciled_sessions,
    CASE WHEN COUNT(DISTINCT session_id) < 10 THEN 'SUPPRESSED' ELSE 'NORMAL' END AS status
FROM (
    -- Filtrage des retries légitimes ET mise en quarantaine des conflits d'ID
    SELECT MIN(id) as id, venue_id, event_id, session_id
    FROM temp_events
    WHERE event_id NOT IN (
        -- Sous-requête détectant les event_id corrompus (payloads différents pour un même ID)
        SELECT event_id FROM temp_events GROUP BY event_id HAVING COUNT(DISTINCT payload_checksum) > 1
    )
    GROUP BY venue_id, event_id, session_id
) AS cleaned_events
GROUP BY venue_id;

-- =====================================================================
-- ASSERTS PGTAP (Vérifications automatiques pour la CI)
-- =====================================================================

-- TESTS RESTO_9 (Frontière Masquée)
SELECT is(status, 'SUPPRESSED', 'Resto_9 status must be SUPPRESSED') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(total_clicks, NULL, 'Resto_9 absolute clicks must be hidden (NULL)') FROM temp_report_results WHERE venue_id = 'resto_9';
SELECT is(reconciled_sessions, 'insufficient data', 'Resto_9 display text must be insufficient data') FROM temp_report_results WHERE venue_id = 'resto_9';

-- TESTS RESTO_10 (Frontière Validée)
SELECT is(status, 'NORMAL', 'Resto_10 status must clear as NORMAL') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(total_clicks, 10, 'Resto_10 clicks must be exactly 10 (Retries filtered, conflict quarantined)') FROM temp_report_results WHERE venue_id = 'resto_10';
SELECT is(raw_unique_sessions, 10, 'Resto_10 unique sessions must match 10') FROM temp_report_results WHERE venue_id = 'resto_10';

-- 5. Annulation de la transaction pour laisser la base de données de staging intacte
ROLLBACK;
