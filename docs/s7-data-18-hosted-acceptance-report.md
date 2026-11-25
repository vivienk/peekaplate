# S7-DATA-18 — Hosted Acceptance & Readiness Report

- **Date:** November 25, 2026
- **Ticket:** S7-DATA-18
- **PR:** [#264](https://github.com/vivienk/peekaplate/pull/264) (`e00a039a`)
- **Existing Artifacts Reused:** `docs/s7-data-18-staging-acceptance.md`, `docs/s7-data-18-staging-runbook.md` (PR #264)
- **Final Status:** **BLOCKED ON EXTERNAL STAGING RESOURCES** (Offline implementation, deterministic manifests, and dry-run/replay **PASS**; live staging `--send` **BLOCKED** on missing published menu/dish/token for `00000000-0000-4000-8000-000000000123`, disabled console auth, and ClickUp scope confirmation)

---

## 1. Local & Dry-Run Verification

- `pytest test-data/owner-synthetic-p0-v2/tests/test_staging_activity.py -v`: **PASS** (`9/9`).
- `vitest run backend/src/synthetic-staging-activity.test.ts`: **PASS** (`3/3`).
- `generate_staging_activity.py --dry-run` & `--replay ... --dry-run` (zero hosted writes):
  - **Scenario A:** `55` events / `3` batches, `manifest_sha256 = acca7cd7350b7cc6e1baa99b9bcb571c76e568b4e4af91a85ea0c6de0701a91b` (`active_sessions: 14`, `open_rate: 0.714`, `timing_coverage: 0.909`, `avg_interaction_time_seconds: 12.0`, `save_rate: 0.214`, `engagement_rate: 1.0`).
  - **Scenario B:** `40` events / `2` batches, `manifest_sha256 = 1729e9f159b1ffbe9589dfc1a202c9b32446ccfe9682f4ae53b446f3b38ba7b7` (`active_sessions: 10`, `open_rate: 1.0`, `timing_coverage: 1.0`, `avg_interaction_time_seconds: 8.0`, `save_rate: 0` `VALID_ZERO`, `engagement_rate: 0` `VALID_ZERO`).

---

## 2. Live Staging Infrastructure & Supabase (`icwhkrlsecpzcomfjsso`) Evidence

- **Cloudflare Staging (`2026-11-25`):** `peekaplate-api-staging` (`/health` → `200 OK`, deployment `7f2833bb`), queues `peekaplate-staging-observations` + DLQ, R2 `peekaplate-staging-assets`, and `MENU_TOKEN_SIGNING_JWK` are operational. `peekaplate-console-staging.pages.dev` has auth/publication disabled.
- **Supabase `00000000-0000-4000-8000-000000000123` (`2026-11-25T11:01Z` & `12:44Z`):**
  - `app_private.menu_publication_current`: **0 rows** (no published menu).
  - `app_private.dish_current`: **3 rows** (`Synthetic DATA01 9/10/11-session cohort`, `2026-11-16`).
  - `app_private.dish_drafts`: **0 rows**; `menu_review_subject`: **0 rows**; `menu_approval`: **0 rows**.
  - `app_private.staff_membership`: **1** row; `app_private.observation_index`: **90** rows.
- **PostHog Staging (`675372`):** Historical `staging` events (`Nov 16–20`) had `has_venue_id = 0` and `has_pub_rev_id = 0`; canonical owner metrics read Supabase `app_private.owner_test_observation_v1` (`source=synthetic` allowlisted to `00000000-...-0123`).

---

## 3. Remaining External Blockers

1. **PR #264** review approval and merge to `develop`.
2. **Sai:** Provision/publish a non-demo menu & dish on `00000000-0000-4000-8000-000000000123` (or enable staging console auth), and supply `publication_id`, `dish_id`, `dish_revision_id`, `menuToken`, staging owner JWT, approved UTC window + `--event-cap`, and ClickUp `"Define synthetic dashboard data scope and remove unresolved order placeholder"` confirmation.
3. **Harshita:** Second-tester deterministic reproduction and live verification once staging resources are provided.
