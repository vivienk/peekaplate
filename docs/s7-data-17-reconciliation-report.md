# S7-DATA-17 — Owner Metrics Reconciliation Report

- **Date:** November 25, 2026
- **Ticket:** S7-DATA-17
- **PRs:** [#261](https://github.com/vivienk/peekaplate/pull/261) (`d7a3bc6d`), [#263](https://github.com/vivienk/peekaplate/pull/263) (`20ae4cdb`, rebased onto `origin/develop` `c66b328f`)
- **Existing Artifacts Reused:** `docs/s7-data-17-metric-acceptance.md` (PR #261), `docs/data-17-18-acceptance-readiness.md` (PR #263), `scripts/sql/data-17-production-reconciliation.sql` (PR #263)
- **Final Status:** **PARTIAL / PENDING EXTERNAL SIGNOFF** (Technical implementation and local tests **PASS**; aggregate Batch B reconciliation completed with event-level differences and session-identity limitations documented; PR review/merge, Harshita arithmetic sign-off, and Sai's production-project/watermark-deferral confirmation **PENDING**)

---

## 1. Test Commands & Local Verification

Executed on `feat/data-17-reconciliation` (`20ae4cdb`):
- `vitest run backend/src/owner-report.test.ts backend/src/owner-report-freshness.test.ts backend/src/owner-report.data17.test.ts backend/src/owner-report-export.test.ts backend/src/owner-ai/responses.test.ts packages/contracts/src/owner-report.test.ts`: **PASS** (`6` files, `106/106` tests).
- `tsc -p backend/tsconfig.json --noEmit && tsc -p packages/contracts/tsconfig.json --noEmit`: **PASS**.
- `node scripts/test-db.mjs` (Docker `28.3.3`): **PASS** (`18` pgTAP suites, `21` integration files / `202/202` tests).
- `node scripts/context.mjs check && node scripts/check-docs.mjs`: **PASS**.
- `gh pr checks 263`: **PASS** (`9/9` successful, `1` skipped, `MERGEABLE` / `CLEAN` on `20ae4cdb`).

---

## 2. Live Supabase (`icwhkrlsecpzcomfjsso`) & PostHog (`675372`) Evidence

### 2.1 Schema & Watermark Check (`icwhkrlsecpzcomfjsso`, `2026-11-25T11:01Z`)
- `information_schema.tables` for `app_private`: **35 base tables, 4 views** (`owner_observation_v1`, `owner_opening_activity_v1`, `owner_portion_opening_v1`, `owner_test_observation_v1`).
- `app_private.ingestion_watermark`: **Does not exist**. No other DB-backed queue-drain watermark exists.
- `evaluateBatchFreshness()` in `backend/src/owner-report-freshness.ts` receives `watermark: null` in `measureReport()`, keeping `is_stale: null` (`UNKNOWN`) and AI-03 abstention intact.

### 2.2 Batch A / Batch B Reconciliation (`2026-11-23`)
- **`peekaplate_production_qa_b_nov_21` (`f3f84a41-b000-4f5f-9245-d401c7da6026`):** `0` rows in Batch A (`01:45–01:50Z`) and Batch B (`17:45–17:50Z`), though `490` total rows (`44` sessions) exist across `2026-11-22T02:39:47Z`–`2026-11-25T04:56:38Z`.
- **`PeekaPlate Production AI QA` (`29363367-eb65-48bb-81bd-fb25e6407f43`):**
  - **Batch A:** `0` rows in Supabase and PostHog.
  - **Batch B (`2026-11-23T17:45:00Z`–`17:50:00Z`):** Aggregate event-count agreement (`56` total events) between `app_private.owner_observation_v1` and PostHog (`properties.environment = 'production'`), not event-level equivalence (`distinct_id` is an in-memory `visitId`, not canonical `session_id`):
    - `dish_activity_checkpoint`: `13` (`10` `session_id` / `10` `distinct_id`)
    - `dish_compared`: `10` (`10` / `10`)
    - `dish_detail_opened`: `10` (`10` / `10`)
    - `dish_portion_opened`: `10` (`10` / `10`)
    - `menu_viewed`: `10` (`10` / `10`)
    - `dish_viewed`: `2` (`1` / `1`)
    - `dish_saved`: `1` (`1` / `1`)
  - **Metric Explanation:** `10` sessions opened a dish (`dish_detail_opened`) while only `1` session had `dish_viewed` (`total_sessions = 1 < 10`), explaining `10` venue-wide `dish_opens` vs `0` measurable dishes.

### 2.3 Avocado Toast & Per-Dish Aggregates (All Timestamps `Nov 22–25`)
- **`f3f84a41-...` (`Avocado Toast`, `c438d671-6ac2-8f39-ba67-d108eab2c64a`):** `total_sessions = 27`, `open_eligible_sessions = 28`, `exposed_open_sessions = 24` (confirms direct/comparison opens increment `open_eligible_sessions` without inflating `exposed_open_sessions`).
- **`29363367-...` (`Avocado Toast`, `610ebc45-b61d-82fa-8140-b3b2a31d18b5`):** `total_sessions = 72`, `open_eligible_sessions = 54`, `exposed_open_sessions = 43`.

### 2.4 PostHog `distinct_id` Instrumentation Check
- In `packages/analytics/src/posthog.ts` (lines 9, 189), `distinct_id` is an **in-memory random `visitId`**, **not** the canonical `session_id` (which is intentionally stripped). PostHog is a secondary cross-check only; canonical session counts come exclusively from `app_private.owner_observation_v1`.

---

## 3. Remaining External Dependencies

1. **PR #261 & #263** review approval and merge to `develop`.
2. **Harshita:** Independent sign-off on the 14-visit arithmetic in `docs/s7-data-17-metric-acceptance.md` (PR #261).
3. **Sai:** Confirm whether `icwhkrlsecpzcomfjsso` is the sole authoritative Supabase project (and confirm Batch A/B target venue), and confirm deferring `app_private.ingestion_watermark` out of S7-DATA-17 while fail-closed `is_stale: null` remains active.
