# S7-DATA-17 — Owner Metrics Reconciliation Report

- **Date:** November 25, 2026
- **Ticket:** S7-DATA-17
- **PRs:** [#261](https://github.com/vivienk/peekaplate/pull/261) (`d7a3bc6d`), [#263](https://github.com/vivienk/peekaplate/pull/263) (`20ae4cdb`, rebased onto `origin/develop` `c66b328f`)
- **Existing Artifacts Reused:** `docs/s7-data-17-metric-acceptance.md` (PR #261), `docs/data-17-18-acceptance-readiness.md` (PR #263), `scripts/sql/data-17-production-reconciliation.sql` (PR #263)
- **Status on November 25:** **PARTIAL / PENDING EXTERNAL SIGNOFF**. The author recorded local checks and Batch B aggregate agreement for one queried QA venue. Production bindings, event-level agreement, arithmetic sign-off, and the decision to defer the watermark remain open.

---

## 1. Test Commands & Local Verification

Author's check record for `feat/data-17-reconciliation` (`20ae4cdb`):
- `vitest run backend/src/owner-report.test.ts backend/src/owner-report-freshness.test.ts backend/src/owner-report.data17.test.ts backend/src/owner-report-export.test.ts backend/src/owner-ai/responses.test.ts packages/contracts/src/owner-report.test.ts`: **PASS** (`6` files, `106/106` tests).
- `tsc -p backend/tsconfig.json --noEmit && tsc -p packages/contracts/tsconfig.json --noEmit`: **PASS**.
- `node scripts/test-db.mjs` (Docker `28.3.3`): **PASS** (`18` pgTAP suites, `21` integration files / `202/202` tests).
- `node scripts/context.mjs check && node scripts/check-docs.mjs`: **PASS**.
- `gh pr checks 263`: **PASS** (`9/9` successful, `1` skipped, `MERGEABLE` / `CLEAN` on `20ae4cdb`).

---

## 2. Recorded hosted observations

The queries used Supabase `icwhkrlsecpzcomfjsso` and PostHog `675372`. Repository operations identify both as staging resources. The PostHog query selected rows tagged `production`. These observations describe the queried projects and venues. Confirmation of the production Worker's database and PostHog bindings is pending. [Supabase operations](operations.md) · [PostHog setup](posthog.md)

### 2.1 Schema & Watermark Check (`icwhkrlsecpzcomfjsso`, `2026-11-25T11:01Z`)
- `information_schema.tables` for `app_private`: **35 base tables, 4 views** (`owner_observation_v1`, `owner_opening_activity_v1`, `owner_portion_opening_v1`, `owner_test_observation_v1`).
- The inspected schema had no `app_private.ingestion_watermark`. The code at `20ae4cdb` supplied no trusted production queue-drain watermark.
- `evaluateBatchFreshness()` in `backend/src/owner-report-freshness.ts` receives `watermark: null` in `measureReport()`, keeping `is_stale: null` (`UNKNOWN`) and AI-03 abstention intact.

### 2.2 Batch A / Batch B Reconciliation (`2026-11-23`)
- **`peekaplate_production_qa_b_nov_21` (`f3f84a41-b000-4f5f-9245-d401c7da6026`):** `0` rows in Batch A (`01:45–01:50Z`) and Batch B (`17:45–17:50Z`), though `490` total rows (`44` sessions) exist across `2026-11-22T02:39:47Z`–`2026-11-25T04:56:38Z`.
- **`PeekaPlate Production AI QA` (`29363367-eb65-48bb-81bd-fb25e6407f43`):**
  - **Batch A:** `0` rows in Supabase and PostHog.
  - **Batch B (`2026-11-23T17:45:00Z`–`17:50:00Z`):** Both queries returned `56` events with the same counts by event type. Supabase used `app_private.owner_observation_v1` and PostHog used `properties.environment = 'production'`. Event identity, publication and production provenance still need reconciliation.
    - `dish_activity_checkpoint`: `13` (`10` `session_id` / `10` `distinct_id`)
    - `dish_compared`: `10` (`10` / `10`)
    - `dish_detail_opened`: `10` (`10` / `10`)
    - `dish_portion_opened`: `10` (`10` / `10`)
    - `menu_viewed`: `10` (`10` / `10`)
    - `dish_viewed`: `2` (`1` / `1`)
    - `dish_saved`: `1` (`1` / `1`)
  - **Five-minute metric interpretation:** The raw Supabase results had `10` opening events and `1` distinct exposed session. That can yield `10` venue-wide `dish_opens` with `0` measurable dishes under the `production.batch.v1` floor of `10` exposed sessions per dish. The counts do not establish the production API result.

### 2.3 Avocado Toast & Per-Dish Aggregates (All Timestamps `Nov 22–25`)
- **`f3f84a41-...` (`Avocado Toast`, `c438d671-6ac2-8f39-ba67-d108eab2c64a`):** `total_sessions = 27`, `open_eligible_sessions = 28`, `exposed_open_sessions = 24`. The totals allow opened sessions without an exposure. Opening-source attribution requires a separate check.
- **`29363367-...` (`Avocado Toast`, `610ebc45-b61d-82fa-8140-b3b2a31d18b5`):** `total_sessions = 72`, `open_eligible_sessions = 54`, `exposed_open_sessions = 43`.

### 2.4 PostHog `distinct_id` Instrumentation Check
- `packages/analytics/src/posthog.ts` uses an in-memory random `visitId` as `distinct_id`. Canonical session counts come from `app_private.owner_observation_v1`. The PostHog event UUID is the shared event identity for checking the venue, publication and event type.

---

## 3. Remaining External Dependencies

1. **PR #261 & #263** review approval and merge to `develop`.
2. **Harshita:** Independent sign-off on the 14-visit arithmetic in `docs/s7-data-17-metric-acceptance.md` (PR #261).
3. **Sai:** Confirm the Worker's authorized production Supabase and PostHog bindings and the intended Batch A/B venue. Reconcile event identity, publication and production provenance on that scope. Confirm whether to defer `app_private.ingestion_watermark` while production freshness remains `is_stale: null`.
