# feat(ingestion): orchestrate URL, PDF, and photo menu ingestion (S3-VIS-01)

## Summary

Implements the unified menu ingestion orchestration layer for **S3-VIS-01: Orchestrate URL, PDF, and photo menu ingestion** on branch `feat/s3-vis-01-menu-ingestion` targeting `develop`.

This implementation accepts menu sources, initiates asynchronous jobs, validates and adapts Python extraction output, enforces tenant-isolated persistence under cryptographic worker lease fencing, supports Cloudflare Queue dispatch and consumption, and exposes staff-authenticated endpoints for draft review and immutable publication.

### Key Components

1. **Shared Contracts (`packages/contracts`):**
   - `SubmitMenuIngestionRequestSchema`: Validates source ingestion requests across URL, PDF, photo, and text formats with idempotency keys.
   - `ApproveDishDraftRequestSchema`: Validates staff draft approval with expected revision versions.
   - `MenuIngestionQueueMessageSchema`: Versioned (`version: 1`) Cloudflare Queue message shape for asynchronous worker dispatch.
   - `PythonExtractionResultSchema` / `StructuredDishDraftSchema`: Formal contracts for downstream dish drafts, evidence spans, and segment provenance.

2. **Python-to-TypeScript Extraction Adapter (`backend/src/ingestion/adapter.ts`):**
   - Normalizes raw extraction output into persistence-ready structured drafts.
   - Preserves exact decimal prices as base-10 strings without floating-point conversion, distinguishing explicit zero (`"0.00"`) from unknown (`null`).
   - Translates Unicode code-point offsets (Python scalar values) to UTF-16 code units (JavaScript runtime offsets).
   - Validates that slicing segment text reconstructs exact expected passage slices.

3. **Persistence Repository & Worker Lease Fencing (`backend/src/ingestion/repository.ts`):**
   - Implements transactional methods: `createIngestionJob`, `claimIngestionJob`, `renewJobLease`, `persistExtractedDrafts`, `failIngestionJob`, `getIngestionJob`, `listDishDrafts`, and `approveDishDraft`.
   - **Lease Fencing:** Monotonically increments `lease_generation`, issues per-claim random UUID `claim_token`, and explicitly enforces `locked_at >= now() - interval '10 minutes'` on row locks and updates to prevent stale workers from writing after lease expiration.
   - **Safe Retry Upserts:** Retries update extraction details on pending drafts while preserving staff edits and human review decisions. Surplus drafts from earlier attempts are marked `review_status = 'superseded'` with `reviewed_by = NULL`.

4. **Cloudflare Queue Integration (`backend/src/ingestion/orchestrator.ts` & `backend/src/index.ts`):**
   - Added `INGESTION_QUEUE` binding to `Bindings`.
   - `POST /venues/:venueId/menus/jobs` durably enqueues a `MenuIngestionQueueMessage` when the queue is configured.
   - Worker exports `queue` handler dispatching to `processIngestionQueueBatch`:
     - Poison/malformed messages fail schema validation and are acknowledged (`msg.ack()`) with logged errors to prevent poison loops.
     - Duplicate delivery safely acknowledges messages for already claimed or completed jobs.
     - Successful extraction and draft persistence acknowledge the message.
     - Transient exceptions trigger delivery retry (`msg.retry()`).

5. **Staff API Routes (`backend/src/index.ts`):**
   - `POST /venues/:venueId/menus/jobs`: Staff-authenticated job submission with venue boundary check.
   - `GET /venues/:venueId/menus/jobs/:jobId`: Polling endpoint for ingestion job status.
   - `GET /venues/:venueId/drafts`: Lists extracted drafts with status filtering.
   - `POST /venues/:venueId/drafts/:draftId/approve`: Staff approval that creates an immutable published dish revision in `dish_current` and links `published_dish_id`.

6. **Database Migration (`migrations/20261026220000_menu_ingestion_drafts.sql`):**
   - Forward-only migration creating `app_private.menu_ingestion_jobs` and `app_private.dish_drafts`.
   - Forced Row-Level Security (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`) with `tenant_id = app_private.current_tenant_id()`.
   - Unconstrained `numeric` price columns.
   - PostgreSQL 16 column-specific foreign key nullification: `FOREIGN KEY (tenant_id, published_dish_id) REFERENCES app_private.dish_current(tenant_id, dish_id) ON DELETE SET NULL (published_dish_id)`.

---

## Verification Results

All local tests and static quality checks passed in this verification run:

- **Vitest Suites:** **205 passed, 4 skipped across 11 test suites in 10.27s**
  `./node_modules/.bin/vitest run packages/contracts/ backend/src/ingestion/ backend/src/index.test.ts backend/src/retrieval/ packages/analytics/`
  - `packages/contracts/src/index.test.ts`: 31 passed
  - `backend/src/ingestion/adapter.test.ts`: 11 passed
  - `backend/src/ingestion/repository.test.ts`: 8 passed
  - `backend/src/ingestion/orchestrator.test.ts`: 9 passed
  - `backend/src/index.test.ts`: 11 passed
  - `backend/src/retrieval/handoff.test.ts`: 44 passed
  - `backend/src/retrieval/security.test.ts`: 23 passed
  - `backend/src/retrieval/retrieval.test.ts`: 32 passed
  - `backend/src/retrieval/api.test.ts`: 13 passed
  - `backend/src/retrieval/fetcher.workerd.test.ts`: 12 passed (4 skipped)
  - `packages/analytics/src/index.test.ts`: 15 passed
- **Strict TypeScript:** **PASS (0 errors)** across `packages/contracts` and `backend` under `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`.
- **Biome Linter & Formatter:** **PASS (35 files clean, 0 errors, 0 warnings)**.
- **Git Whitespace & Format:** `git diff --check` **PASS (0 errors)**.
- **Context Graph Freshness:** `node scripts/context.mjs check` **PASS (10 modules, 10 handoffs fresh)**.
- **Documentation Verification:** `node scripts/check-docs.mjs` **PASS (43 markdown files checked)**.

### Database Verification Limitation
The 25-assertion pgTAP test suite (`tests/db/menu_ingestion.sql`) and database integration tests (`backend/src/ingestion/ingestion.integration.ts`) were **NOT RUN** against a live PostgreSQL container because Docker daemon socket access was unavailable in the local sandbox environment (`connect: operation not permitted` on `docker.sock`). Query plans, table structures, and check constraints were verified statically and via parameterized in-memory mock client tests.

---

## Architecture Boundaries

- **S3-VIS-02 (Mohammad):** Upstream extraction produces results matching `MenuExtractionResultSchema`. S3-VIS-01 orchestrator consumes this via the typed `PythonExtractor` boundary.
- **S3-VIS-04 (Raghav):** Bounded evidence retrieval is query-directed passage search (`query: "Burger"`), whereas S3-VIS-01 is whole-menu ingestion. Both share Unicode span and slice equality standards, but are decoupled at runtime.
- **Infrastructure (Sai):** Cloudflare Queue producer and consumer application logic is complete. Live execution requires queue provisioning in Cloudflare and the binding name configured in `wrangler.jsonc`.

---

## External Dependencies for Staging End-to-End Acceptance

The implementation is complete and ready for code review. Live end-to-end processing in staging requires:
1. **Python Service Transport:** Finalizing whether Cloudflare Workers invoke `processing/` via a Cloudflare Service Binding or internal HTTP gateway (Sai / Mohammad / Vivien).
2. **Queue Provisioning:** Creating `peekaplate-staging-menu-ingestion` in Cloudflare and adding `INGESTION_QUEUE` to `backend/wrangler.jsonc` (Sai).
3. **Database Migration:** Applying `migrations/20261026220000_menu_ingestion_drafts.sql` to staging Supabase (Jeffin).
