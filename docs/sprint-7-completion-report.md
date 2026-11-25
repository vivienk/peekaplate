# Sprint 7 — Combined Completion & Readiness Report

- **Date:** November 25, 2026
- **Scope:** `S7-DATA-17`, `S7-DATA-18`, `S7-RES-09`
- **Individual Reports:**
  - [s7-data-17-reconciliation-report.md](s7-data-17-reconciliation-report.md)
  - [s7-data-18-hosted-acceptance-report.md](s7-data-18-hosted-acceptance-report.md)
  - [s7-res-09-acceptance-report.md](s7-res-09-acceptance-report.md)

---

## 1. Final Status Table

| Ticket | PRs | CI | Review | Merge | Deployment | Hosted acceptance | Remaining dependencies & owners | Status |
|---|---|---|---|---|---|---|---|---|
| DATA-17 | #261 (`d7a3bc6d`), #263 (`20ae4cdb`) | PASS | PENDING (`0` approvals; `@hemu77`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN | PARTIAL (Supabase `icwhkrlsecpzcomfjsso` & PostHog `675372` Batch B reconciled 1-to-1) | **Reviewers** (`@hemu77`, `@vivienk`), **Harshita** (14-visit arithmetic), **Sai** (prod DB project & watermark-deferral confirmation) | **PENDING** |
| DATA-18 | #264 (`e00a039a`) | PASS | PENDING (`0` approvals; `@hemu77`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN | BLOCKED (`00000000-...-0123` has `0` published menus/`0` drafts; console auth disabled; missing `menuToken`) | **Reviewers** (`@hemu77`, `@vivienk`), **Sai** (publish menu/dish on `...0123`, `menuToken`, owner JWT, UTC window/cap, ClickUp scope), **Harshita** (2nd-tester repro) | **BLOCKED** |
| RES-09 | #266 (`8f89bbab`) | PASS | PENDING (`0` approvals; `@hemu77`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN (`deploy-staging.yml` requires `main` + `STAGING_DEPLOYMENT_APPROVED=true`) | NOT RUN | **Reviewers** (`@hemu77`, `@vivienk`), **Sai** (`main` promotion, `deploy-staging.yml` approval/dispatch & staging console auth) | **PENDING** |

---

## 2. Cross-Ticket Integration & Merge Order

- **Data Isolation Verified:** `DATA-17` production reports read `app_private.owner_observation_v1` (excluding `test`/`demo`), while `DATA-18` synthetic staging checks read `app_private.owner_test_observation_v1` (`source=synthetic`, allowlisted to `00000000-0000-4000-8000-000000000123`). `RES-09` review gates protect publication across all venues.
- **Recommended Merge Order:**
  1. Merge **#261** and **#264** in any order (zero file overlap with any other Sprint 7 PR).
  2. Merge **#266** (`8f89bbab`) or **#263** (`20ae4cdb`) next.
  3. Whichever of **#263** / **#266** merges last will need a quick `docs/CONTEXT.md` rebase/refresh.

---

## 3. Consolidated External Requests

### For Sai
1. **DATA-17:** Confirm whether `icwhkrlsecpzcomfjsso` is the sole authoritative Supabase project (where Batch B `2026-11-23T17:45–17:50Z` belongs to `29363367-eb65-48bb-81bd-fb25e6407f43`), and confirm deferring `app_private.ingestion_watermark` out of S7-DATA-17 while fail-closed `is_stale: null` remains active.
2. **DATA-18:** Provision/publish a non-demo menu & dish on `00000000-0000-4000-8000-000000000123` (or enable staging console auth), and provide `publication_id`, `dish_id`, `dish_revision_id`, `menuToken`, staging owner JWT, approved UTC window + `--event-cap`, and ClickUp `"Define synthetic dashboard data scope and remove unresolved order placeholder"` confirmation.
3. **PRs & RES-09 Staging:** Review/merge PRs #261, #263, #264, #266, and deploy staging for RES-09 hosted verification.

### For Harshita
1. **DATA-17:** Confirm the 14-visit arithmetic in `docs/s7-data-17-metric-acceptance.md` (PR #261).
2. **DATA-18:** Execute second-tester reproduction once Sai provides the `00000000-...-0123` staging resources.
