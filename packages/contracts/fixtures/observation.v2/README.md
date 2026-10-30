# Shared observation.v2 fixtures

Local verification: six fixture tests and all 231 application tests pass (four optional tests skipped). Lint and typecheck pass. Full pnpm check remains limited on Windows: 56 of 57 script tests pass; preview symlink creation fails with EPERM. This fixture delivery does not claim hosted integration acceptance.

Synthetic inputs for TRK-01. Load fixtures.json: valid_events covers nine P0 types; invalid_events contains negative cases; delivery_cases contains ordered HTTP request bodies and expected ingestion receipt statuses. Send only request bodies, not fixture metadata.

Freeze the clock at 2026-10-24T16:00:00.000Z. Mock test-only authorization for publication 40000000-0000-4000-8000-000000000001, permitted rate limits and successful Queue enqueue. Never send these fixed-time fixtures to production.

Stateless ingestion accepts repeated requests again. Cross-request duplicate/conflict resolution belongs to consumer/database integration; an accepted Queue receipt is not proof of a canonical database write. The cross_request_conflict_deferred_to_consumer case intentionally expects accepted twice at ingestion. Consumers must deduplicate identical payloads and quarantine changed payloads without overwriting the original.

Nifemi owns browser delivery tests, including storage failure with no Save/Unsave success events, identity preservation on retries, expiry and fixture mode with no network. JSON cannot prove those browser behaviors. The backend fixture test verifies schemas and ingestion receipts with a synthetic Queue, not hosted Queue/R2/database delivery.
