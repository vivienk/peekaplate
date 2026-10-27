## Outcome

Implements the unified menu ingestion orchestration layer for S3-VIS-01, coordinating URL, PDF, and photo menu intake into reviewable dish drafts without publishing unreviewed content.

## Contract and context

- Spec, issue, or ADR: S3-VIS-01 (menu ingestion orchestration), ADR 0002 (selective event sourcing), ADR 0005 (tenancy and privacy), ADR 0015 (integration contracts), ADR 0016 (unified menu ingestion orchestration).
- Data/API/migration impact: Adds `app_private.menu_ingestion_jobs` and `app_private.dish_drafts` with forced RLS and worker lease fencing; adds Hono staff routes and queue producer/consumer bindings.
- Documentation or ADR update: `docs/menu-ingestion-persistence-proposal.md` and `docs/CONTEXT.md` refreshed.

## Summary

- **Shared contracts:** Define menu ingestion requests, versioned queue messages, extraction results, and draft approval payloads in `@peekaplate/contracts`. Supports schema 1 / pipeline 2 and schema 2 / pipeline 3, preserving `subcategory`, `category_page_number`, `price_text`, `candidate_id`, and `draft_index`.
- **Extraction adapter:** Implements `adaptPythonExtractionResult` with multi-span evidence reconstruction, Unicode code-point boundary enforcement (`Array.from(str).length`), segment failure rejection, non-contiguous `draft_index` matching, and grouped printed price handling (`price_text` preserved with null scalar `price_amount`).
- **Persistence & Finding Resolutions:**
  - Persists extracted drafts to `app_private.dish_drafts` preserving producer's original `draft_index` (**Finding B**).
  - Supersedes unreviewed pending drafts via `NOT (draft_index = ANY($3::integer[]))`.
  - Resolves table CHECK constraint violation on retryable failures by setting `status = 'queued'` and `finished_at = NULL` (**Finding C**).
  - Enforces worker lease fencing (`claim_token` and `lease_generation`) under row locks.
- **R2 Report Storage (Finding A):** Durably persists full extraction report JSON to `reports/${tenantId}/${jobId}/extraction.json` via `ReportStorage` interface and records `result_storage_key`.
- **Queue integration:** Configures `INGESTION_QUEUE` producer (`peekaplate-staging-menu-ingestion`) and consumer with 3 retries and DLQ (`peekaplate-staging-menu-ingestion-dlq`).
- **Transport:** Adds typed `createHttpPythonExtractor` with correlation IDs, timeout abort signals, authorization headers, and schema validation.
- **Staff review workflow:** Adds job submission, job status, draft listing, and draft approval endpoints with authentication and venue-boundary enforcement. All drafts strictly enforce `status: "needs_review"`.

## Changes

- `packages/contracts/src/index.ts`: Shared schemas for ingestion jobs, drafts, and queue messages with schema 1/2 and pipeline 2/3 support.
- `packages/contracts/src/index.test.ts`: Contract schema validation tests.
- `backend/src/ingestion/adapter.ts`: Extraction adapter with multi-span evidence reconstruction and grouped price handling.
- `backend/src/ingestion/repository.ts`: Job lifecycle and draft persistence with lease fencing, Finding B `draft_index` fix, and Finding C retry status fix.
- `backend/src/ingestion/orchestrator.ts`: Orchestration pipeline with report storage retention (Finding A).
- `backend/src/ingestion/transport.ts`: Typed HTTP transport to Python extraction service.
- `backend/src/ingestion/contract.test.ts`: Layer A fixture and contract verification suite across all 9 fixtures.
- `backend/src/index.ts`: Authenticated staff endpoints and Cloudflare Queue consumer handler.
- `backend/wrangler.jsonc`: Queue producer and consumer bindings.
- `migrations/20261026220000_menu_ingestion_drafts.sql`: Forward-only migration with forced RLS and new schema 2 draft columns.
- `tests/db/menu_ingestion.sql`: pgTAP test suite (23 assertions).
- `tests/fixtures/menu-ingestion/`: 9 synthetic/reconstructed test fixtures.

## Verification

- PASS: `./node_modules/.bin/vitest run packages/contracts/ backend/src/ingestion/ backend/src/index.test.ts` (84 passed across 6 suites)
- PASS: `./node_modules/.bin/vitest run packages/contracts/ backend/src/ingestion/ backend/src/retrieval/ packages/analytics/` (207 passed, 4 skipped across 11 suites)
- PASS: `./node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json && ./node_modules/.bin/tsc --noEmit -p backend/tsconfig.json` (0 errors)
- PASS: `./node_modules/.bin/biome check packages/contracts/ backend/src/` (37 files checked, 0 errors)
- PASS: `git diff --check` (no whitespace errors)
- PASS: `node scripts/context.mjs check` (10 modules, 10 handoffs fresh)
- PASS: `node scripts/check-docs.mjs` (43 files checked)
- PASS: `node scripts/test-db.mjs` (pgTAP 96 assertions passed: menu_ingestion 23/23, foundation 27/27, posthog 15/15, staff 16/16, team-analytics 15/15; Vitest db integration 25/25; worker check passed)
- NOT RUN: Staging end-to-end verification has not yet been performed.

> [!NOTE]
> Synthetic contract tests prove the TypeScript adapter mapping and schema bounds. Local pgTAP tests prove PostgreSQL RLS policies and table constraints. Vitest integration tests prove database queries execute against a real PostgreSQL 16 instance. `representative-extraction-v2.json` is a synthetic/reconstructed fixture. **None of these constitute live end-to-end staging verification, which has not yet been performed.**

## Architecture Boundaries

- S3-VIS-01 handles whole-menu ingestion orchestration, queue dispatch, report storage, draft persistence, and staff review gating.
- S3-VIS-02 provides OCR and LLM draft extraction through the agreed schema contract.
- S3-VIS-04 provides bounded menu evidence retrieval.
- Extracted drafts remain strictly in `needs_review` state; approval uses the authorized dish command boundary without automatic publishing.
