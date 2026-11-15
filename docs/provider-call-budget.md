# Atomic, Run-Scoped Provider-Call Budget Enforcement

## Overview

PeekaPlate enforces a hard, durable, run-scoped cap of **2 outbound provider requests per authorized ingestion run** (`MAX_PROVIDER_CALLS_PER_RUN = 2`) at the actual outbound HTTP boundary across all LLM and OCR providers.

This cap protects controlled staging E2E runs (FE-06.4) and production-equivalent extraction paths against unbounded spend from provider cascades, retries, multi-page fan-out, concurrency, or Cloudflare Queue redeliveries.

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

## Non-Billable Staging Verification Plan

Before unpausing staging queues or submitting a synthetic menu:

1. Deploy the updated Extraction Worker (`backend/wrangler.extraction.jsonc`) and container image to staging.
2. Verify `GET /health` on `https://peekaplate-api-staging.vxkong.workers.dev/` and the Extraction Worker returns `200`.
3. Optionally verify `POST /budget/reserve` directly against the Extraction Worker using a synthetic `tenantId`/`jobId` capability JWT (consumes 0 external provider calls): confirm calls 1 and 2 return `200` (`granted: true`) and call 3 returns `429` (`provider_call_budget_exhausted`).
4. Run the controlled FE-06.4 synthetic ingestion test using the authorized synthetic restaurant (`4c1b9f0d-cc45-4229-828e-e239b6906ac8`), guaranteeing at most 2 external provider requests across the entire job lifecycle.
