## Outcome

Implements the unified menu ingestion orchestration layer for S3-VIS-01, coordinating URL, PDF, and photo menu intake into reviewable dish drafts without publishing unreviewed content.

## Contract and context

- Spec, issue, or ADR: S3-VIS-01 (menu ingestion orchestration), ADR 0002 (selective event sourcing), ADR 0005 (tenancy and privacy), ADR 0015 (integration contracts), ADR 0016 (unified menu ingestion orchestration).
- Data/API/migration impact: Adds `app_private.menu_ingestion_jobs` and `app_private.dish_drafts` with forced RLS and worker lease fencing; adds Hono staff routes and queue producer/consumer bindings.
- Documentation or ADR update: `docs/menu-ingestion-persistence-proposal.md` and `docs/CONTEXT.md` refreshed.

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

- PASS: `vitest run packages/contracts/ backend/src/ingestion/ backend/src/index.test.ts` (84 passed across 6 suites)
- PASS: `tsc --noEmit -p packages/contracts/tsconfig.json && tsc --noEmit -p backend/tsconfig.json` (0 errors)
- PASS: `biome check packages/contracts/ backend/src/` (37 files checked, 0 errors)
- PASS: `git diff --check` (no whitespace errors)
- PASS: `node scripts/context.mjs check` (10 modules, 10 handoffs fresh)
- PASS: `node scripts/check-docs.mjs` (44 files checked)
- PASS: `node scripts/test-db.mjs` (pgTAP 96 assertions passed; Vitest db integration 25/25; worker check passed)
- NOT RUN: `pnpm verify staging:e2e` - Staging end-to-end verification has not yet been performed.

> [!NOTE]
> Synthetic contract tests prove the TypeScript adapter mapping and schema bounds. Local pgTAP tests prove PostgreSQL RLS policies and table constraints. Vitest integration tests prove database queries execute against a real PostgreSQL 16 instance. `representative-extraction-v2.json` is a synthetic/reconstructed fixture. **None of these constitute live end-to-end staging verification, which has not yet been performed.**

## Deferred / future work

- Live containerized Python extraction service integration testing in staging.
- Streaming extraction report persistence for large multi-page scans to minimize Worker memory usage.
- Rolling window submission deduplication by menu content hash.
