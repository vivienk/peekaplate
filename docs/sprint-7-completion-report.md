# Sprint 7 — Combined Completion & Readiness Report

- **Date:** November 25, 2026
- **Scope:** `S7-DATA-17`, `S7-DATA-18`, `S7-RES-09`
- **Individual Reports:**
  - [s7-data-17-reconciliation-report.md](s7-data-17-reconciliation-report.md)
  - [s7-data-18-hosted-acceptance-report.md](s7-data-18-hosted-acceptance-report.md)
  - [s7-res-09-acceptance-report.md](s7-res-09-acceptance-report.md)

---

## 1. Recorded status on November 25

CI and review columns describe the listed PR snapshots. Hosted results and release approval are recorded separately.

| Ticket | PRs | CI | Review | Merge | Deployment | Hosted acceptance | Remaining dependencies & owners | Ticket closure |
|---|---|---|---|---|---|---|---|---|
| DATA-17 | #261 (`d7a3bc6d`), #263 (`20ae4cdb`) | PASS | PENDING (`0` approvals; `Sai (@hemu77)`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN | PARTIAL: counts agreed for Batch B in the queried projects. Production bindings and event-level reconciliation are pending. | **Reviewers** (`Sai (@hemu77)`, `@vivienk`), **Harshita** (14-visit arithmetic), **Sai** (production bindings, venue and watermark-deferral confirmation) | **PENDING** |
| DATA-18 | #264 (`e00a039a`) | PASS | PENDING (`0` approvals; `Sai (@hemu77)`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN | BLOCKED (Meta staging freeze, test-class venue access and published fixtures pending) | **Reviewers** (`Sai (@hemu77)`, `@vivienk`), **Sai** (authorize a test-class venue and published fixture, provision `menuToken` and owner session, UTC window/cap, ClickUp scope), **Harshita** (2nd-tester repro) | **BLOCKED** |
| RES-09 | #266 (`8f89bbab`) | PASS | PENDING (`0` approvals; `Sai (@hemu77)`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | NOT RUN (Meta staging frozen) | NOT RUN | **Reviewers** (`Sai (@hemu77)`, `@vivienk`), **Sai** (staging authorization after thaw, exact `main` candidate and console auth) | **PENDING** |
| Sprint 7 Docs | #273 (`docs/sprint-7-closure-reports`) | PASS (5/5, 5 skipped) | PENDING (`0` approvals; `Sai (@hemu77)`, `@vivienk`) | PENDING (`MERGEABLE`/`CLEAN`) | N/A | N/A | **Reviewers** (`Sai (@hemu77)`, `@vivienk`) | **PENDING** |

---

## 2. Cross-Ticket Integration & Merge Order

- **Code paths:** `DATA-17` uses `app_private.owner_observation_v1` with production provenance and publication checks. `DATA-18` live validation targets the two test-class venues in the backend allowlist. Their synthetic owner reports use `app_private.owner_test_observation_v1`. The legacy `…0123` fixture remains for dry runs. `RES-09` exercises the owner review gate in local tests. Hosted isolation and behavior require checks against the authorized deployment.
- **Recommended Merge Order:**
  1. Merge **#261** and **#264** in any order (zero file overlap with any other Sprint 7 PR).
  2. Merge **#266** (`8f89bbab`) or **#263** (`20ae4cdb`) next.
  3. Whichever of **#263** / **#266** merges last will need a quick `docs/CONTEXT.md` rebase/refresh.
  4. Merge **#273** (`docs/sprint-7-closure-reports`) after updating final merge SHAs if needed.

---

## 3. Consolidated External Requests

### For Sai
1. **DATA-17:** Confirm the authorized production Supabase and PostHog bindings and Batch A/B venue. Confirm whether to defer the watermark while production freshness remains `is_stale: null`.
2. **DATA-18:** Confirm the ClickUp scope and authorize a test-class venue, published menu and staging access after the [Meta freeze](production-release.md) is lifted. Approve the UTC window and event cap before live verification.
3. **RES-09:** Review #266. Once staging changes are authorized after the freeze, use the exact reviewed `main` commit and the manual staging workflow under [ADR 0012](adr/0012-main-environment-promotion.md). Record the deployed commit and provider deployment ID.

### For Harshita
1. **DATA-17:** Confirm the 14-visit arithmetic in `docs/s7-data-17-metric-acceptance.md` (PR #261).
2. **DATA-18:** Execute second-tester reproduction once Sai confirms the test-class venue and approves staging access.
