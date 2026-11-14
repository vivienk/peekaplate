# PeekaPlate — Fresh Staging E2E Acceptance & Evidence Report (2026-11-14)

**Audit / Execution Timestamp:** `2026-11-14T20:22:39Z` (`2026-11-15T01:51–01:56+05:30`)  
**Overall Verdict:** **BLOCKED**  
**Provider Calls Consumed:** `0 / 2` (execution halted at baseline audit and contract-pinning gates; no synthetic menu ingested)  
**Target Environment:** Staging (`peekaplate-api-staging.vxkong.workers.dev`, `peekaplate-extraction-staging.vxkong.workers.dev`, Cloudflare Account `51eda1917fd22a9478808a82d2980741`)

---

## 1. Executive Summary

A fresh staging E2E acceptance run (`Input → Ingestion API → Validation → Extraction → Queue → Consumer → R2/Postgres → Observation/Draft`) **could not safely proceed** and is **BLOCKED** on four verified infrastructure, deployment, and access gates:

1. **PR #161 Contract Mismatch (Critical):** PR #161 (`385a19fb749f372e1759df04b50c10d4d6690424`, merged to `develop` on `2026-11-13T07:10:51Z`) is **not** in `origin/main` (`ed0f907`) and is **not deployed** to `peekaplate-api-staging`. Live probe of `POST /venues/.../drafts/.../verify` returned HTTP `404`, whereas `POST /venues/.../drafts/.../approve` (from PR #149 / `fad0eb0`) returned HTTP `401`.
2. **Cloudflare Staging Account Access Missing (Critical):** Local `wrangler` (`4.149.0`) is authenticated only to `d340f430beeecbc757837111d9ca7d1e` (`Teeyanshshukla@gmail.com's Account`), not the PeekaPlate staging account `51eda1917fd22a9478808a82d2980741` (`Authentication error [code: 10000]`). Worker version IDs, active bindings, AI provider secrets (`GEMINI_API_KEY` / `OPENROUTER_API_KEY`), and Queue/DLQ state (`peekaplate-staging-menu-ingestion`, `peekaplate-staging-menu-ingestion-dlq`) could not be audited or controlled.
3. **Extraction Worker Deployment Unverified (Critical):** `https://peekaplate-extraction-staging.vxkong.workers.dev/health` returned HTTP `401 {"error":"unauthorized"}` (service is up and enforcing auth), but GitHub Actions `deploy-extraction-staging.yml` has **no runs found**, and Cloudflare account access is unavailable. Current deployed extraction commit, container version, `vision_v4` config, and provider keys remain unverified.
4. **Staging DB & Test Identities Unavailable (High):** No staging Supabase/Postgres connection string or `supabase` CLI is available to verify migration `20261113010000_menu_verification_lifecycle.sql` (or `20261112010000`), and no staging staff bearer token or Restaurant A (owner) / Restaurant B (no access) / Viewer identities are provisioned.

Per execution discipline, **0 provider calls** were consumed, no queues were modified, and no staging deployments or permissions were altered.

---

## 2. Mandatory Deployment Baseline Audit

| Component | Expected / Historical Snapshot | Observed Current State | Verification Method | Status |
|---|---|---|---|---|
| **API Worker (`peekaplate-api-staging`)** | Historical Nov 12: `fad0eb0` / Worker `58034c48-e720-4d13-b5e4-28af5621b150` | `GET /health` → HTTP `200` `{"status":"ok","service":"peekaplate-api","stage":"foundation"}` (`x-request-id: c5abf3e3-03ed-48ee-8c75-132a5be9e36c`). Exact live commit & Worker version ID **unverified** (`wrangler deployments list` failed with `code: 10000`). `deploy-staging.yml` last ran `2026-10-27T20:20:50Z` (SHA `58838e1b`, run `40577213391`); `origin/main` is now `ed0f907`. | `curl`, `gh run list`, `wrangler deployments list` | **PARTIAL / UNVERIFIED VERSION** |
| **Extraction Worker (`peekaplate-extraction-staging`)** | Historical: `60b99488-78f3-4d6a-a497-2ff1597f1ab7` (or `e79ff95` `vision_v4`) | `GET /health` → HTTP `401` `{"error":"unauthorized"}`. `deploy-extraction-staging.yml` has **no runs found**. Active Worker version, container image, `vision_v4` flag, and `GEMINI_API_KEY`/`OPENROUTER_API_KEY` secrets **unverified**. | `curl`, `gh run list` | **BLOCKED / UNVERIFIED** |
| **Active Env Bindings & OCR/AI Config** | `backend/wrangler.jsonc` (`APP_ENV=staging`, `EXTRACTION_TIMEOUT_MS=720000`, `HYPERDRIVE`, `INGESTION_REPORTS_BUCKET`, `INGESTION_QUEUE`) & `backend/wrangler.extraction.jsonc` (`EXTRACTION_SOURCE_ORIGIN`, `SOURCE_BUCKET`, `EXTRACTOR`) | Checked-in Wrangler configs inspected. Live Cloudflare secrets/bindings cannot be read without account `51eda1917fd22a9478808a82d2980741` access. | Repo inspection, `wrangler` | **UNVERIFIED LIVE** |
| **Queue & DLQ State** | `peekaplate-staging-menu-ingestion` & `peekaplate-staging-menu-ingestion-dlq` paused; `peekaplate-staging-observations` paused | `wrangler queues info peekaplate-staging-menu-ingestion --env staging` failed with `Authentication error [code: 10000]`. Backlog depth and pause state **unverified**. | `wrangler queues info` | **BLOCKED / UNVERIFIED** |
| **Staging DB Migrations** | `20261112010000_owner_menu_workspace.sql` (Nov 12) + PR #161 `20261113010000_menu_verification_lifecycle.sql` | Cannot query staging Postgres (`supabase` CLI not installed; no staging DB URL in env). Because PR #161 is not on `main`, `20261113010000` is presumed unapplied unless manually applied. | Environment & repo check | **BLOCKED / UNVERIFIED** |
| **PR #161 Deployment Status** | Must be deployed for `contracts-newer` pinning | **NOT DEPLOYED.** Merged to `develop` (`385a19f`, `2026-11-13T07:10:51Z`), **not** an ancestor of `origin/main` (`ed0f907`). Live `POST /venues/.../drafts/.../verify` returns HTTP `404`. | `git merge-base`, `gh pr view 161`, `curl` | **FAIL (NOT DEPLOYED)** |

---

## 3. Contract Version Pinning (`contracts-newer` & PR #161)

### Inspected Sources
- `packages/contracts/package.json` (`@peekaplate/contracts`, `zod: 4.6.7`)
- PR #161 merge commit `385a19fb749f372e1759df04b50c10d4d6690424` (`feat/menu-verification-screens-8-9` → `develop`)
- `packages/contracts/src/owner-menu.ts` (PR #161 additions: `DishVerificationStatusSchema`, `PhotoVerificationStatusSchema`, `VerifyDishDraftSchema`, `ApproveDraftPhotoSchema`, `RejectDraftPhotoSchema`)
- `backend/src/owner-menu-routes.ts` (PR #161 routes: `POST /venues/:venueId/drafts/:draftId/verify`, `POST /venues/:venueId/drafts/:draftId/photos/:photoId/approve`, `POST /venues/:venueId/drafts/:draftId/photos/:photoId/reject`)
- `migrations/20261113010000_menu_verification_lifecycle.sql`
- `scripts/verify-ingestion-e2e.mjs` & `scripts/verify-ingestion-e2e.test.mjs` (6/6 local unit tests passed)

### Exact Contract Mismatch
- **Required by Acceptance Scope:** Deployed staging API and DB must reflect `contracts-newer` including PR #161 (`385a19f`).
- **Actual Staging State:**
  - `git merge-base --is-ancestor 385a19f origin/main` → **false** (`385a19f` is on `develop`, not `main`).
  - `POST https://peekaplate-api-staging.vxkong.workers.dev/venues/00000000-0000-4000-8000-000000000123/drafts/00000000-0000-4000-8000-000000000001/verify` → **HTTP 404** (route absent).
  - `POST https://peekaplate-api-staging.vxkong.workers.dev/venues/00000000-0000-4000-8000-000000000123/drafts/00000000-0000-4000-8000-000000000001/approve` → **HTTP 401** (PR #149 route present).

### Minimum Required Remediation
1. Promote PR #161 (`385a19f`, including `packages/contracts/src/owner-menu.ts`, `backend/src/owner-menu-routes.ts`, `backend/src/owner-menu.ts`, and `migrations/20261113010000_menu_verification_lifecycle.sql`) to `main` via reviewed PR.
2. Apply forward migration `20261113010000_menu_verification_lifecycle.sql` to staging Supabase and verify `peekaplate_runtime` column grants.
3. Deploy `peekaplate-api-staging` from the resulting `main` SHA via `.github/workflows/deploy-staging.yml` (or authorized operator `wrangler deploy --env staging`).
4. Deploy `peekaplate-extraction-staging` from `main` via `.github/workflows/deploy-extraction-staging.yml` with `expected_sha` and verify `vision_v4` + AI provider secrets.

---

## 4. Access, Authorization, and Execution Limits

- **Staff Identity & Synthetic Venue:** No staging staff JWT/session or synthetic Restaurant A / Restaurant B / Viewer test accounts are available in this environment. Only `SYNTHETIC_REPORT_VENUE_ID=00000000-0000-4000-8000-000000000123` is visible in `backend/wrangler.jsonc`.
- **Two-Call Provider Limit:** Enforced by halting prior to intake; **0** extraction/provider calls were triggered.
- **Queue Pause/Resume Controls:** Not exercisable without staging Cloudflare account access (`51eda1917fd22a9478808a82d2980741`).

---

## 5. Stage-by-Stage Test Results

| Stage / Check | Status | Details / Evidence |
|---|---|---|
| API Health (`GET /health`) | **PASS** | HTTP `200`, `{"status":"ok","service":"peekaplate-api","stage":"foundation"}` |
| Extraction Health (`GET /health`) | **BLOCKED** | HTTP `401` `{"error":"unauthorized"}` (alive, auth enforced; version/config unverified) |
| API Commit & Worker Version Audit | **BLOCKED** | `wrangler deployments list` failed: `Authentication error [code: 10000]` on account `51eda1917fd22a9478808a82d2980741` |
| Extraction Worker Version & Vision V4 / AI Keys | **BLOCKED** | No `deploy-extraction-staging.yml` runs found; no Cloudflare staging account access |
| Queue & DLQ State Audit | **BLOCKED** | `wrangler queues info` failed: `Authentication error [code: 10000]` |
| Staging DB Migration Audit | **BLOCKED** | No staging Postgres/Supabase access in environment |
| PR #161 Contract Pinning Verification | **FAIL** | `385a19f` not in `origin/main`; live `POST .../verify` returned HTTP `404` |
| Local Harness Unit Tests (`verify-ingestion-e2e.test.mjs`) | **PASS (Local Only)** | `6/6` tests passed (`node --test scripts/verify-ingestion-e2e.test.mjs`); does **not** establish staging acceptance |
| Owner / Unauthorized / Cross-Tenant Auth Tests | **NOT RUN (BLOCKED)** | Pending Restaurant A (owner), Restaurant B (no access), Viewer identities & fresh staff session |
| Menu Ingestion (URL / PDF / Photo) | **NOT RUN (BLOCKED)** | Halted on PR #161 mismatch, unverified extraction/AI keys, and paused/unverified queue |
| Queue Delivery, Consumer, R2, Postgres, Drafts, Observations | **NOT RUN (BLOCKED)** | Halted prior to intake |
| Retry, Duplicate, & DLQ Failure Handling | **NOT RUN (BLOCKED)** | Halted prior to intake |

---

## 6. Outstanding Blockers & Exact Next Actions

| Blocker | Owner | Missing Prerequisite | Exact Next Action |
|---|---|---|---|
| **B1: PR #161 not on `main` / staging** | Release / Backend Owner (Vivien / Sai) | `385a19f` merged only to `develop` | Promote PR #161 to `main`, apply `20261113010000_menu_verification_lifecycle.sql` to staging DB, and deploy `peekaplate-api-staging` from `main`. |
| **B2: Extraction Worker & AI keys unverified** | Staging / Infra Operator (Sai / Mohammad) | No `deploy-extraction-staging.yml` runs; no CF account `51eda1917fd22a9478808a82d2980741` access | Run `deploy-extraction-staging.yml` from `main` (or verify live Worker version), confirm `vision_v4` mode and `GEMINI_API_KEY`/`OPENROUTER_API_KEY` secrets. |
| **B3: Queue / DLQ inspection & window** | Staging Operator (Sai) | Wrangler lacks `51eda1917fd22a9478808a82d2980741` access | Inspect `peekaplate-staging-menu-ingestion` and `-dlq` backlog, unpause only `peekaplate-staging-menu-ingestion` for the bounded 30-min window, and re-pause immediately after. |
| **B4: Test identities & staff session** | Staging Operator (Sai) + Teeyansh | No Restaurant A/B/Viewer grants or staff token | Grant temporary `owner` on synthetic Restaurant A, confirm `403` on Restaurant B and `viewer` identity, and sign in via secret-safe staff session. |

---

## 7. Cleanup & Safety Confirmation

- **Ingestion:** No ingestion jobs, uploads, or URL intakes were submitted.
- **Provider Calls:** `0` provider calls consumed.
- **Queues & DLQ:** No queue pause/resume state was modified; staging queues remain in their pre-audit operator-controlled state.
- **Permissions:** No user memberships or roles were modified.
- **Repository:** No application, contract, or deployment configuration files were modified.

---

## 8. Sanitized Execution Evidence

- **API Health Probe:** `GET https://peekaplate-api-staging.vxkong.workers.dev/health` → `HTTP/2 200`, `x-request-id: c5abf3e3-03ed-48ee-8c75-132a5be9e36c`, `cf-ray: a5a8bac1996354c0-DEL`
- **Extraction Health Probe:** `GET https://peekaplate-extraction-staging.vxkong.workers.dev/health` → `HTTP/2 401`, `cf-ray: a5a8baf75d0154c0-DEL`
- **PR #161 Route Probe:**
  - `POST https://peekaplate-api-staging.vxkong.workers.dev/venues/00000000-0000-4000-8000-000000000123/drafts/00000000-0000-4000-8000-000000000001/verify` → `HTTP 404`
  - `POST https://peekaplate-api-staging.vxkong.workers.dev/venues/00000000-0000-4000-8000-000000000123/drafts/00000000-0000-4000-8000-000000000001/approve` → `HTTP 401`
- **GitHub Actions:**
  - `deploy-staging.yml` latest run: `40577213391` (`2026-10-27T20:20:50Z`, `headSha: 58838e1b17321685d3b0869484b9a68437eea564`, `success`)
  - `deploy-extraction-staging.yml`: `no runs found`
- **Wrangler CLI:** `4.149.0`, authenticated account `d340f430beeecbc757837111d9ca7d1e`; target staging account `51eda1917fd22a9478808a82d2980741` returned `Authentication error [code: 10000]`.
- **Local Harness Unit Tests:** `node --test scripts/verify-ingestion-e2e.test.mjs` → `6 passed, 0 failed` (expanded to `9 passed, 0 failed` after Phase 5 harness updates).

---

## 9. FE-06.4 Blocker Resolution & Deployment Readiness

**Readiness Classification:** **PARTIALLY READY** (repository contracts, build, and E2E verification harness are **PASS** locally; hosted staging execution remains **BLOCKED** on operator-controlled promotion, deployment, migration, queue, and identity actions).

### 9.1 Phase 1–2 Validation Summary

| Item | Status | Observed Evidence |
|---|---|---|
| **GitHub `main` vs `develop` State** | **FAIL (Skew Remains)** | `origin/main` remains `ed0f907308b4cda71287ec7f2bc1d2be248cfdbb` (PR #177). `origin/develop` advanced to `870bcd3111edd813772a18d13d76b6f0cece373b` (PR #179). No open release PR targeting `main` exists for PR #161 (`385a19f`). |
| **PR #161 Contract & Route Exports** | **PASS (Repo)** | `packages/contracts/src/owner-menu.ts` exports `DishVerificationStatusSchema`, `PhotoVerificationStatusSchema`, `VerifyDishDraftSchema`, `ApproveDraftPhotoSchema`, `RejectDraftPhotoSchema`; re-exported via `packages/contracts/src/index.ts`. `backend/src/owner-menu-routes.ts` registers `/verify` and `/photos/:photoId/{approve,reject}`. |
| **Migration Compatibility & Ordering** | **PASS (Compatible)** | `migrations/20261113010000_menu_verification_lifecycle.sql` alters only `app_private.dish_drafts` and `app_private.dish_draft_photo` (from `20261112010000`) and has no dependency on `20261107`–`20261109` or conflict with `20261114010000_restaurant_menu_links.sql` on `main`. |
| **TypeScript, Tests, Lint & Worker Build** | **PASS (Local)** | `tsc --noEmit` on `packages/contracts` and `backend` (`0` errors); `vitest run` on `owner-menu.test.ts` (`3/3`), `owner-menu-retention.test.ts` (`7/7`), `orchestrator.test.ts` (`18/18`), `intake.test.ts` (`2/2`); `wrangler deploy --env staging --dry-run --outdir dist` succeeded (`HOME=/tmp`). |
| **E2E Harness Readiness (`verify-ingestion-e2e.mjs`)** | **PASS (Local)** | Added `MAX_PROVIDER_CALLS = 2` (`createProviderCallGuard`), `assertSyntheticInput`, PR #161 `/verify` + `verification_status` checks (`--require-pr161`), cross-tenant/viewer `403` checks, `x-request-id` capture, and `sanitizeEvidence` (`--evidence-out`). `9/9` unit tests and `biome check` pass. |

### 9.2 Resolved vs. Remaining Blockers

1. **Resolved (Repository / Harness):**
   - Verified PR #161 contract exports, route registrations, migration compatibility, TypeScript compilation, Worker dry-run bundle, and unit tests.
   - Closed all harness gaps in `scripts/verify-ingestion-e2e.mjs` (hard 2-call provider cap, synthetic input guard, PR #161 checks, tenant-isolation checks, request ID capture, and sanitized evidence export).
2. **Remaining Blockers (External / Operator-Controlled):**
   - **B1 (`FAIL` / Operator Action):** PR #161 (`385a19f`) is not promoted to `main` or deployed to `peekaplate-api-staging` (`POST .../verify` returns `404`).
   - **B2 (`BLOCKED` / Operator Action):** Extraction Worker (`peekaplate-extraction-staging`) version, `vision_v4` flag, and `GEMINI_API_KEY` / `OPENROUTER_API_KEY` secrets cannot be verified without Cloudflare account `51eda1917fd22a9478808a82d2980741` access.
   - **B3 (`BLOCKED` / Operator Action):** Staging DB migration `20261113010000_menu_verification_lifecycle.sql` is unverified in staging Postgres.
   - **B4 (`BLOCKED` / Operator Action):** `peekaplate-staging-menu-ingestion` and `-dlq` state cannot be inspected or unpaused/re-paused without Cloudflare account `51eda1917fd22a9478808a82d2980741` access.
   - **B5 (`BLOCKED` / Operator + Staff Action):** Staging staff user ID, temporary `owner` grant on synthetic Restaurant A, non-member Restaurant B (`403`), and `viewer` identity (`403`) are not yet provisioned.

### 9.3 Repository Changes

- `scripts/verify-ingestion-e2e.mjs` — Added `MAX_PROVIDER_CALLS` (`2`), `createProviderCallGuard`, `assertSyntheticInput`, `sanitizeEvidence`, `--require-pr161`, `--cross-tenant-venue-id`, `--viewer-token`, `--max-provider-calls`, `--evidence-out`, `x-request-id` capture, and `source_hash` validation.
- `scripts/verify-ingestion-e2e.test.mjs` — Added 3 unit tests covering the 2-call provider budget guard, synthetic input guard, PR #161 checks, cross-tenant/viewer `403` checks, request IDs, and secret redaction (`9/9` passing).
- `docs/staging-e2e-acceptance-2026-11-14.md` — Recorded baseline audit and Phase 1–6 readiness coordination.

### 9.4 Exact Operator Deployment & Verification Sequence

1. **Branch Promotion (Vivien / Sai):**
   - Open and merge a reviewed PR promoting PR #161 (`385a19f` / `packages/contracts/src/owner-menu.ts`, `backend/src/owner-menu*.ts`, `migrations/20261113010000_menu_verification_lifecycle.sql`) into `main`. Record the resulting `main` SHA (`<MAIN_SHA>`).
2. **E. Staging Database Migration (Sai):**
   - Verify applied migrations in staging Supabase (`schema_migrations`), apply `migrations/20261113010000_menu_verification_lifecycle.sql`, and confirm `app_private.dish_drafts.verification_status`, `app_private.dish_draft_photo.verification_status`, and `peekaplate_runtime` column `UPDATE` grants.
3. **B/C/D. Extraction Worker, Vision V4 & AI Provider Secrets (Sai / Mohammad):**
   - Confirm `GEMINI_API_KEY` (or `OPENROUTER_API_KEY`) and `EXTRACTION_SERVICE_SECRET` are set on `peekaplate-extraction-staging` (do not print values).
   - Trigger GitHub Actions `.github/workflows/deploy-extraction-staging.yml` with `expected_sha=<MAIN_SHA>` (runs `wrangler deploy --config wrangler.extraction.jsonc` under `CLOUDFLARE_ACCOUNT_ID=51eda1917fd22a9478808a82d2980741`).
   - Verify `wrangler deployments list --name peekaplate-extraction-staging` shows `<MAIN_SHA>` and `vision_v4` container active.
4. **A. API Worker Deployment (Sai):**
   - Trigger GitHub Actions `.github/workflows/deploy-staging.yml` on `main` (runs `pnpm check`, `pnpm build`, and `wrangler deploy --env staging`).
   - Verify `GET https://peekaplate-api-staging.vxkong.workers.dev/health` → `200` and `POST .../drafts/.../verify` → `401` (not `404`).
5. **F. Menu Queue & DLQ Readiness (Sai):**
   - Run `CLOUDFLARE_ACCOUNT_ID=51eda1917fd22a9478808a82d2980741 pnpm --filter @peekaplate/backend exec wrangler queues info peekaplate-staging-menu-ingestion --env staging` and `-dlq` to confirm `0` unintended backlog and paused state before the window.
   - Keep `peekaplate-staging-observations` paused; unpause **only** `peekaplate-staging-menu-ingestion` for the bounded 30-minute test window.

### 9.5 Access Readiness & E2E Execution Prerequisites

- **Access Requirements (Sai + Teeyansh):**
  - Confirm Teeyansh's staging staff `user_id` (UUID only, no credentials).
  - Grant temporary `owner` membership on synthetic **Restaurant A**; confirm **no** membership on synthetic **Restaurant B** (expect `403`); confirm a `viewer` identity on Restaurant A (expect `403` on writes).
  - Sign in via the approved secret-safe method to obtain ephemeral bearer tokens in memory only.
- **Bounded Execution Command (after queue unpause):**
  - Submit **1** synthetic menu (`<= 2` provider calls total, no automatic retries), then run:
    ```bash
    node scripts/verify-ingestion-e2e.mjs \
      --job-id <JOB_UUID> \
      --venue-id <RESTAURANT_A_UUID> \
      --cross-tenant-venue-id <RESTAURANT_B_UUID> \
      --token "$STAFF_JWT" \
      --viewer-token "$VIEWER_JWT" \
      --require-pr161 \
      --max-provider-calls 2 \
      --evidence-out docs/evidence/staging-e2e-2026-11-14.json
    ```

### 9.6 Rollback & Cleanup Instructions

1. Immediately re-pause `peekaplate-staging-menu-ingestion` (and confirm `peekaplate-staging-menu-ingestion-dlq` and `peekaplate-staging-observations` remain paused).
2. Remove the temporary `owner` grant on Restaurant A for Teeyansh's staging staff user ID and verify `403` is restored.
3. End temporary staff sessions and do not commit any tokens or raw provider payloads.
4. If the promoted `main` API/extraction deployment exhibits regressions, roll back via `wrangler rollback --env staging` (or re-deploy the prior verified `main` SHA `fad0eb0`) while keeping queues paused.

