# S7-VIS-06 Slice 3 Design: Production-Safe Async 3D Flow (2026-11-24)

On 2026-11-24 the recommended design is a **Postgres-backed state machine in the API Worker** paired with **stateless, single-step Python container endpoints** behind `extraction-host.ts`, writing validated GLBs and reports to private R2. It covers owner **Generate 3D**, **status**, and **private GLB + validation preview** only; approval and publication wait on Marwan's versioned `PortionModel v1` contract.

References below cite `develop` (`5b87c8a4`) for backend/infra files and `feat/s7-vis-06-glb-postprocess` (`01d227b5`) for Slices 1–2 processing files.

---

## 1. Why the Local Model Service Cannot Ship to Production

`model_service.py` (`:85-90,146-165`) stores job state on local disk (`$TRIPO_REVIEW_ROOT/$TRIPO_TENANT_ID/jobs/<job_id>/`) and polls providers in a FastAPI `BackgroundTasks` thread. In Cloudflare Containers, `ExtractionContainer` sets a 60 s inactivity timeout (`backend/src/extraction-host.ts:74,91`) and ephemeral `/tmp` storage. A container sleep or restart loses job state, breaks polling, and risks duplicate provider billing.

---

## 2. Job State & Idempotency: Existing Postgres (`app_private.portion_3d_jobs`)

**Recommendation:** Store durable job state in Postgres via a new forward migration (not R2 JSON, not a new Durable Object).

- **Why Postgres over R2 JSON:** R2 lacks multi-field transactional updates and lease locking; ETag retry loops are fragile under concurrent `POST`/poll races. Postgres + Hyperdrive is already wired into `portionScope` (`backend/src/owner-menu-routes.ts:253-298`) with tenant RLS (ADR 0005) and matches `app_private.menu_ingestion_jobs`.
- **Why Postgres over a new Durable Object:** `backend/wrangler.jsonc` has no DO bindings today (only `wrangler.extraction.jsonc:23` has `ExtractionContainer`). Adding a DO class/migration is unnecessary when Postgres already enforces tenant scope and transactional leases.
- **Idempotency key:** `UNIQUE (tenant_id, draft_id, photo_id, source_hash, provider)`.
- **Duplicate-click protection:** `POST .../portion-3d` runs `INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE` inside `withOwnerMenuTransaction`. Any existing row in `submitting`, `submission_unknown`, `queued`, `running`, `waiting`, or `ready` returns the saved state (or `409` on explicit retry of ambiguous states) without calling the provider.
- **Ambiguous submission semantics (Slice 1 parity):**
  1. Before calling the container's submit route, the Worker commits `status = 'submitting'`, `provider_task_id = NULL`.
  2. Definite refusal (`ProviderRejected`, `model3d_providers/base.py:37-47`) → update `status = 'prepared'`, `error_code = code` (explicitly retryable).
  3. Pre-send failure (`ProviderUnavailable`, `base.py:49-50`) → update `status = 'prepared'`, `error_code = 'provider_unavailable'`.
  4. `ProviderAmbiguous` (`base.py:53-54`), timeout, 5xx, or Worker crash → `status = 'submission_unknown'` (or remains `'submitting'`). **Neither state is ever auto-resubmitted** (`generate_model.py:267-296`, `model_service.py:237-238`); reconciliation is manual.

---

## 3. Polling & Provider Adapter Placement

**Recommendation:** **Stateless Worker-driven polling on `GET .../portion-3d`** (gated by a Postgres lease/throttle), calling **Python provider adapters inside `ExtractionContainer`**.

- **Why `GET`-driven polling over Cron / Queue / Container:**
  - Container threads die on 60 s inactivity (`extraction-host.ts:91`).
  - Existing Cron (`backend/wrangler.jsonc:19`) runs every 6 hours — too coarse for 1–3 min S09 previews.
  - Queue consumer (`wrangler.jsonc:106-113`) adds new queue/DLQ provisioning and self-requeueing boilerplate; if background completion after tab close is needed later, a queue consumer can call the exact same `pollOrFinalize3dJob()` helper with no schema change.
  - On `GET .../portion-3d`, if `status` is terminal or `last_polled_at > now() - 5s` or `poll_lease_until > now()`, the Worker returns the DB row with **zero** container/provider calls. Otherwise it atomically claims `poll_lease_until = now() + 220s` and executes one bounded container poll.
- **Why keep provider calls in Python (not TypeScript adapters in the Worker):**
  - Reuses Slice 1 (`model3d_providers/{tripo,meshy,trellis,registry}.py`: CDN allowlists, `NoRedirect`, credit preflight, refusal vs ambiguous classification) and Slice 2 (`model_postprocess.py`: strict glTF profile + `run_isolated_postprocess`) with zero logic duplication.
  - Keeps all provider secrets (`MODEL_PROVIDER`, `TRIPO_API_KEY`, `MESHY_API_KEY`, `TRELLIS_SERVICE_URL`, `TRELLIS_SERVICE_SECRET`) strictly on the extraction-host container env (`extraction-host.ts:55-69`), never in the API Worker or browser.
  - Container stays stateless and short-lived per call (~5–30 s submit, ~2 s poll, ~30–120 s finalize) and can safely sleep between polls.
  - **Caveat:** `extraction-host.ts:88` disables internet when `productionPortionOnly` is true (`APP_ENV=production` + `EXTRACTION_PRODUCTION_PORTION_ONLY=true`). 3D routes must fail closed (`503`) in that mode.

---

## 4. GLB Validation/Cleanup & Path to Private R2

- **Where Slice 2 runs:** Inside `ExtractionContainer` (`processing/Dockerfile:8` updated to install `--extra model3d` for `trimesh==5.2.2` and `scipy==1.18.1`, `processing/pyproject.toml:33-36`), using `run_isolated_postprocess` (`model_postprocess.py:1084-1159`).
- **Cutout input bridge:** `dish_draft_photo` stores JPEG/PNG (`owner-menu-routes.ts:225`) and 2.5D stores lossy WebP (`owner-portion-preview.ts:186`), whereas `generate_model.py:70-81` requires a 256–2048 px transparent RGBA PNG. `/v1/model3d/submit` runs the container's existing U2NETP cutout (`Dockerfile:8-10`) in a per-request temp dir, resizes/pads to 256–2048 px RGBA PNG, and submits that PNG to the provider.
- **How `model.glb` + `validation.json` reach private R2 without blowing Worker RAM:**
  - Base64-in-JSON (used for 300 KB 2.5D layers in `owner-portion-preview.ts:151,181`) is unsafe for multi-MB GLBs under Cloudflare Worker memory limits.
  - Both Workers already bind the same private bucket `peekaplate-staging-assets` (`wrangler.jsonc:48`, `wrangler.extraction.jsonc:15`), and `extraction-host.ts:384-464` (`retainArtifacts`) already writes private artifacts to `SOURCE_BUCKET` using `onlyIf: { etagDoesNotMatch: '*' }` under an API-Worker-minted HMAC `X-Source-Capability`.
  - When `/v1/model3d/poll` sees provider `succeeded`, the container downloads the raw GLB (`≤ 50 MB`), runs `run_isolated_postprocess`, and returns:
    - On geometry rejection: JSON (`≤ 256 KB`) `{ state: "rejected", error_code, validation }`.
    - On acceptance: a simple length-prefixed binary stream (`[4B uint32BE jsonLen][validation.json][cleaned.glb]`, `Content-Type: application/vnd.peekaplate.model3d+bin`).
  - `extraction-host.ts` verifies both byte caps (`validation ≤ 256 KB`, `GLB ≤ 15 MB`), hashes both with SHA-256, writes them to `SOURCE_BUCKET` under:
    - `private-portions/{venueId}/{draftId}/{photoId}/{sourceHash}/model3d/{provider}/{jobId}/validation.json`
    - `private-portions/{venueId}/{draftId}/{photoId}/{sourceHash}/model3d/{provider}/{jobId}/model.glb`
  - `extraction-host.ts` returns only a small JSON receipt (`≤ 256 KB`) with keys, sizes, SHA-256 digests, and canonical `validation` summary. The API Worker verifies hashes/schema and commits `status = 'ready'` (or `'failed'`) in Postgres.

---

## 5. Exact New Routes

### API Worker Owner Routes (`backend/src/owner-menu-routes.ts`)
All reuse `portionScope(c)` (`:253-298`: Supabase Bearer JWT, `authorizeVenue`, active non-removed draft, non-rejected photo) and set `Cache-Control: private, no-store`. Responses never expose `provider_task_id`, keys, signed URLs, or disk paths.

| Method & Path | Request | Responses & Codes |
|---|---|---|
| `POST /venues/:venueId/drafts/:draftId/photos/:photoId/portion-3d` | Empty or `{}` (unknown fields rejected; optional `{ "retry": true }` only for `prepared`/`failed`) | `202` (newly submitted) or `200` (existing idempotent job) with `{ model3dJob }`; `400`, `401`, `403`, `404` (`photo_not_found`), `409` (`submission_requires_reconciliation`), `429` (`provider_call_budget_exhausted`/`busy`), `503` (`model3d_not_configured`/`model3d_unavailable`) |
| `GET /venues/:venueId/drafts/:draftId/photos/:photoId/portion-3d` | None | `200` `{ model3dJob }` (performs at most 1 leased poll/finalize if active); `404` (`not_found`) |
| `GET /venues/:venueId/drafts/:draftId/photos/:photoId/portion-3d/model.glb` | None | `200` `model/gltf-binary` (`X-Content-Type-Options: nosniff`, size/hash checked against DB); `404`, `409` (`model_not_ready`) |
| `GET /venues/:venueId/drafts/:draftId/photos/:photoId/portion-3d/validation` | None | `200` `application/json` (canonical report, size/hash checked); `404`, `409` (`validation_not_ready`) |

`model3dJob` shape: `{ jobId, status, provider, progress, errorCode, reviewStatus: "needs_review", publicationEligible: false, hasModel, hasValidation, updatedAt }`.

### Extraction-Host Allowlisted Container Routes (`backend/src/extraction-host.ts` + `processing/src/peekaplate_processing/service.py`)
Auth: `Authorization: Bearer <EXTRACTION_SERVICE_SECRET>` + `X-Source-Capability` HMAC JWT (binding `tenantId`, `jobId`, `sourceHash`). Rejected with `404`/`503` when `productionPortionOnly` is true.

| Method & Path | Request Cap | Response Cap | Purpose |
|---|---|---|---|
| `POST /v1/model3d/submit` | `application/octet-stream` ≤ **12 MB** (photo bytes) | JSON ≤ **16 KB** | U2NETP cutout → budget reserve → `provider.submit` → `{ outcome, provider, task_id?, error_code? }` |
| `POST /v1/model3d/poll` | JSON ≤ **4 KB** (`{ provider, task_id, plate_width_mm? }`) | JSON ≤ **256 KB** (from host) / framed binary ≤ **15.25 MB** (from container) | Single `provider.status`; if `succeeded`, download + `run_isolated_postprocess` + host writes R2 artifacts & returns receipt |

---

## 6. Limits: Timeouts, Budget Gate & Byte Caps

- **Timeouts:** Container startup probe 30 s (`extraction-host.ts:84`); `/v1/model3d/submit` **90 s** (30 s cold start + ~20 s cutout + 30 s provider submit); `/v1/model3d/poll` **210 s** (30 s cold start + 30 s status/download + 120 s `DECODE_TIMEOUT_S` at `model_postprocess.py:101` + 30 s R2 write, under the proven 220 s ceiling at `extraction-host.ts:500`); DB poll lease **220 s**; poll throttle **5 s**.
- **Budget gate:** Reuse `ExtractionContainer` SQLite DO (`extraction-host.ts:101-245`) + loopback `_BudgetProxyServer` (`service.py:95-175`) + `ProviderBudgetGate` (`provider_budget.py:19-90`). Reserve **1 unit on `/v1/model3d/submit` only** (max **1** billable submit per `(tenant_id, job_id)`; status polls are non-billable). Add a backend per-venue rate limit (matching `OWNER_AI_RATE_LIMITER`, `wrangler.jsonc:61`) before calling `/v1/model3d/submit`.
- **Byte caps:** Photo upload **12 MB** (`extraction-host.ts:276`); cutout PNG to provider **10 MB** (`generate_model.py:30`); raw provider GLB inside container **50 MB** (`base.py:25`, 300 k faces, 1 M vertices, 5 MB JSON chunk); cleaned GLB to R2 & S09 **15 MB**; `validation.json` **256 KB**.

---

## 7. Smallest PR Split (Next 1–2 Slices, Offline-Testable)

1. **Slice 3a — Stateless Container + Extraction-Host 3D Bridge**
   - Files: `processing/Dockerfile` (`--extra model3d`), `processing/src/peekaplate_processing/model3d_bridge.py`, `service.py`, `backend/src/extraction-host.ts`.
   - Offline tests: Python unittests with fake provider + synthetic PNG/GLB (submit, reject, ambiguous, poll, finalize-ok, finalize-rejected, budget exhausted); Vitest tests for `extraction-host.ts` allowlist, capability checks, framed binary parsing, R2 write, byte caps, and `productionPortionOnly` fail-closed.
2. **Slice 3b — Postgres Migration + API Worker Owner Routes + Retention**
   - Files: `migrations/<ts>_portion_3d_jobs.sql`, `tests/db/portion_3d_jobs.sql`, `backend/src/owner-portion-3d.ts`, `backend/src/owner-menu-routes.ts`, `backend/src/owner-menu-retention.ts` (cover `model3d/` prefix).
   - Offline tests: real Postgres SQL tests (RLS, idempotency, ambiguous no-resubmit, poll lease); Vitest route tests with mocked extraction-host `fetch` and in-memory R2.

---

## 8. Open Questions for Teammates

- **Vivien:** (1) Which provider (`tripo` vs `meshy` vs `trellis`) and when will staging keys arrive? (2) If Meshy is chosen, confirm create-response `result` field and `assets.meshy.ai` CDN host (`meshy.py:3-4,31-38`). (3) What per-venue/daily 3D generation budget and S09 retry UX are acceptable?
- **Marwan:** Final `PortionModel v1` contract — schema version, approval record fields, how `validation.json` / `orientation_suspect` / `plate_width_mm` carry into publication, and max public GLB byte budget for diner mobile.
- **Sai:** (1) Should provider keys live on `peekaplate-extraction-staging` or a separate 3D container worker? (2) Does Cloudflare Container `standard-1` have enough RAM/disk for `--extra model3d` (`trimesh` + `scipy`) and `DECODE_MEMORY_CAP = 2 GiB` (`model_postprocess.py:100`)? (3) Should `productionPortionOnly` stay internet-disabled (requiring a separate production 3D host)?

---

## 9. Unverified Assumptions

- Cloudflare Container `standard-1` RAM/disk limits and Worker 128 MB isolate memory headroom for streaming a 15 MB binary response from container to R2 were not measured live.
- `processing/Dockerfile` build size/time with `--extra model3d` has not been built yet.
- Meshy wire endpoints/CDN host remain unverified against live responses (`meshy.py:3-4`).
- `rembg` U2NETP cutout output from arbitrary owner photos may need explicit resize/pad to satisfy `validate_png`'s 256–2048 px RGBA rule (`generate_model.py:73`).
