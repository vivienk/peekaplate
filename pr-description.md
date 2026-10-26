> **Status: Draft / Work in Progress**
>
> This PR implements the core S3-VIS-01 menu ingestion workflow. It remains a draft while integration dependencies and live database verification are completed. Passing unit tests and static checks do not establish staging or end-to-end readiness.

## Outcome

Implements the unified menu ingestion orchestration layer for S3-VIS-01, coordinating URL, PDF, and photo menu intake into reviewable dish drafts without publishing unreviewed content.

## Contract and context

- Spec, issue, or ADR: S3-VIS-01 (menu ingestion orchestration), ADR 0002 (selective event sourcing), ADR 0005 (tenancy and privacy), ADR 0015 (integration contracts).
- Data/API/migration impact: Adds `app_private.menu_ingestion_jobs` and `app_private.dish_drafts` with forced RLS and lease fencing; adds Hono staff routes and queue producer/consumer.
- Documentation or ADR update: `docs/menu-ingestion-persistence-proposal.md` and `docs/CONTEXT.md` refreshed.

## Summary

- **Shared contracts:** Define menu ingestion requests, versioned queue messages, extraction results, and draft approval payloads.
- **Extraction adapter:** Validate extraction output, preserve exact decimal price strings, normalize Unicode offsets, and verify evidence spans against source text.
- **Persistence:** Add ingestion job and dish draft persistence, worker lease fencing, retry handling, and a database migration.
- **Queue integration:** Implement application-level queue dispatch and batch processing, including duplicate delivery handling, poison-message acknowledgement, and retry behavior.
- **Staff review workflow:** Add job submission, job status, draft listing, and draft approval endpoints with authentication and venue-boundary enforcement.
- **Tests and documentation:** Add contract, adapter, repository, orchestration, API, and database test coverage, plus the relevant architecture documentation.

## Changes

- `packages/contracts/src/index.ts`: Shared schemas for ingestion jobs, drafts, and queue messages.
- `backend/src/ingestion/`: Extraction adapter, persistence repository, and lifecycle orchestrator.
- `backend/src/index.ts`: Authenticated staff endpoints and Cloudflare Queue consumer handler.
- `migrations/20261026220000_menu_ingestion_drafts.sql`: Forward-only migration with forced RLS.
- `tests/db/menu_ingestion.sql`: pgTAP test suite.

## Verification

- PASS: `./node_modules/.bin/vitest run packages/contracts/ backend/src/ingestion/ backend/src/index.test.ts backend/src/retrieval/ packages/analytics/` (205 passed, 4 skipped across 11 suites)
- PASS: `./node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json && ./node_modules/.bin/tsc --noEmit -p backend/tsconfig.json`
- PASS: `./node_modules/.bin/biome check packages/contracts/ backend/src/`
- PASS: `git diff --check`
- PASS: `node scripts/context.mjs check`
- PASS: `node scripts/check-docs.mjs`
- PASS: `node scripts/test-db.mjs` (pgTAP foundation 27/27, menu_ingestion 19/19, posthog 15/15, staff 16/16, team-analytics 15/15; Vitest db integration 24/24; worker check)
- NOT RUN: Staging end-to-end flow (pending queue provisioning, Python extraction transport, and staging migration)

## Verification and CI status

**Local verification reported by the implementation agent:**

| Check | Reported result | What it establishes |
|---|---|---|
| Vitest | 205 passed, 4 skipped across 11 suites | Unit and mock-based application behavior |
| TypeScript strict checks | Passed for contracts and backend | Static type correctness |
| Biome | 35 files clean, 0 errors | Formatting and lint checks |
| `git diff --check` | Passed | No reported whitespace errors |
| Architecture context check | Passed | Context graph and handoff freshness |
| Documentation check | Passed | Repository documentation validation |
| Live PostgreSQL / pgTAP | **PASS** | 92 pgTAP assertions and 24 Vitest db integration tests passed on Docker PG 16 |
| Staging end-to-end flow | **Pending** | Production-like ingestion has not yet been demonstrated |

These are reported local results, not proof that GitHub Actions or remote CI has passed.

**Actual GitHub Actions check runs (PR #45):**

| Check name | Status | Conclusion | Detail |
|---|---|---|---|
| `CI/changes` | COMPLETED | **PASS** | Change detection passed |
| `CI/browser` | COMPLETED | **PASS** | Playwright browser suite passed |
| `CI/quality` | COMPLETED | **FAIL** | Initial PR check failed on PR description template section |
| `CI/database` | COMPLETED | **FAIL** | pgTAP check failed on job check constraint in `tests/db/menu_ingestion.sql:103` |
| `CI/ci` | COMPLETED | **FAIL** | Rollup gate requiring all checks to succeed |

Because remote checks are failing, this PR remains in **Draft** status pending resolution of database test fixture constraints and live staging verification.

## Outstanding integration work

- **Queue infrastructure:** Confirm that the staging queue exists and the Worker binding matches the application configuration.
- **Python extraction transport:** Finalize and verify the actual transport from the Worker to the Python extraction service. The typed interface and mock tests do not prove that a live service call works.
- **Database migration:** Apply the menu ingestion migration to a suitable test or staging database and verify its behavior.
- **Live database tests:** Run the pgTAP suite and database integration tests when a PostgreSQL environment is available.
- **End-to-end verification:** Exercise the workflow from menu submission through extraction, persistence, draft review, and approval once the required dependencies are available.

## Deferred / future work

- Finalize production RPC transport for Python extraction pipeline.
- Provision Cloudflare Queue resources in staging `wrangler.jsonc`.
- Apply forward database migration to staging database instances.

## Architecture boundaries

- S3-VIS-01 handles whole-menu ingestion and draft creation.
- S3-VIS-02 provides the extraction pipeline through an agreed integration contract.
- S3-VIS-04 provides bounded, query-directed menu evidence retrieval and remains a separate workflow.
- Queue provisioning, service connectivity, and database deployment require their respective infrastructure integrations.

## Review notes

This PR is open for continued development and technical feedback. The current automated tests cover application behavior and mocked integration boundaries; live database execution and staging end-to-end verification remain outstanding.

**Do not merge while this PR is marked Draft.**
