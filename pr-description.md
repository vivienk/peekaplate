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
- `backend/src/ingestion/orchestrator.ts`: Orchestration pipeline with report storage retention (Finding A), attempt-scoped report keys, and lease-aware Queue retries delayed through active lease expiry.
- `backend/src/ingestion/transport.ts`: Typed HTTP transport to Python extraction service with configurable 600s timeout (`DEFAULT_EXTRACTION_TIMEOUT_MS = 600_000`), required materialized source validation (`source_storage_key` and `source_hash`), client cancellation signal support, and granular error mapping.
- `backend/src/ingestion/contract.test.ts`: Layer A fixture and contract verification suite across all 9 fixtures and high-volume 35-page/210-draft synthetic verification (22 tests).
- `backend/src/ingestion/orchestrator.ts`: Rejection of unmaterialized URL/text inputs at submission boundary, tenant/job sourceStorageKey derivation, and queue retry on requeued status.
- `backend/src/index.ts`: Authenticated staff endpoints, Cloudflare Queue consumer handler with connected `INGESTION_REPORTS_BUCKET`, a 15-minute lease budget, and `EXTRACTION_TIMEOUT_MS` binding support.
- `backend/wrangler.jsonc`: Queue producer bindings (`INGESTION_QUEUE`, `OBSERVATION_QUEUE`) and `INGESTION_REPORTS_BUCKET` R2 binding (menu consumer unactivated).
- `migrations/20261026220000_menu_ingestion_drafts.sql`: Forward-only migration with forced RLS and new schema 2 draft columns.
- `tests/db/menu_ingestion.sql`: pgTAP test suite (23 assertions).
- `tests/fixtures/menu-ingestion/`: 9 synthetic/reconstructed test fixtures.

## Verification

- PASS: `pnpm verify lint typecheck test build context:check docs:check` (Node.js v24.22.2, pnpm v11.25.0; Biome checked 124 files, 7 workspace packages typechecked with tsc, 339 passed / 4 skipped in Vitest across 22 test files, 63 script tests passed, diner and console builds succeeded, context checked 12 modules and 10 handoffs fresh, 45 documentation files verified; exit code 0).
- PASS: `pnpm verify test:db` (Node.js v24.22.2; 96 pgTAP assertions passed across foundation, menu_ingestion, posthog, staff, and team-analytics; 34 DB integration tests passed including the lease-aware delay recovery regression; local Worker smoke test succeeded; exit code 0).
- PASS: Focused lease-recovery regression (`backend/src/ingestion/ingestion.integration.ts` and `backend/src/ingestion/orchestrator.test.ts`) confirms `retry({ delaySeconds })` is requested with remaining lease duration plus safety second, avoids burning retry budget, waits for real PostgreSQL lease expiry without manual `locked_at` aging, and allows Worker 2 to reclaim and ACK the recovered job.
- NOT RUN: `pnpm verify staging:e2e` - Staging end-to-end verification has not yet been performed. Simulated Queue delivery and mock report storage on real PostgreSQL 16; not hosted Cloudflare Queue/R2 E2E.

> [!NOTE]
> Synthetic contract tests prove the TypeScript adapter mapping and schema bounds. Local pgTAP tests prove PostgreSQL RLS policies and table constraints. Vitest integration tests prove database queries execute against a real PostgreSQL 16 instance. `representative-extraction-v2.json` is a synthetic/reconstructed fixture. **None of these constitute live end-to-end staging verification, which has not yet been performed.**

## Deferred / future work

- Live containerized Python extraction service integration testing in staging.
- Streaming extraction report persistence for large multi-page scans to minimize Worker memory usage.
- Rolling window submission deduplication by menu content hash.

## Release controls / handoff

The staging menu queues remain paused. The checked-in Worker config currently has a Queue producer binding only: it does not activate a menu Worker consumer or establish its batch size, concurrency, retry budget, visibility timeout, or DLQ routing. Before activation, review and configure those controls alongside the lease-aware recovery policy; the temporary HTTP pull consumer is not that policy. The per-message recovery delay schedules the first early-redelivery retry past the 15-minute lease fence, leaving a later delivery within a default three-retry budget. Controlled acceptance remains source → extraction → private report → database drafts → ACK, including early redelivery through lease expiry, post-expiry recovery, and genuine DLQ exhaustion. Hosted end-to-end acceptance remains separate.
