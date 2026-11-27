# DATA-17 / DATA-18 — Gap Closure & Acceptance Readiness Report

- **Branch:** `feat/data-17-reconciliation` (branched from `origin/develop` `5b87c8a4`, PR #256)
- **Date:** 2026-11-24
- **Scope:** Code-owned gap closure, regression tests, fail-closed freshness evaluator, redacted production reconciliation SQL, DATA-18 manifest hardening, and operator runbook.

---

## 1. DATA-17 Metric Contract Audit — **PASS (Code-Verified)**

1. **Agreement across SQL, API, Contracts, and Docs:**
   - `total_sessions` (`COUNT(DISTINCT session_id) FILTER (WHERE is_exposed)`), `open_eligible_sessions` (`COUNT(DISTINCT session_id) FILTER (WHERE is_opened)`), `exposed_open_sessions` (`COUNT(DISTINCT session_id) FILTER (WHERE is_exposed AND is_opened)`), `open_rate` (`exposed_open_sessions / total_sessions`), and `measurable_dishes_count` (`total_sessions >= 10`) match across [owner-report.ts](../backend/src/owner-report.ts) and [owner-report.ts](../packages/contracts/src/owner-report.ts).
   - `production.batch.v1` enforces fixed 5-minute half-open `[start_time, end_time)` UTC windows with a 60-second settle delay (`OWNER_BATCH_MS = 300_000`, `OWNER_BATCH_SETTLE_MS = 60_000`) in [owner-report-batches.ts](../backend/src/owner-report-batches.ts).
   - Direct/comparison opens without `dish_viewed` increment `open_eligible_sessions` and venue-wide `summary.current.dish_opens`, never `exposed_open_sessions` or `open_rate`.
   - `VALID_ZERO`, `NOT_MEASURABLE`, and `SUPPRESSED` remain distinct; `serializeOwnerReportCsv` outputs empty cells for non-`NORMAL`/`VALID_ZERO` values (verified in [owner-report.data17.test.ts](../backend/src/owner-report.data17.test.ts)).

---

## 2. DATA-17 Redacted Canonical Aggregate Diagnostics

- **Script:** [data-17-production-reconciliation.sql](../scripts/sql/data-17-production-reconciliation.sql)
- **Operator use:** Run with `psql -v venue_slug=<approved-QA-diner-slug> -f scripts/sql/data-17-production-reconciliation.sql` on an authorized connection. It runs read-only with a five-second statement timeout and returns only aggregate counts for Batch A (Nov 23, 01:45–01:50 UTC) and Batch B (Nov 23, 17:45–17:50 UTC).
- **Interpretation:** The publication and production-provenance match columns describe the raw canonical cohort. The served production report additionally requires exact publication and dish revision eligibility and applicable PostHog event matches. The SQL cannot establish served counts or completeness.
- **Live Execution Status:** **NOT_VERIFIABLE** (no production database read access in this session; requires Sai).

---

## 3. DATA-17 Trusted Freshness Architecture & Proposal

### Implemented Fail-Closed Evaluator — **PASS (Code-Verified)**
- Implemented `evaluateBatchFreshness()` in [owner-report-freshness.ts](../backend/src/owner-report-freshness.ts) and wired into `measureReport()` in [owner-report.ts](../backend/src/owner-report.ts) with `watermark: null` for live production.
- **Behavior:** Fails closed (`is_stale: null`, `UNKNOWN`) when `watermark` is `null`, invalid, within settle delay, or reports `dlqDepth > 0` / `pendingQueueCount > 0` / `posthogComplete === false`. Returns `STALE` (`is_stale: true`) when `watermarkAt < batchWindowEnd + settleDelay` or `now - watermarkAt > maxStalenessMs`. Returns `FRESH` (`is_stale: false`) only when all server-side checkpoints prove completeness.
- Verified across all 8 required scenarios (fresh, stale, unknown, delayed, incomplete, invalid timestamps, settle/replay, AI-03 abstention) in [owner-report-freshness.test.ts](../backend/src/owner-report-freshness.test.ts).

### Missing Infrastructure for Production `is_stale: false` — **BLOCKED**
The current production architecture **cannot** establish `is_stale: false` because:
1. `POST /observations` enqueues to `OBSERVATION_QUEUE` without recording a pending-message ledger or watermark in PostgreSQL.
2. `queue-consumer.ts` has no `app_private.ingestion_watermark` table or periodic queue-drain checkpoint attesting that all messages with `first_received_at <= batchWindowEnd + settleDelay` have been persisted and `DLQ` depth is `0`.
3. `readLivePostHogOwnerEvents()` is a bounded (`LIMIT 5001`) HogQL query with no completeness watermark from PostHog's ingestion pipeline.

**Concrete Proposal:**
1. Add a forward migration creating `app_private.ingestion_watermark (queue_name text PRIMARY KEY, watermark_at timestamptz NOT NULL, pending_count integer NOT NULL, dlq_depth integer NOT NULL, updated_at timestamptz NOT NULL)`.
2. Record accepted `POST /observations` enqueues (or Cloudflare Queue metrics/consumer acks) and update `watermark_at` to `MIN(oldest_in_flight_first_received_at)` (or `now()` when queue depth is `0` and DLQ depth is `0`).
3. Pair with a PostHog project ingestion-lag check before passing a non-null `IngestionWatermark` into `evaluateBatchFreshness()`.

---

## 4. DATA-18 Hash Reconciliation & Manifest Readiness (Tracked in PR #264)

- **Generator & Manifest Hardening — PASS (Code-Verified):**
  - `test-data/owner-synthetic-p0-v2/generate_staging_activity.py` rejects `PLACEHOLDER_UUIDS` whenever `dry_run=False` (`--send` / `send_manifest_batches`), blocks `PRODUCTION_ORIGINS`, and emits `fixture_version`, `generator_version`, `input_sha256`, `output_sha256`, `provenance`, and `authorization_status`.
- **Dry-Run Acceptance Manifests (Placeholder IDs, `DRY_RUN_UNVERIFIED`):**
  - Scenario A (`test-data/owner-synthetic-p0-v2/manifests/scenario-a.dry-run.json`): `input_sha256 = 6c74f1e72181333ef8d7cd4ffffdb10ded3add793e6e430cc1694f06c5155e43`, `output_sha256 = a23698c44b330f084a612a622c949f9b960e4d8d4f7dd80708c139c977aef531`, `manifest_sha256 = ab5832c90797b78eb8cb41753e267de993499a1f500e55c56c246217b6e2c2d3`.
  - Scenario B (`test-data/owner-synthetic-p0-v2/manifests/scenario-b.dry-run.json`): `input_sha256 = 2be921e96a6662565b2427ece871e3938f441f134d7d465cd8f47bc84764dfcc`, `output_sha256 = 034cd873efba047108523a3b07756da72069d0fab5d30b16626c4dae7144ce26`, `manifest_sha256 = 6e7f344004e7f674c72d795e31166814ee9add470fec136bbe51e673a031357e`.
- **Reference Hash Reconciliation (`7d8d9534...` / `00b8683d...`) — NOT_VERIFIABLE:**
  - Neither hash exists in `git log --all` or the repository; `manifest_sha256` depends deterministically on `(scenario, venue_id, publication_id, dish_id, dish_revision_id, window_start, window_end, seed)` (and manifest schema fields). Reproducing those exact reference hashes requires the original input tuple and generator revision from the acceptance brief.
- **Staging Runbook:** `docs/s7-data-18-staging-runbook.md` (PR #264).

---

## 5. Final Ticket Readiness Verdicts

| Area | Verdict | Code-Verified vs Production-Verified |
|---|---|---|
| DATA-17 Metric Definitions & Nov 23 Consistency | **PASS** | Code-verified (`owner-report.data17.test.ts`, `owner-report.test.ts`). |
| DATA-17 Batch A/B & Avocado Toast Actual Counts | **NOT_VERIFIABLE** | Requires the approved venue's production report and matching canonical and PostHog event evidence. The diagnostic SQL supplies only raw canonical counts. |
| DATA-17 Freshness Evaluator & AI-03 Abstention | **PASS** | Code-verified (`owner-report-freshness.test.ts`); production stays `is_stale: null` until watermark infra is built (**BLOCKED**). |
| DATA-18 Fixture, Manifest Hardening & Runbook | **PASS** | Code-verified (`test_staging_activity.py`, `synthetic-staging-activity.test.ts`). |
| DATA-18 Reference Hashes (`7d8d9534...`, `00b8683d...`) | **NOT_VERIFIABLE** | Original input tuple not in repo. |
| DATA-18 Live Staging Execution | **BLOCKED** | Awaiting Sai's staging unfreeze, real venue/publication/dish IDs, menu token, and UTC window. |
