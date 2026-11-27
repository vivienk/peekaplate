# S7-DATA-17 — Owner Metric Definitions & Independent Acceptance

- **Date:** November 24, 2026
- **Scope:** Owner dish-report metrics (`owner_report.v1`), canonical acceptance verification, required edge-case coverage, cross-layer consistency (contracts, SQL, API, CSV export, console dashboard, owner AI, synthetic generator), and Harshita's independent calculation handoff.
- **Out of scope:** Freshness infrastructure architecture (`DATA-17` pipeline freshness) and new analytics features.
- **Reference PRs audited:**
  - PR #107 (`9fdc7306`): `owner_report.v1` contract, `OWNER_REPORT_QUERY` SQL, `readOwnerReport()`, and privacy floor integration tests.
  - PR #116 (`5bfaa94f`): Comparison attribution alignment (`dish_compared` ordering and late openings).
  - PR #134 (`d73ba4a5`): `comparison_report.v1`, deterministic tie-breaking (`producer_id`, `local_sequence`), and complementary suppression.
  - PR #152 (`cecdf7a2`): S6-DATA-13 release hardening (`owner-report.s6-hardening.test.ts` and `tests/s6-data-13/evidence/validation_findings.md`).

---

## 1. Final Metric-Definition Table

### 1.1 Canonical Owner Metrics (`owner_report.v1`)

This table and the arithmetic below cover the legacy 24-hour dish report and its synthetic acceptance case. The legacy live report reads canonical live facts in `app_private.owner_observation_v1` by `(tenant_id, dish_id)` over the half-open UTC window `[now - 24h, now)`. The production report can use a settled batch or the configured San Francisco day policy, with separate publication, provenance and PostHog eligibility checks. The fixture results do not prove production eligibility or match production totals.

Internal `eligible_sessions` counts are carried in `InternalOwnerDishReportSchema` only to enforce privacy rules and are stripped by `toOwnerReport()` before any response leaves the backend (`OwnerDishReportSchema` rejects `eligible_sessions` as an unknown field).

> **Opening events vs. unique visits opened:**
> - **Unique visits that opened** (`open_eligible_sessions` = `COUNT(DISTINCT session_id) FILTER (WHERE is_opened)`, and `exposed_open_sessions` = `COUNT(DISTINCT session_id) FILTER (WHERE is_exposed AND is_opened)`) are **visit/session-level** counts used for `open_rate`, `engagement_rate`, and privacy-floor cohort checks.
> - **Total opening events** (`total_openings` = `COUNT(*)` over `opening_metrics` keyed by `(dish_id, session_id, opening_id)`) and **finalized openings** (`timed_openings` = `COUNT(*) FILTER (WHERE has_final_checkpoint)`) are **opening-event-level** counts used for `timing_coverage` and `avg_interaction_time_seconds`. A finalized opening uses the greatest cumulative time from its linked checkpoints, including any nonfinal checkpoint on that opening. Openings with only nonfinal checkpoints are excluded from the average.

| Metric / Card | Question Answered | Unit | Eligible Visits / Cohort | Numerator | Denominator | Time Window & UTC Boundaries | Privacy Threshold & Complementary Suppression | Missing-Data & Valid-Zero Behavior |
|---|---|---|---|---|---|---|---|---|
| `active_sessions` | How many distinct diner visits had a qualifying exposure to this dish? | Count (integer visits) | Distinct `session_id`s with `dish_viewed` (`is_exposed = true`) | `COUNT(DISTINCT session_id) FILTER (WHERE is_exposed)` | N/A (count) | `[now - 24h, now)` UTC (`occurred_at >= $2 AND occurred_at < $3`) | Suppressed (`null`, `SUPPRESSED`) if `total_sessions < 10`, or if `0 < timed_sessions < 10` or `0 < open_eligible_sessions < 10` (complementary suppression in `toOwnerReport()`). | Never `VALID_ZERO`: 0 active sessions is below floor (`SUPPRESSED`, or `report_status = 'EMPTY'` when 0 dishes have observations). |
| `open_rate` | Of exposed visits, what share opened the dish detail? | Fraction `[0, 1]` rounded to 3 decimals (UI: `%` to 1 decimal) | `total_sessions` (distinct exposed visits) | Distinct visits both exposed and opened: `COUNT(DISTINCT session_id) FILTER (WHERE is_exposed AND is_opened)` (`\|O ∩ X\|`) | Distinct exposed visits: `total_sessions` (`\|X\|`) | `[now - 24h, now)` UTC (`[start, end)`) | Suppressed if `total_sessions < 10`, or if `0 < timed_sessions < 10` or `0 < open_eligible_sessions < 10` (complementary suppression). | `denominator = 0` → `null` (`NOT_MEASURABLE`); `numerator = 0` with `denominator >= 10` → `0` (`VALID_ZERO`). |
| `avg_interaction_time_seconds` | Across finalized dish openings, how long did diners actively interact on average? | Seconds (decimal, capped at `300` s per opening) | `timed_sessions` (distinct opened visits with `>= 1` finalized checkpoint) | Sum of the greatest cumulative `active_ms` per finalized opening, divided by `1000.0` | Count of finalized openings (`has_final_checkpoint = true`). | `[now - 24h, now)` UTC (`[start, end)`) | Suppressed if `total_sessions < 10` or `timed_sessions < 10` (and triggers complementary suppression on `active_sessions`, `timing_coverage`, `open_rate` when `0 < timed_sessions < 10`). | `timed_sessions = 0` → `null` (`NOT_MEASURABLE`); `average_active_seconds = 0` with `timed_sessions >= 10` → `0` (`VALID_ZERO`). |
| `timing_coverage` | What share of all dish opening events produced a finalized timing checkpoint? | Fraction `[0, 1]` rounded to 3 decimals (UI: `%` to 1 decimal) | `open_eligible_sessions` (distinct opened visits) | Finalized opening events: `COUNT(*) FILTER (WHERE has_final_checkpoint)` | Total opening events: `COUNT(*)` over `opening_metrics` | `[now - 24h, now)` UTC (`[start, end)`) | Suppressed if `total_sessions < 10` or `open_eligible_sessions < 10`, or if `0 < timed_sessions < 10` (complementary suppression). | `total_openings = 0` → `null` (`NOT_MEASURABLE`); `timed_openings = 0` with `open_eligible_sessions >= 10` → `0` (`VALID_ZERO`). |
| `save_rate` | Of exposed visits, what share recorded a direct save? | Fraction `[0, 1]` rounded to 3 decimals (UI: `%` to 1 decimal) | `total_sessions` (distinct exposed visits) | Distinct exposed visits with `dish_saved` and `save_origin = 'direct'` (retained even if later `dish_unsaved`; `save_origin = 'undo'` excluded) | Distinct exposed visits: `total_sessions` (`\|X\|`) | `[now - 24h, now)` UTC (`[start, end)`) | Suppressed if `total_sessions < 10`. Independent of small timing/opened cohorts when `total_sessions >= 10`. | `denominator = 0` → `null` (`NOT_MEASURABLE`); `numerator = 0` with `denominator >= 10` → `0` (`VALID_ZERO`). |
| `engagement_rate` | Of opened visits, what share reached deep engagement (`>= 10,000` ms active time or qualifying displayed comparison)? | Fraction `[0, 1]` rounded to 3 decimals (UI: `%` to 1 decimal) | `open_eligible_sessions` (distinct opened visits) | Distinct opened visits with `active_ms >= 10000` on any linked opening OR a qualifying `dish_compared` (prior opening of either dish in window; equal timestamps ordered by same `producer_id` and `opened.local_sequence < comp.local_sequence`; participant dish opened in window) | Distinct opened visits: `open_eligible_sessions` (`\|O\|`) | `[now - 24h, now)` UTC (`[start, end)`) | Suppressed if `total_sessions < 10` or `open_eligible_sessions < 10` (and triggers complementary suppression on `active_sessions`, `avg_interaction_time_seconds`, `timing_coverage`, `open_rate` when `0 < open_eligible_sessions < 10`). | `open_eligible_sessions = 0` → `null` (`NOT_MEASURABLE`); `numerator = 0` with `open_eligible_sessions >= 10` → `0` (`VALID_ZERO`). |

### 1.2 Unavailable / Unmeasurable Metrics

| Metric / Card | Current Status in `owner_report.v1` | Rule |
|---|---|---|
| **Verified orders** | Not in `owner_report.v1` (`UNKNOWN_OR_UNAVAILABLE` / `NOT_MEASURABLE`) | Must remain unavailable / not measurable until an eligible, linked order source exists for owner reporting. Never fabricated or represented as `0`. |
| **Portion previews** | Outside the legacy fixture scope | The production display-action path reports eligible rendered previews. The legacy fixture cannot prove those counts or supply synthetic zeros for an unavailable source. |

---

## 2. Independent Arithmetic & Expected Results (Canonical Acceptance Example)

### Input Scenario

- **Exposed visits (`dish_viewed`):** 14 distinct sessions (`S1..S14`).
- **Initial openings (`dish_detail_opened`):** 10 unique sessions (`S1..S10`) open once (`O1..O10`), each with a finalized checkpoint (`active_ms = 12,000`, `activity_final = true`).
- **Second opening:** `S1` opens a second time (`O11`) with only a nonfinal checkpoint (`active_ms = 5,000`, `activity_final = false`).
- **Total opening events:** `10 + 1 = 11`.
- **Unique visits opened:** `10` (`S1..S10`).
- **Finalized openings:** `10` (`O1..O10`; `O11` is nonfinal).
- **Direct saves:** 3 `dish_saved` events (`save_origin = 'direct'`) across 3 exposed sessions (`S1..S3`), with `S1` subsequently emitting `dish_unsaved`.

### Independent Calculation

| Metric | Independent Formula & Arithmetic | Expected Exact Value | Expected `owner_report.v1` Value & Status |
|---|---|---|---|
| **Active sessions** (`active_sessions`) | `\|{S1..S14}\| = 14` (`>= 10` floor) | `14` | `value: 14`, `status: "NORMAL"` |
| **Unique visits opened** | `\|{S1..S10}\| = 10` (internal cohort; not a separate public card) | `10` | Used as `open_eligible_sessions = 10`, `exposed_open_sessions = 10` |
| **Total opening events** | `\|{O1..O11}\| = 11` (internal denominator for `timing_coverage`) | `11` | Used as `total_openings = 11` |
| **Open rate** (`open_rate`) | `10 / 14 = 0.7142857...` → `71.4%` (`Math.round((10/14)*1000)/1000 = 0.714`) | `10/14 = 71.4%` | `value: 0.714`, `status: "NORMAL"` |
| **Timing coverage** (`timing_coverage`) | `10 / 11 = 0.9090909...` → `90.9%` (`Math.round((10/11)*1000)/1000 = 0.909`) | `10/11 = 90.9%` | `value: 0.909`, `status: "NORMAL"` |
| **Average finalized interaction time** (`avg_interaction_time_seconds`) | `(10 × 12,000 ms) / 10 / 1000 = 12` s (nonfinal `5,000` ms on `O11` excluded) | `12 seconds` | `value: 12`, `status: "NORMAL"` |
| **Direct-save rate** (`save_rate`) | `3 / 14 = 0.2142857...` → `21.4%` (undo on `S1` does not erase original direct save) | `3/14 = 21.4%` | `value: 0.214`, `status: "NORMAL"` |
| **Engagement rate** (`engagement_rate`) | `10 / 10 = 1.0` → `100.0%` (all 10 opened visits have `12,000 ms >= 10,000 ms`) | `10/10 = 100.0%` | `value: 1`, `status: "NORMAL"` |

---

## 3. Actual Owner API / Report Comparison & Cross-Layer Consistency

### 3.1 Actual PostgreSQL `readOwnerReport()` Comparison

Executed in real PostgreSQL via `backend/src/owner-report.integration.ts` (`computes exact S7-DATA-17 acceptance scenario metrics against PostgreSQL`):

| Metric | Independent Expected | Actual `readOwnerReport()` Output | Match |
|---|---:|---:|---|
| `active_sessions` | `14` (`NORMAL`) | `{ value: 14, status: 'NORMAL' }` | Exact match |
| Raw SQL `unique_opened_visits` | `10` | `10` | Exact match |
| Raw SQL `opening_events` | `11` | `11` | Exact match |
| `open_rate` | `0.714` (`NORMAL`) | `{ value: 0.714, status: 'NORMAL' }` | Exact match |
| `timing_coverage` | `0.909` (`NORMAL`) | `{ value: 0.909, status: 'NORMAL' }` | Exact match |
| `avg_interaction_time_seconds` | `12` (`NORMAL`) | `{ value: 12, status: 'NORMAL' }` | Exact match |
| `save_rate` | `0.214` (`NORMAL`) | `{ value: 0.214, status: 'NORMAL' }` | Exact match |
| `engagement_rate` | `1` (`NORMAL`) | `{ value: 1, status: 'NORMAL' }` | Exact match |

### 3.2 Owner-Facing Consistency Audit

- **Public contracts (`packages/contracts/src/owner-report.ts`):** `OwnerDishReportSchema` strips and rejects `eligible_sessions`; `toOwnerReport()` enforces complementary suppression when `0 < timed_sessions < 10` or `0 < open_eligible_sessions < 10`.
- **Backend SQL & HTTP (`backend/src/owner-report.ts`, `backend/src/index.ts`, `backend/src/owner-report-export.ts`):** `readOwnerReport()` checks `owner` membership in `app_private.staff_membership` before setting `app.tenant_id`, runs in `BEGIN READ ONLY`, and projects through `toOwnerReport()`. CSV export (`serializeOwnerReportCsv`) outputs empty cells for any non-`NORMAL`/`VALID_ZERO` status.
- **Dashboard (`frontend/console/src/owner-dashboard/report-data.tsx`, `report-api.ts`, `uneeza-report.ts`, `data.ts`):**
  - `ReportData` / `ReportView` validates responses with `OwnerDishReportSchema`, never recalculates metrics or reconstructs suppressed counts, and renders `STATUS_TEXT` (`Not enough visits yet`, `Not measurable`, etc.).
  - `UNEEZA_REPORT` is explicitly labelled as a saved synthetic copy (`Synthetic test data ... Not real diners`).
  - Demo hardcoded dataset in `data.ts` (`Simple & Quick`, including `ord` verified orders and `p25` 2.5D previews) is isolated to the prototype demo screens (`Overview`, `AI Insight Report`, `Dish performance`) and is separate from the authoritative `Report data` (`owner_report.v1`) view.
- **Owner AI (`backend/src/owner-ai/report-input.ts`, `report-adapter.ts`, `recommendation.ts`):**
  - `toOwnerRecommendationRequest()` consumes `InternalOwnerDishReportSchema` server-side, applies `toOwnerReport(report)` so complementary suppression is never bypassed, maps `NOT_MEASURABLE` to `missing` (never `0`), and never exposes `eligible_sessions` or non-`available` values in recommendations.
- **Synthetic generator (`test-data/owner-synthetic-p0-v2/`):**
  - `expected_answers.json` keeps `orders_revenue_waste` as `UNKNOWN_OR_UNAVAILABLE` (`null`), enforces `threshold: 10`, and reconciles against `owner_report.v1` in `backend/src/owner-report.data12-reconciliation.test.ts` and `frontend/console/src/owner-dashboard/uneeza-report.ts`.

---

## 4. Edge-Case Test Coverage & Exact Test Results

### 4.1 Required Edge-Case Mapping

| Edge Case | Coverage Location |
|---|---|
| Duplicate event ingestion & idempotency | `backend/src/owner-report.integration.ts` (`prevents duplicate ingestion from inflating event counts or metric numerators`), `backend/src/consumer/owner-synthetic.integration.ts` |
| Repeated openings vs. unique opened visits | `backend/src/owner-report.integration.ts` (`computes exact S7-DATA-17 acceptance scenario metrics against PostgreSQL`, `counts repeated openings within a visit once per session for rates and per opening for timing`), `backend/src/owner-report.test.ts` |
| Deterministic tie handling in comparison attribution | `backend/src/owner-report.integration.ts` (`orders equal timestamps deterministically by producer_id and local_sequence`), `backend/src/comparison-report.integration.ts` |
| UTC window end exclusion (`[start, end)`) | `backend/src/owner-report.integration.ts` (greatest checkpoint and half-open UTC window case), `backend/src/comparison-report.integration.ts` |
| Privacy boundaries at 9, 10, and 11 eligible sessions | `backend/src/owner-report.integration.ts` (`enforces privacy thresholds at 9, 10, and 11 sessions and independent complementary suppression`), `backend/src/owner-report.s6-hardening.test.ts`, `backend/src/owner-report.data12.test.ts`, `packages/contracts/src/owner-report.test.ts` |
| `EMPTY` vs. `VALID_ZERO` vs. `NOT_MEASURABLE` | `backend/src/owner-report.integration.ts` (`distinguishes EMPTY, VALID_ZERO, NOT_MEASURABLE, and direct-save-then-undo semantics`), `backend/src/owner-report.s6-hardening.test.ts`, `packages/contracts/src/owner-report.test.ts` |
| Nonfinal-only openings excluded from average timing, cumulative maxima retained for finalized openings | `backend/src/owner-report.integration.ts` (canonical acceptance test and mixed-checkpoint case) |
| Direct saves retained after an undo | `backend/src/owner-report.integration.ts` (canonical acceptance test + save/undo test verifying `save_origin = 'undo'` is excluded) |

### 4.2 Exact Executed Commands & Results

1. **PostgreSQL + pgTAP integration suite:** `node scripts/test-db.mjs`
   - **PASS** — 13 pgTAP files (**363 assertions passed**), **10 integration test files / 148 tests passed**, including `backend/src/owner-report.integration.ts` (**7/7 tests passed**).
2. **Owner-report contract & unit suites:** `npx vitest run backend/src/owner-report.test.ts backend/src/owner-report.s6-hardening.test.ts backend/src/owner-report.data12.test.ts backend/src/owner-report.data12-reconciliation.test.ts packages/contracts/src/owner-report.test.ts`
   - **PASS** — **5 test files / 67 tests passed** (`packages/contracts/src/owner-report.test.ts`: 43, `owner-report.test.ts`: 12, `owner-report.data12.test.ts`: 5, `owner-report.data12-reconciliation.test.ts`: 4, `owner-report.s6-hardening.test.ts`: 3).
3. **Owner AI, dashboard report API & CSV export suites:** `npx vitest run backend/src/owner-ai/ frontend/console/src/owner-dashboard/report-api.test.tsx backend/src/owner-report-export.test.ts`
   - **PASS** — **7 test files / 114 tests passed** (`owner-report-export.test.ts`: 10, `evaluation.test.ts`: 21, `report-input.test.ts`: 21, `recommendation.test.ts`: 21, `report-adapter.test.ts`: 17, `report-producer-seam.test.ts`: 3, `report-api.test.tsx`: 21).
4. **Formatting, docs & context checks:**
   - `npx biome check backend/src/owner-report.ts backend/src/owner-report.integration.ts packages/contracts/src/owner-report.ts` — **PASS** (`Checked 3 files in 36ms`).
   - `node scripts/check-docs.mjs` — **PASS** (`Local documentation links checked in 88 Markdown files`).
   - `node scripts/context.mjs check` — **PASS** (`Context valid and fresh: 13 modules, 10 handoffs`).
5. **Synthetic dataset Python suite:** `python3 -m unittest discover -s test-data/owner-synthetic-p0-v2/tests -p "test_*.py" -v`
   - **PARTIAL** — 68 non-schema unit tests (`test_fixture.py`, `test_metric_examples.py`, `test_ai_report_inputs.py`, `test_followup_*.py`, `test_negative_cases.py`, `test_session_completion.py`) **PASS**; 22 tests in `test_validator_integration.py` **FAIL** in this environment because `jsonschema` is not installed in `python3`.

---

## 5. Harshita's Independent Calculation Handoff

- **Review Status:** **PENDING** (Harshita has not yet independently confirmed these figures).

### Self-Contained Verification Inputs & Formulas

1. **Event Inputs (single dish, single `[start, end)` 24h UTC window, `traffic_class = 'live'`):**
   - `14` distinct sessions with `dish_viewed` (`S1..S14`).
   - `10` distinct sessions (`S1..S10`) with one `dish_detail_opened` (`O1..O10`) and one finalized `dish_activity_checkpoint` (`active_ms = 12,000`, `activity_final = true`).
   - `1` additional `dish_detail_opened` (`O11`) on `S1` with one nonfinal `dish_activity_checkpoint` (`active_ms = 5,000`, `activity_final = false`).
   - `3` `dish_saved` events (`save_origin = 'direct'`) on `S1, S2, S3`, plus `1` `dish_unsaved` event on `S1`.
2. **Formulas & Expected Results:**
   - `Active sessions` = `|{S1..S14}| = 14`
   - `Unique visits opened` = `|{S1..S10}| = 10`
   - `Total opening events` = `|{O1..O11}| = 11`
   - `Open rate` = `10 / 14 = 0.714` (`71.4%`)
   - `Timing coverage` = `10 / 11 = 0.909` (`90.9%`)
   - `Average finalized interaction time` = `(10 × 12,000 ms) / 10 / 1000 = 12` seconds (nonfinal `5,000` ms excluded)
   - `Direct-save rate` = `3 / 14 = 0.214` (`21.4%`) (undo does not erase original direct save)
   - `Engagement rate` = `10 / 10 = 1` (`100.0%`)

---

## 6. Remaining Gaps

1. **Harshita's independent confirmation:** Pending review/sign-off.
2. **Verified orders & portion previews:** Remain unavailable / not measurable in `owner_report.v1` until an eligible, linked source is approved and wired.
3. **Python `jsonschema` environment dependency:** `test-data/owner-synthetic-p0-v2/tests/test_validator_integration.py` requires `jsonschema==4.26.0` in `python3` to execute schema-validator subprocess checks.
4. **Console authentication and rollout:** The signed-in owner workspace supplies the session token. The null token getter belongs to the standalone dashboard demo. Production rollout flags and live report eligibility are outside this synthetic acceptance check.

---

## 7. Final Verdict

**PARTIALLY COMPLETE**

All metric definitions, canonical acceptance arithmetic, PostgreSQL/contract/AI/dashboard consistency checks, and edge-case tests are verified and passing. The sole remaining item required for full sign-off is **Harshita's independent calculation confirmation** (currently pending).
