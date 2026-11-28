# S7-DATA-18 — Hosted Acceptance & Readiness Report

- **Date:** November 25, 2026
- **Ticket:** S7-DATA-18
- **PR:** [#264](https://github.com/vivienk/peekaplate/pull/264) (`e00a039a`)
- **Existing Artifacts Reused:** The staging runbook and the checked-in A/B dry-run manifests in [PR #264](https://github.com/vivienk/peekaplate/pull/264).
- **Status on November 25:** **HOSTED ACCEPTANCE BLOCKED**. The author recorded local test and dry-run results. Live `--send` remains pending while Meta staging is frozen and an approved test-class venue, published test menu and staging access are unavailable.

---

## 1. Local & Dry-Run Verification

- `pytest test-data/owner-synthetic-p0-v2/tests/test_staging_activity.py -v`: **PASS** (`9/9`).
- `vitest run backend/src/synthetic-staging-activity.test.ts`: **PASS** (`3/3`).
- The author recorded `generate_staging_activity.py --dry-run` and `--replay ... --dry-run` results with zero hosted writes. At [PR #264 `e00a039a`](https://github.com/vivienk/peekaplate/tree/e00a039a/test-data/owner-synthetic-p0-v2/manifests), the checked-in A/B manifests contain the input tuples and hashes below. Both use placeholder inputs and carry `DRY_RUN_UNVERIFIED`.
  - **Scenario A:** `55` events / `3` batches, `manifest_sha256 = ab5832c90797b78eb8cb41753e267de993499a1f500e55c56c246217b6e2c2d3` (`active_sessions: 14`, `open_rate: 0.714`, `timing_coverage: 0.909`, `avg_interaction_time_seconds: 12.0`, `save_rate: 0.214`, `engagement_rate: 1.0`).
  - **Scenario B:** `40` events / `2` batches, `manifest_sha256 = 6e7f344004e7f674c72d795e31166814ee9add470fec136bbe51e673a031357e` (`active_sessions: 10`, `open_rate: 1.0`, `timing_coverage: 1.0`, `avg_interaction_time_seconds: 8.0`, `save_rate: 0` `VALID_ZERO`, `engagement_rate: 0` `VALID_ZERO`).

The author also recorded A/B hashes `acca7cd7350b7cc6e1baa99b9bcb571c76e568b4e4af91a85ea0c6de0701a91b` and `1729e9f159b1ffbe9589dfc1a202c9b32446ccfe9682f4ae53b446f3b38ba7b7`. Reproducing those hashes requires the original manifests or their exact input tuples and generator revision, which this report does not have. Second-tester reproduction is pending.

---

## 2. Recorded staging infrastructure observations

- **Cloudflare staging (`2026-11-25`):** `/health` on `peekaplate-api-staging` returned `200 OK` on deployment `7f2833bb`. The author recorded Queue/DLQ, R2 and the `MENU_TOKEN_SIGNING_JWK` binding as present. The staging console had auth/publication disabled. This inspection leaves authenticated intake, Queue persistence and owner report delivery unverified.
- **Supabase `icwhkrlsecpzcomfjsso`, venue `00000000-0000-4000-8000-000000000123` (`2026-11-25T11:01Z` and `12:44Z`):**
  - `app_private.menu_publication_current`: **0 rows** (no published menu).
  - `app_private.dish_current`: **3 rows** (`Synthetic DATA01 9/10/11-session cohort`, `2026-11-16`).
  - `app_private.dish_drafts`: **0 rows**; `menu_review_subject`: **0 rows**; `menu_approval`: **0 rows**.
  - `app_private.staff_membership`: **1** row; `app_private.observation_index`: **90** rows.
- **PostHog staging (`675372`):** Historical `staging` events (`Nov 16–20`) had `has_venue_id = 0` and `has_pub_rev_id = 0`.
- **Venue scope:** The inspected `…0123` venue is the legacy synthetic report venue and reads the live-traffic view. The revised #264 live sender targets only the two test-class venue IDs in the backend allowlist. Their synthetic owner reports read `app_private.owner_test_observation_v1`. The `…0123` manifests are dry-run fixtures. The hosted test-class venue configuration and report access still need verification.

---

## 3. Remaining External Blockers

1. **PR #264** review approval and merge to `develop`.
2. **Sai:** Confirm the ClickUp scope (`Define synthetic dashboard data scope and remove unresolved order placeholder`). After the [Meta freeze](production-release.md) is lifted, authorize and configure one of the two test-class venues for the run. Publish a test menu and dish there, then confirm the publication/dish identifiers, UTC window and `--event-cap`. Provision the staging menu token and owner session through the approved access path.
3. **Harshita:** Reproduce the exact manifests independently. Run hosted verification once staging changes, resources and the test window are approved.
