# DATA-12 — Synthetic Fixture & Report Output Reconciliation Findings

- **Date:** November 13, 2026
- **Base `develop` Commit SHA:** `385a19f` (includes merged PR #107, PR #123, PR #134, PR #135, PR #144, and PR #152)
- **Reconciled Artifacts:**
  - Uneeza's approved independent validation fixtures: `tests/data06/privacy_boundaries.json` & `tests/data06/descriptive_signals.json` (PR #144) + `backend/src/owner-report.data12.test.ts` (PR #155)
  - Current backend report implementations: `backend/src/owner-report.ts` & `backend/src/comparison-report.ts` (#107 / #134 / #152)
  - Console UI fixture & freshness label update: `frontend/console/src/owner-dashboard/uneeza-report.ts` (PR #170)

---

## 1. Local & CI Verified Reconciliation Matrix (PASS)

All four dimensions below have been verified locally and in CI against Uneeza's synthetic fixtures and current `develop` report logic:

| Dimension | Uneeza Fixture / Contract Expectation | Current `develop` Report Output (`#107` / `#134` / `#152`) | Local / CI Status |
| :--- | :--- | :--- | :--- |
| **1. Privacy Boundaries (`9 / 10 / 11` & Repeat)** | `D06-PRIVACY-09` (9 distinct sessions) → `SUPPRESSED` (`null`); `D06-PRIVACY-10` & `11` → `NORMAL`; `D06-PRIVACY-REPEAT` (10 events in 1 session → 1 distinct session) → `SUPPRESSED` (`null`) | `readOwnerReport` enforces `total_sessions < 10 → SUPPRESSED` (`null`) on distinct sessions, disclosing exact metrics at `10` and `11` | **VERIFIED (LOCAL/CI PASS)** |
| **2. Comparison Attribution (`D06-COMPARE-01` & PR #134)** | Qualifying comparison events counted only after ordered detail-open evidence, deduplicated by canonical event ID (`D06-DEDUPE-01`), with coupled suppression when eligible cohorts  | `readComparisonReport` & `owner_comparison_v1` enforce ordered `dish_detail_opened → dish_compared` matching and coupled suppression (`INSUFFICIENT` / `SUPPRESSED`) below 10 sessions | **VERIFIED (LOCAL/CI PASS)** |
| **3. Timing Coverage (`timing_coverage`)** | `timed_openings / total_openings` disclosed when `open_eligible_sessions >= 10`; suppressed when `< 10` (with PR #134 coupled suppression on `open_rate`); `NOT_MEASURABLE` (`null`) when `total_openings = 0` | `readOwnerReport` returns `NORMAL` ratio at `>= 10` eligible open sessions, `SUPPRESSED` (`null`) below `10`, and `NOT_MEASURABLE` (`null`) when `total_openings = 0` | **VERIFIED (LOCAL/CI PASS)** |
| **4. Suppression States & UI Reconciliation (`PR #170`)** | Explicit `NORMAL`, `VALID_ZERO`, `SUPPRESSED`, `NOT_MEASURABLE`, and `EMPTY` statuses; `DATA-06` composite score remains disabled | All 5 statuses match `OwnerDishReportSchema`; Jeffin's **PR #170** aligns the console snapshot with `freshness.is_stale: null` (*"freshness not known"*) | **VERIFIED (LOCAL/CI PASS)** |

---

## 2. Provenance, Freshness & Window-Boundary Audit Findings (Per Vivien & Sai Check)

1. **Synthetic Venue Provenance (`00000000-0000-4000-8000-000000000123`):**
   - `app_private.owner_observation_v1` (`migrations/20261026120000_observation_facts.sql:175`) filters strictly to `traffic_class = 'live'`, while `traffic_class = 'test'` is excluded (verified in `owner-synthetic.integration.ts` and `tests/db/observation-facts.sql:210`).
   - For the allowlisted synthetic demo venue `00000000-0000-4000-8000-000000000123`, seeded synthetic observations are ingested under `traffic_class = 'live'` inside that isolated tenant and labeled `source = 'synthetic'` by the HTTP handler (`/api/v1/venues/:venueId/analytics/dishes?source=synthetic`).
2. **Freshness Abstention (`freshness.is_stale: null`):**
   - `readOwnerReport` intentionally emits `freshness.is_stale: null` until an authoritative ingestion freshness signal is wired (`freshness signal: unknown` ≠ `Fresh`), matching the updated UI copy in **PR #170**.
3. **SQL Time-Window End Boundary (`<=` vs `<`):**
   - `backend/src/owner-report.ts` (`OWNER_REPORT_QUERY`, lines 54 & 67) currently filters with **inclusive** upper bound `obs.occurred_at <= `, whereas the console dashboard UI copy labels the window end as **"end excluded"** (`<`). Flagged for Sai, Jeffin, and Zhiliang Wang so either SQL or UI wording is aligned consistently.

---

## 3. Hosted Staging End-to-End Validation (NOT RUN / PENDING)

To distinguish local/CI verification from hosted staging certification, the following live end-to-end journey remains **NOT RUN** pending release/staging coordination with **Sai**, **Jeffin**, and **Vivien**:
- **Live Diner Triggers → Canonical Ingestion → Owner Dashboard:** Live browser interaction on hosted staging diner (`#78` / `#158`) delivering to `POST /observations` → Queue → private R2 → Supabase projections → authenticated `/api/v1/venues/:venueId/analytics/dishes` → rendered console dashboard screen.
- **Remaining Dependencies / Blockers:** TRK/consent alignment with Adam/Vivien and hosted staging deployment parity across diner/worker/console.

---

## 4. Executed Local & CI Verification Commands

- `npx vitest run backend/src/owner-report.test.ts backend/src/owner-report.s6-hardening.test.ts backend/src/owner-report.data12-reconciliation.test.ts` → **18/18 PASS**
- `pnpm verify test:db` (real PostgreSQL + pgTAP suites including `owner-synthetic.integration.ts`, `facts.integration.ts`, and `comparison-report.integration.ts`) → **PASS** (310 pgTAP assertions + 130 PostgreSQL integration tests).
