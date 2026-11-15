# Atomic, Run-Scoped Provider-Call Budget Enforcement

## Overview

The configured hosted ingestion path enforces a durable cap of **2 outbound provider attempts per tenant/job** (`MAX_PROVIDER_CALLS_PER_RUN = 2`) across its LLM and OCR calls. A reservation is charged before transport, so a timeout or uncertain delivery can consume allowance without a successful response. A redelivery of the same job does not reset it; a new job has a separate budget.

Standalone Python helpers remain optionally gated. The hosted service requires the gate explicitly; this change is not a general account-wide spending limit. Both the Worker and matching container image must be deployed before hosted enforcement can be accepted.

## Architecture

1. **Durable Authoritative Budget Store (`backend/src/extraction-host.ts`)**
   - `ExtractionContainer` (SQLite-backed Cloudflare Durable Object) persists two tables in `ctx.storage.sql`:
     - `provider_call_budget (run_id, tenant_id, job_id, max_calls, used_calls, created_at)`
     - `provider_call_reservations (reservation_key, run_id, provider, granted, used_calls, max_calls, created_at)`
   - `POST /budget/reserve` requires both:
     - `Authorization: Bearer <EXTRACTION_SERVICE_SECRET>` (constant-time verified)
     - A valid `X-Source-Capability` HMAC JWT whose `tenantId`, `jobId`, and `sourceHash` match `X-Tenant-ID`, `X-Job-ID`, and `X-Source-Hash`.
   - The authoritative `run_id` is derived server-side as `${scope.tenantId}:${scope.jobId}`. Queue redeliveries reuse the same `job.id` and `tenant_id`, so they hit the exact same `provider_call_budget` row without resetting the counter.
   - Reservations execute inside `ctx.storage.transactionSync(...)`, guaranteeing atomicity under concurrent requests and idempotency on `reservation_key`. Once `used_calls >= max_calls` (`2`), subsequent reservations return HTTP `429` with `granted: false` (`provider_call_budget_exhausted`).

2. **Container Credential Isolation (`processing/src/peekaplate_processing/service.py`)**
   - `run_extraction()` strips `R2_*`, `EXTRACTION_*`, and `PEEK_BUDGET_*` from the child process environment so `run_pipeline.py` never receives `EXTRACTION_SERVICE_SECRET`.
   - Instead, `process()` starts a per-job loopback `_BudgetProxyServer` on `127.0.0.1:0` protected by an ephemeral `PEEK_BUDGET_TOKEN` and passes `PEEK_BUDGET_URL`, `PEEK_BUDGET_TOKEN`, and `--require-budget-gate` to `run_pipeline.py`.

3. **Python Outbound Boundaries (`processing/src/peekaplate_processing/provider_budget.py`)**
   - `ProviderBudgetGate.reserve(provider)` generates a fresh UUIDv4 `reservation_key` per outbound attempt and **fails closed** (`ProviderBudgetError`) on any network error, timeout, HTTP `4xx`/`5xx`, invalid JSON, or `granted !== true`.
   - Every outbound provider call reserves 1 unit immediately before transport:
     - `vision_extraction.py` (`extract_vision_v4`): before `vision_llm.ainvoke(...)`
     - `workflow.py` (`build_menu_graph` / `run_menu_graph`): before `structured_llm.ainvoke(...)`
     - `ocr_space.py` (`OCRSpaceClient.extract`): inside `for attempt in range(self.max_attempts):` before `build_opener(...).open(...)`
   - In `run_pipeline.py`, `ProviderBudgetError` aborts immediately without cascading to subsequent providers or falling back to OCR.
   - `model_providers.py` sets `max_retries=0` on `ChatOpenAI` clients so the OpenAI SDK cannot perform hidden uncounted retries.

## Independent local verification

- The real local workerd/SQLite regression sends 12 concurrent reservations and
  requires exactly two grants. It checks granted/denied replay, cross-job scope
  rejection, process-restart persistence and rollback after an injected SQL error.
  It passed in 2.98s. The isolated temporary harness has no container configuration,
  bucket, Queue or provider transport. It deliberately bypasses the outer HTTP
  authentication boundary, which has separate host unit coverage.
- Run that test explicitly with TEST_WORKERD=1 and
  `pnpm exec vitest run backend/src/extraction-budget.workerd.test.ts`.
  Ordinary unit checks skip this optional runtime test.
- `uv run --project processing --extra service --frozen python -X utf8 -m unittest discover -s processing/tests -q`
  passed all 576 offline Python tests in 72.731s. The service extra supplies FastAPI;
  UTF-8 mode avoids Windows' legacy encoding for Unicode fixture files. These tests
  mock paid provider transports and do not establish actual extraction accuracy.
- Hosted deployment, mixed-version rollout and provider acceptance are NOT RUN
  in this review. Keep the existing approved request allowance and Queue controls.

## Staging verification plan

Before unpausing staging queues or submitting a synthetic menu:

1. Deploy the updated Extraction Worker (`backend/wrangler.extraction.jsonc`) and container image to staging.
2. Verify `GET /health` on `https://peekaplate-api-staging.vxkong.workers.dev/` and the Extraction Worker returns `200`.
3. Optionally verify `POST /budget/reserve` directly against the Extraction Worker using a synthetic `tenantId`/`jobId` capability JWT (consumes 0 external provider calls): confirm calls 1 and 2 return `200` (`granted: true`) and call 3 returns `429` (`provider_call_budget_exhausted`).
4. Run the controlled FE-06.4 synthetic ingestion test using the authorized synthetic restaurant (`4c1b9f0d-cc45-4229-828e-e239b6906ac8`), guaranteeing at most 2 external provider requests across the entire job lifecycle.
