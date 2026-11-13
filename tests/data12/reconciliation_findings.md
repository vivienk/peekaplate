# DATA-12 — Synthetic Fixture & Report Output Reconciliation Findings

- **Date:** November 13, 2026
- **Base `develop` Commit SHA:** `385a19f` (includes merged PR #107, PR #123, PR #134, PR #135, PR #144, and PR #152)
- **Reconciled Artifacts:**
  - Uneeza's approved independent validation fixtures: `tests/data06/privacy_boundaries.json` & `tests/data06/descriptive_signals.json` (PR #144) + `backend/src/owner-report.data12.test.ts` (PR #155)
  - Current backend report implementations: `backend/src/owner-report.ts` & `backend/src/comparison-report.ts` (#107 / #134 / #152)
  - Console UI fixture snapshot: `frontend/console/src/owner-dashboard/uneeza-report.ts`

---

## 1. Reconciliation Matrix Across All 4 Requested Dimensions

| Dimension | Uneeza Fixture / Contract Expectation | Current `develop` Report Output (`#107` / `#134` / `#152`) | Reconciliation Status |
| :--- | :--- | :--- | :--- |
| **1. Privacy Boundaries (`9 / 10 / 11` & Repeat)** | `D06-PRIVACY-09` (9 distinct sessions) → `SUPPRESSED` (`null`); `D06-PRIVACY-10` & `11` → `NORMAL`; `D06-PRIVACY-REPEAT` (10 events in 1 session → 1 distinct session) → `SUPPRESSED` (`null`) | `readOwnerReport` enforces `total_sessions < 10 → SUPPRESSED` (`null`) on distinct sessions, disclosing exact metrics at `10` and `11` | **ALIGNED (PASS)** |
| **2. Comparison Attribution (`D06-COMPARE-01` & PR #134)** | Qualifying comparison events counted only after ordered detail-open evidence, deduplicated by canonical event ID (`D06-DEDUPE-01`), with coupled suppression when `comparison_eligible_sessions < 10` | `readComparisonReport` & `owner_comparison_v1` enforce ordered `dish_detail_opened → dish_compared` matching and PR #134 coupled suppression on both `comparison_rate` and `open_rate` | **ALIGNED (PASS)** |
| **3. Timing Coverage (`timing_coverage`)** | `timed_openings / total_openings` disclosed when `open_eligible_sessions >= 10`; suppressed when `open_eligible_sessions < 10`; `NOT_MEASURABLE` (`null`) when `total_openings = 0` | `readOwnerReport` returns `NORMAL` ratio at `>= 10` eligible open sessions, `SUPPRESSED` (`null`) below `10`, and `NOT_MEASURABLE` (`null`) when `total_openings = 0` | **ALIGNED (PASS)** |
| **4. Suppression States & Frontend Snapshot (`uneeza-report.ts`)** | Explicit `NORMAL`, `VALID_ZERO`, `SUPPRESSED`, `NOT_MEASURABLE`, and `EMPTY` statuses; `DATA-06` composite score remains `MISSING` / disabled | All 5 metric/report statuses match `OwnerDishReportSchema`. **Note on UI snapshot:** `frontend/console/src/owner-dashboard/uneeza-report.ts` (captured from earlier commit `205214f`) still carries `freshness.is_stale: false` and `calculation_version: 'production.v1'`, whereas live `develop` `readOwnerReport` emits `freshness.is_stale: null` and `calculation_version: 'synthetic.v1'` | **ALIGNED WITH NOTE** |

---

## 2. Executed Verification Commands

- `npx vitest run backend/src/owner-report.test.ts backend/src/owner-report.s6-hardening.test.ts backend/src/owner-report.data12-reconciliation.test.ts` → **PASS**
- `pnpm verify test:db` (real PostgreSQL + pgTAP suites including `owner-synthetic.integration.ts`, `facts.integration.ts`, and `comparison-report.integration.ts`) → **PASS** (310 pgTAP assertions + 130 PostgreSQL integration tests).
