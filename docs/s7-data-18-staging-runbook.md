# S7-DATA-18 — Controlled Staging Acceptance Runbook

> [!CAUTION]
> **Production is permanently blocked** by `generate_staging_activity.py` (`PRODUCTION_ORIGINS = {"https://api.peekaplate.app"}`) and placeholder UUIDs (`PLACEHOLDER_UUIDS`) are rejected on `--send`. Do **not** unpause queues, generate live staging events, trigger provider calls, or publish menus without explicit operator sign-off from **Sai**.

---

## 1. Mandatory Operator Prerequisites (Sai Sign-Off Required)

Before running any live staging command, the operator must explicitly confirm and supply:

| Parameter / Gate | Requirement | Placeholder / Default Allowed? |
|---|---|---|
| **Staging unfreeze approval** | Explicit confirmation from Sai that staging is unfrozen for DATA-18 | **No** |
| **Staging queue status** | `peekaplate-staging-observations` active and DLQ clear | **No** |
| **Authorized staging API origin** | `https://peekaplate-api-staging.vxkong.workers.dev` | Staging only (`api.peekaplate.app` blocked) |
| **Real staging venue UUID** | Non-placeholder authorized staging venue UUID (`--venue-id`) | **No** (`00000000-...-0123` blocked on `--send`) |
| **Current publication ID** | Active `menu.published` revision (`--publication-id` & `--current-publication-id`) | **No** |
| **Eligible dish ID & revision** | Newly published, non-demo dish (`--dish-id`, `--dish-revision-id`) | **No** |
| **Valid staging menu token** | ES256 `menuToken` for the authorized staging publication (`--menu-token`) | **No** (never commit or log) |
| **Approved UTC window** | Half-open `[window_start, window_end)` within 24h ingestion limit | **No** |
| **Approved event cap** | `--event-cap` (`>= 55` for Scenario A, `>= 40` for Scenario B) | **No** |

---

## 2. Step-by-Step Staging Execution Procedure

### Step 1: Preflight Verification (Offline)
```sh
pytest test-data/owner-synthetic-p0-v2/tests/test_staging_activity.py -q
npx vitest run backend/src/synthetic-staging-activity.test.ts
```

### Step 2: Generate & Inspect Approved Staging Manifest (Dry-Run First)
Replace `<...>` with the Sai-approved real staging values:
```sh
python3 test-data/owner-synthetic-p0-v2/generate_staging_activity.py \
  --scenario A \
  --venue-id "<REAL_STAGING_VENUE_UUID>" \
  --authorized-venue-id "<REAL_STAGING_VENUE_UUID>" \
  --publication-id "<CURRENT_PUBLICATION_UUID>" \
  --current-publication-id "<CURRENT_PUBLICATION_UUID>" \
  --dish-id "<NON_DEMO_DISH_UUID>" \
  --dish-revision-id "<NON_DEMO_DISH_REVISION_UUID>" \
  --seed "s7-data-18-staging-a-$(date -u +%Y%m%d)" \
  --window-start "<UTC_START_ISO>" \
  --window-end "<UTC_END_ISO>" \
  --event-cap 100 \
  --api-base-url "https://peekaplate-api-staging.vxkong.workers.dev" \
  --output /tmp/data18-scenario-a.manifest.json
```
Verify `authorization_status` is `"DRY_RUN_UNVERIFIED"` (dry-run) and confirm `event_count == 55`, `expected_metrics`, `input_sha256`, `output_sha256`, and `manifest_sha256`.

### Step 3: Controlled Live Staging Delivery (`--send --confirm-staging`)
Only after Sai's explicit approval and queue readiness confirmation:
```sh
python3 test-data/owner-synthetic-p0-v2/generate_staging_activity.py \
  --scenario A \
  --venue-id "<REAL_STAGING_VENUE_UUID>" \
  --authorized-venue-id "<REAL_STAGING_VENUE_UUID>" \
  --publication-id "<CURRENT_PUBLICATION_UUID>" \
  --current-publication-id "<CURRENT_PUBLICATION_UUID>" \
  --dish-id "<NON_DEMO_DISH_UUID>" \
  --dish-revision-id "<NON_DEMO_DISH_REVISION_UUID>" \
  --seed "s7-data-18-staging-a-$(date -u +%Y%m%d)" \
  --window-start "<UTC_START_ISO>" \
  --window-end "<UTC_END_ISO>" \
  --event-cap 100 \
  --api-base-url "https://peekaplate-api-staging.vxkong.workers.dev" \
  --output /tmp/data18-scenario-a.live.json \
  --send --confirm-staging --menu-token "<REDACTED_MENU_TOKEN>"
```
Repeat with `--scenario B` (`40` events, `10` sessions) using a distinct seed and approved window/dish.

### Step 4: Replay Idempotency Verification (`--replay`)
```sh
python3 test-data/owner-synthetic-p0-v2/generate_staging_activity.py \
  --replay /tmp/data18-scenario-a.live.json \
  --authorized-venue-id "<REAL_STAGING_VENUE_UUID>" \
  --send --confirm-staging --menu-token "<REDACTED_MENU_TOKEN>"
```
Verify all receipts return `duplicate_same_payload` (or idempotent acceptance) and re-query `GET /api/v1/venues/<REAL_STAGING_VENUE_UUID>/analytics/dishes?source=synthetic` to confirm zero metric inflation.

### Step 5: Independent Second-Tester Reproduction (Harshita)
Provide Harshita with the exact `(scenario, venue_id, publication_id, dish_id, dish_revision_id, window_start, window_end, seed)` tuple so she independently reproduces the identical `input_sha256`, `output_sha256`, and `manifest_sha256`.

---

## 3. Cleanup & Rollback Procedure

1. **Before run:** Record baseline counts in `app_private.observation_index` and `app_private.owner_observation_v1` for `<REAL_STAGING_VENUE_UUID>`.
2. **After acceptance:** Archive the signed manifest JSONs (with `--menu-token` never written to disk) and remove run-scoped synthetic test rows from staging `app_private.observation_*` tables / R2 prefix `raw/observations/<REAL_STAGING_VENUE_UUID>/` using the authorized staging database cleanup procedure, OR leave isolated in the dedicated disposable staging test venue if Sai prefers.
3. **Rollback on unexpected error:**
   - Stop any further `--send` calls immediately.
   - Do **not** alter production queues or R2 buckets.
   - Inspect `peekaplate-staging-observations-dlq` and `app_private.observation_index` (`disposition != 'accepted'`) for the run's `event_ids`.
   - Record the incident in `errors.md` (sanitized, zero tokens or PII).
