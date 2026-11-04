## Outcome

Implements the unified menu ingestion orchestration layer for S3-VIS-01, coordinating URL, PDF, and photo menu intake into reviewable dish drafts without publishing unreviewed content. Fully reconciled with ADR 0016 (PR #44), Mohammad's extraction bundle contract (PR #58), and latest `develop`.

## Contract and context

- Spec, issue, or ADR: S3-VIS-01 (menu ingestion orchestration), ADR 0002 (selective event sourcing), ADR 0005 (tenancy and privacy), ADR 0015 (integration contracts), ADR 0016 (unified menu ingestion orchestration).
- Data/API/migration impact: Adds `app_private.menu_ingestion_jobs` and `app_private.dish_drafts` with forced RLS and worker lease fencing; adds Hono staff routes and queue producer/consumer bindings.
- Documentation or ADR update: Incorporates `docs/adr/0016-unified-menu-ingestion-orchestration.md`, `docs/menu-ingestion-persistence-proposal.md`, and refreshed `docs/CONTEXT.md`.

## Changes

- `packages/contracts/src/index.ts`: Shared schemas for ingestion jobs, drafts, and queue messages with schema 1/2 and pipeline 2/3 support (`SubmitMenuIngestionRequestSchema`, `MenuExtractionResultSchema`, `ExtractionDishDraftSchema`, `ExtractionDraftEvidenceSchema`, `ExtractionBoxEvidenceSchema`, `ExtractionBoxCoordinatesSchema`, `ExtractionSourceSpanSchema`, `StructuredDishDraftSchema`, `ApproveDishDraftRequestSchema`, `JobScopeSchema`, `DraftScopeSchema`).
- `packages/contracts/src/index.test.ts`: Unified contract schema validation tests across observation, owner report, menu ingestion, and OCR box evidence.
- `backend/src/ingestion/orchestrator.ts`: Orchestration pipeline with intake boundaries, URL rejection with SSRF check, attempt-scoped report keys (`result_storage_key`), durable failure diagnostic persistence, and lease-aware Queue retries delayed through active lease expiry.
- `backend/src/ingestion/adapter.ts`: Extraction adapter with multi-span and OCR box evidence reconstruction, grouped price handling, and support for Schema 1/Pipeline 2 and Schema 2/Pipeline 3.
- `backend/src/ingestion/repository.ts`: Job lifecycle and draft persistence with lease fencing across both completion and failure, `draft_index` preservation, and atomic draft approval under concurrency with required `commandId` and `es_command` idempotency.
- `backend/src/ingestion/transport.ts`: Typed HTTP transport to Python extraction service (Mohammad's PR #58 `/extract` endpoint with `X-Extraction-Artifact-Bundle: 1` private sidecar negotiation) with configurable 720s timeout budget (`DEFAULT_EXTRACTION_TIMEOUT_MS = 720_000`), required materialized source validation (`source_storage_key` and `source_hash`), signed HMAC capability tokens (`X-Source-Capability`), and granular error mapping.
- `backend/src/ingestion/contract.test.ts`: Layer A fixture and contract verification suite across all 9 fixtures and high-volume 35-page/210-draft synthetic verification.
- `backend/src/index.ts`: Authenticated staff endpoints (`/venues/:venueId/menus/jobs`, `/venues/:venueId/menus/drafts/:draftId/approve`), Cloudflare Queue consumer dispatch routing menu jobs to `handleQueueBatch` and observation events to `createObservationQueueHandler`.
- `backend/wrangler.jsonc`: Queue producer bindings (`INGESTION_QUEUE`, `OBSERVATION_QUEUE`), `EXTRACTION_TIMEOUT_MS`, and `INGESTION_REPORTS_BUCKET` R2 binding.
- `migrations/20261026220000_menu_ingestion_drafts.sql`: Forward-only migration with forced RLS, lease fencing, exact numeric prices, and draft columns.
- `tests/db/menu_ingestion.sql`: pgTAP test suite (23 assertions).
- `tests/fixtures/menu-ingestion/`: Complete synthetic/reconstructed test fixtures including Mohammad's VIS-02 bundle fixture.

## Review & Correctness Stabilization

Resolves all reviewer inline comments and the four core correctness invariants:
1. **URL Intake & Extraction Contract (Gap 1)**: Unmaterialized URL sources (and raw text) are strictly rejected at the intake boundary (`submitMenuIngestion`) with HTTP 400 `unsupported_source_type` (preserving URL validation via `validateIngestionUrl`). For any pre-existing or queued URL jobs, extraction dispatch deterministically traps the unsupported source error, durably records a structured extraction diagnostic in report storage, and transitions the job to terminal `failed` so workers can ACK without infinite redelivery loops.
2. **OCR Box Evidence Schema (Gap 2)**: Added `ExtractionBoxCoordinatesSchema` and `ExtractionBoxEvidenceSchema` to contracts, supporting valid fractional float OCR bounding boxes (`left`, `top`, `width`, `height`, `page_number`, `saved_region_index`, `text`) from PR #58 across `ExtractionDraftEvidenceSchema` and `StructuredDishDraftSchema`. Strictly rejects non-numbers, negative values, zero dimensions, NaN, Infinity, and malformed inputs. Preserves and stores box evidence through adapter to `dish_drafts.evidence`.
3. **Failure Diagnostics Persistence & ACK Invariant (Gap 3)**: Guaranteed that no failed extraction job is acknowledged until its diagnostic report is durably persisted to report storage (`reports/${tenantId}/${jobId}/attempts/${claimToken}/extraction.json`) and linked via `result_storage_key` in the database. If diagnostic report storage fails, database transition is aborted and message is retried (not ACKed).
4. **Lease Fencing on Failure & Concurrency Transitions (Gap 4)**: Updated `failIngestionJob` with atomic lease fencing (`WHERE id = $1 AND claim_token = $2 AND locked_at >= now() - ($leaseTimeout * '1 minute'::interval)`). If a worker's lease expired or was reclaimed by another worker, late failed results throw `lease_expired_or_reclaimed`, preventing stale workers from mutating job state or falsely completing/failing active jobs.

## Verification

- PASS: `pnpm check` on `68370d4` (`node scripts/verify.mjs lint typecheck test context:check docs:check`):
  - `biome check .`: 188 files checked, 0 errors.
  - `pnpm -r --if-present typecheck`: 7 of 7 packages passed without errors.
  - `vitest run`: 37 test files, 694 passed, 4 skipped.
  - `node --test scripts/*.test.mjs`: 64 script tests passed.
  - `node scripts/context.mjs check`: 12 modules, 10 handoffs valid and fresh.
  - `node scripts/check-docs.mjs`: 47 Markdown documentation files checked.
- PASS: `pnpm test:db` on `68370d4` (`node scripts/test-db.mjs`):
  - pgTAP suites: 8 test files, 192 assertions passed against real PostgreSQL.
  - Database integration suites: 4 test files, 60 integration tests passed (`consumer.integration.ts`, `dish.integration.ts`, `ingestion.integration.ts`, `facts.integration.ts`).
  - Local Worker demo smoke passed.
- PASS: `GitHub checks on 68370d4` (exact-head CI is green; GitHub reports branch as MERGEABLE without conflicts).
- NOT RUN: Hosted staging end-to-end verification with active OCR/AI providers; simulated Queue delivery and mock report storage on real PostgreSQL 16.

> [!NOTE]
> Synthetic contract tests prove the TypeScript adapter mapping and schema bounds. Local pgTAP tests prove PostgreSQL RLS policies and table constraints. Vitest integration tests prove database queries execute against a real PostgreSQL 16 instance. `representative-extraction-v2.json` and `vis02-mohammad-bundle.json` are synthetic/reconstructed fixtures. **None of these constitute live end-to-end staging verification, which has not yet been performed.**

## Deferred / future work

- Live containerized Python extraction service integration testing in staging.
- Streaming extraction report persistence for large multi-page scans to minimize Worker memory usage.
- Rolling window submission deduplication by menu content hash.

## Release controls / handoff

The staging menu queues remain paused. The checked-in Worker config currently has a Queue producer binding only: it does not activate a menu Worker consumer or establish its batch size, concurrency, retry budget, visibility timeout, or DLQ routing. Before activation, review and configure those controls alongside the lease-aware recovery policy; the temporary HTTP pull consumer is not that policy. The per-message recovery delay schedules the first early-redelivery retry past the 15-minute lease fence, leaving a later delivery within a default three-retry budget. Controlled acceptance remains source → extraction → private report → drafts → ACK/retry/DLQ, including early redelivery through lease expiry, post-expiry recovery, and genuine DLQ exhaustion. Hosted end-to-end acceptance remains separate. Both Queue dispatch paths (`INGESTION_QUEUE`, `OBSERVATION_QUEUE`) and shared contracts are unified and preserved.
