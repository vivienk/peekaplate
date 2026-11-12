# S6-DATA-13 — Release Hardening Validation Findings

- **Ticket:** S6-DATA-13 (*Validate secure owner-report API, privacy and frontend reconciliation*)
- **Date:** November 12, 2026
- **Base `develop` Commit SHA:** `f470786`
- **Relevant PRs:**
  - [PR #107](https://github.com) — `owner_report.v1` synthetic API and SQL privacy floor baseline
  - [PR #123](https://github.com) — Comparison report fixtures and privacy cases
  - [PR #134](https://github.com) — Coupled suppression and ordered comparison evidence matching
  - [PR #135](https://github.com) — Staging Worker deployment verification (`docs/owner-report-staging.md`)
  - [PR #131](https://github.com) — Deterministic CSV export route (`S5-DATA-11`, ready for review)
- **Staging URLs & Allowlist Scope:**
  - Console Origin: `https://pages.dev` (plus `http://127.0.0.1:5174`)
  - Approved Synthetic Fixture Venue: `00000000-0000-4000-8000-000000000123` (`source=synthetic`)
  - Production endpoints remain deliberately gated (`503 service_unavailable`) per `docs/owner-report-staging.md`.

---

## 1. Reproducible Expected vs Actual Matrix

| Verification Area | Scenario | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication & Isolation** | Owner A reads Venue A (`owner` role) | `200` / valid `owner_report.v1` envelope inside read-only transaction | Returned `owner_report.v1` with `venue_id = 00000000-0000-4000-8000-000000000123` | **PASS** |
| **Cross-Restaurant Leakage** | Owner B attempts to read Venue A | Rejected with `CommandError(403)` before reading `owner_observation_v1` | Rejected with `403`; zero rows leaked across tenants | **PASS** |
| **Revoked Access** | Revoked owner attempts to read Venue A | Rejected with `CommandError(403)` immediately on membership check | Rejected with `403` | **PASS** |
| **Privacy Boundary (9)** | Dish with `total_sessions = 9` | `evidence_state = SUPPRESSED`, all metric values `null` (never `0`) | `evidence_state = SUPPRESSED`, `active_sessions.value = null`, rates `null` | **PASS** |
| **Privacy Boundary (10)** | Dish with `total_sessions = 10` | `evidence_state = NORMAL`, `active_sessions = 10`, exact rates disclosed | `evidence_state = NORMAL`, `active_sessions = 10`, `open_rate = 0.6` | **PASS** |
| **Privacy Boundary (11)** | Dish with `total_sessions = 11` | `evidence_state = NORMAL`, full disclosure above floor | `evidence_state = NORMAL`, `active_sessions = 11` | **PASS** |
| **Valid-Zero vs Missing** | `11` sessions with `0` opens/saves and `0` timed sessions | `open_rate = 0` (`VALID_ZERO`), `save_rate = 0` (`VALID_ZERO`), `avg_interaction_time_seconds = null` | `open_rate = 0` (`VALID_ZERO`), `save_rate = 0` (`VALID_ZERO`), timing `null` | **PASS** |
| **Empty Venue Fixture** | `0` monitored dishes for venue | `report_status = EMPTY`, `dishes = []`, `freshness.is_stale = null` | Returned `EMPTY` envelope with null freshness abstention | **PASS** |
| **Deduplication & Isolation** | `two_session_story.jsonl` (22 delivered, 21 unique, `trafficClass = test`) | Deduplicated in-batch and on replay; `0` rows in `owner_observation_v1` | `21` canonical events persisted; `0` rows leaked to `owner_observation_v1` | **PASS** |
| **Frontend Reconciliation** | `frontend/console/` current `develop` tree | Explicit `source`, date window, coverage, suppression labels; no fabricated conversion/intent | Verified `frontend/console/` contains only UI primitives (`Card`, `Nav`, `Button`, `Input`) with zero fabricated conversion/intent metrics | **PASS** |
| **DATA-06 Scope Guard** | Composite numeric score availability | Composite score remains disabled/unavailable until product-approved parameters are versioned | Confirmed disabled; only descriptive P0 `owner_report.v1` metrics are exposed | **PASS** |

---

## 2. Executed Verification Commands & Results

- `npx vitest run backend/src/owner-report.test.ts backend/src/owner-report.s6-hardening.test.ts`: **15/15 PASS** (12 baseline + 3 S6 hardening suites).
- `pnpm verify test:db`: **PASS** — 296 pgTAP assertions across 12 SQL suites + 130 real PostgreSQL integration tests across 9 suites (`dish`, `ingestion`, `consumer`, `order-ingestion`, `owner-menu`, `owner-synthetic`, `facts`, `comparison-report`, `bundle-producer`).

---

## 3. Sign-Off & Review Handoff

- **Independent Technical Review:** Requested from **Sai** and **Uneeza** (no self-approval applied).
- **Metric & Product Sign-Off:** Requested from **Vivien Kong** per S6 release-hardening criteria.
