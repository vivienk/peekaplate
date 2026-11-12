# S6-DATA-13 — Release Hardening Validation Findings

- **Ticket:** S6-DATA-13 (*Validate secure owner-report API, privacy and frontend reconciliation*)
- **Date:** November 12, 2026
- **PR branch merge base with `develop`:** `f470786c3b8b7337ed2fb2790988ab940a77f2db`
- **Relevant PRs & Integration Suites:**
  - [PR #107](https://github.com/vivienk/peekaplate/pull/107) & [Worker/DB integration cases](../../../backend/src/dish.integration.ts) — `owner_report.v1` synthetic API, SQL privacy floor baseline, and real Worker/DB report-access & revocation integration suites
  - [PR #123](https://github.com/vivienk/peekaplate/pull/123) — Comparison report fixtures and privacy cases
  - [PR #134](https://github.com/vivienk/peekaplate/pull/134) — Coupled suppression and ordered comparison evidence matching
  - [PR #135](https://github.com/vivienk/peekaplate/pull/135) — [Staging Worker deployment verification](../../../docs/owner-report-staging.md)
  - [PR #131](https://github.com/vivienk/peekaplate/pull/131) — Deterministic CSV export route (`S5-DATA-11`, approved)
- **Staging URLs & Allowlist Scope:**
  - Staging Console Origin: `https://peekaplate-console-staging.pages.dev` (plus local `http://127.0.0.1:5174`)
  - Approved Synthetic Fixture Venue: `00000000-0000-4000-8000-000000000123` (`source=synthetic`)
  - Production endpoints remain deliberately gated (`503 service_unavailable`) per `docs/owner-report-staging.md`.

---

## 1. Reproducible Expected vs Actual Matrix

| Verification Area | Evidence Layer | Scenario | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication & Isolation** | Unit reader (`owner-report.s6-hardening.test.ts`) + Worker/DB integration (`backend/src/dish.integration.ts`, PR #107) | Owner A reads Venue A (`owner` role) | `200` / valid `owner_report.v1` envelope inside read-only transaction | Returned `owner_report.v1` with `venue_id = 00000000-0000-4000-8000-000000000123` | **PASS** |
| **Cross-Restaurant Leakage** | Unit reader (`owner-report.s6-hardening.test.ts`) + Worker/DB integration (`backend/src/dish.integration.ts`, PR #107) | Owner B attempts to read Venue A | Rejected with `CommandError(403)` before reading `owner_observation_v1` | Rejected with `403`; zero rows leaked across tenants | **PASS** |
| **Revoked Access** | Unit reader (`owner-report.s6-hardening.test.ts`) + Worker/DB integration (`backend/src/dish.integration.ts`, PR #107) | Revoked owner attempts to read Venue A | Rejected with `CommandError(403)` immediately on membership check | Rejected with `403` | **PASS** |
| **Privacy Boundary (9)** | Unit reader (`owner-report.s6-hardening.test.ts`) | Dish with `total_sessions = 9` | `evidence_state = SUPPRESSED`, all metric values `null` (never `0`) | `evidence_state = SUPPRESSED`, `active_sessions.value = null`, rates `null` | **PASS** |
| **Privacy Boundary (10)** | Unit reader (`owner-report.s6-hardening.test.ts`) | Dish with `total_sessions = 10` | `evidence_state = NORMAL`, `active_sessions = 10`, exact rates disclosed | `evidence_state = NORMAL`, `active_sessions = 10`, `open_rate = 0.6` | **PASS** |
| **Privacy Boundary (11)** | Unit reader (`owner-report.s6-hardening.test.ts`) | Dish with `total_sessions = 11` | `evidence_state = NORMAL`, full disclosure above floor | `evidence_state = NORMAL`, `active_sessions = 11` | **PASS** |
| **Valid-Zero vs Not-Measurable** | Unit reader (`owner-report.s6-hardening.test.ts`) | `11` sessions with `0` opens/saves (`open_eligible_sessions = 0`, `timed_sessions = 0`) | `open_rate = 0` (`VALID_ZERO`), `save_rate = 0` (`VALID_ZERO`), `engagement_rate` / `timing_coverage` / `avg_interaction_time_seconds` = `null` (`NOT_MEASURABLE`) | `open_rate = 0` (`VALID_ZERO`), `save_rate = 0` (`VALID_ZERO`), unmeasurable rates/timing `null` (`NOT_MEASURABLE`) | **PASS** |
| **Empty Venue Fixture** | Unit reader (`owner-report.s6-hardening.test.ts`) | `0` monitored dishes for venue | `report_status = EMPTY`, `dishes = []`, `freshness.is_stale = null` | Returned `EMPTY` envelope with null freshness abstention | **PASS** |
| **Deduplication & Isolation** | Real PostgreSQL/Worker (`backend/src/consumer/owner-synthetic.integration.ts`) | `two_session_story.jsonl` (22 delivered, 21 unique, `trafficClass = test`) | Deduplicated in-batch and on replay; `0` rows in `owner_observation_v1` | `21` canonical events persisted; `0` rows leaked to `owner_observation_v1` | **PASS** |
| **Frontend Reconciliation** | Console UI shell (`frontend/console/`) | Render report screen verifying `source`, date window, coverage, suppression labels | Report screen rendered and verified against `owner_report.v1` labels | `frontend/console/` is currently a UI primitive shell with no report screen rendered yet (no fabricated metrics present) | **NOT RUN / BLOCKED** |
| **DATA-06 Scope Guard** | Schema & reader contract | Composite numeric score availability | Composite score remains disabled/unavailable until product-approved parameters are versioned | Confirmed disabled; only descriptive P0 `owner_report.v1` metrics are exposed | **PASS** |

---

## 2. Executed Verification Commands & Results

- `npx vitest run backend/src/owner-report.test.ts backend/src/owner-report.s6-hardening.test.ts` (Direct unit reader checks): **15/15 PASS** (12 baseline + 3 S6 hardening suites).
- `pnpm verify test:db` (Real PostgreSQL/Worker integration & pgTAP suites): **PASS** — **310 pgTAP assertions** + **130 real PostgreSQL integration tests** across 9 suites (`dish`, `ingestion`, `consumer`, `order-ingestion`, `owner-menu`, `owner-synthetic`, `facts`, `comparison-report`, `bundle-producer`).

---

## 3. Sign-Off & Review Handoff

- **Independent Technical Review:** Requested from **Sai** and **Uneeza** (no self-approval applied).
- **Hosted Acceptance & Metric Sign-Off:** Separate hosted staging verification and final metric sign-off pending from **Vivien Kong**.
