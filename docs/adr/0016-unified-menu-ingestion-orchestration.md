# ADR 0016: Unified Menu Ingestion Orchestration

- Status: Proposed
- Date: 2026-10-23
- Owner: To be confirmed

## Context

S3-VIS-01 must provide one ingestion workflow for menu URLs, PDFs, and
photos. The workflow must validate inputs, reuse existing source-specific
processing and retrieval capabilities, preserve provenance and evidence,
normalize results to a versioned contract, and make extracted drafts
available for human review.

The existing Python processing package supports local PDF and image
processing. The existing VIS-04 adapter maps retrieval results and Python
handoffs into validated TypeScript source-input structures. These
components provide useful processing boundaries, but they do not constitute
a complete upload, asynchronous job, result persistence, and review workflow.

The backend already has tenant-scoped database access and an authorized
dish-revision command. Dish revisions must continue to use the established
command boundary rather than introducing a parallel persistence mechanism.

## Decision

1. Reuse existing VIS-02 processing, VIS-04 retrieval, and the current
   TypeScript handoff adapters where their contracts fit. Do not duplicate
   OCR, extraction, retrieval, or evidence-offset conversion.

2. Define a versioned ingestion contract that preserves source identity,
   content hashes, source metadata, processing segments, evidence spans,
   warnings, errors, and complete or partial processing status. Reject
   unsupported contract versions and invalid evidence rather than silently
   repairing them.

3. Separate ingestion submission, processing, result validation, and human
   review. The workflow must expose a trackable job lifecycle and represent
   partial failures explicitly.

4. Keep source artifacts and processing results private. Enforce venue
   authorization, tenant isolation, input limits, bounded retries, timeouts,
   and duplicate-submission protection at the appropriate boundaries.

5. Validate processing results in TypeScript before accepting them into the
   application. Preserve the existing evidence-offset conventions and exact
   source-slice validation.

6. Treat extracted dishes as drafts with status `needs_review`. Ingestion
   must not auto-publish dishes or bypass human approval. Accepted revisions
   must use the existing authorized dish command and its version and
   idempotency checks.

7. Use the supported hosted Python extraction service for deployed processing. The staging infrastructure uses the `peekaplate-staging-menu-ingestion` Queue, its `peekaplate-staging-menu-ingestion-dlq` dead-letter queue, and private R2 storage in `peekaplate-staging-assets`. Extraction reports are written under `reports/<tenant>/<job>/extraction.json`. Keep source artifacts private, enforce tenant/job-scoped source access and source-hash validation, and ensure report persistence succeeds before acknowledging queue work. Do not allow the Python service to fetch arbitrary caller-supplied URLs. URL, PDF, and photo inputs must be validated and safely materialized through the authorized ingestion boundary before processing. These staging resource choices do not, by themselves, establish full end-to-end product acceptance.

8. Test contract compatibility, source validation, tenant isolation, job
   transitions, retries, duplicate submissions, partial failures, evidence
   integrity, and the end-to-end path from submission through review.

## Consequences

- Existing VIS-02 processing and VIS-04 retrieval/handoff implementations remain the preferred reusable boundaries.
- Deployed Python processing uses the supported hosted extraction runtime rather than assuming a Queue can execute Python directly.
- Staging infrastructure has dedicated menu-ingestion Queue/DLQ configuration and private R2 report storage; resource names and bindings must remain aligned with deployment configuration.
- Source access, tenant/job scoping, source-hash consistency, and report persistence are required processing boundaries.
- Queue delivery must remain controlled until approved OCR/AI provider configuration, processing/transport/lease/retry budgets, and full feature-level acceptance are verified.
- Extracted dishes remain separate from authorized dish-revision persistence and publication; human review remains mandatory.
- Python processing tests and a pinned Python CI job must remain part of the repository verification workflow.

## Open Questions

- Which approved OCR and AI provider credentials and configuration will be used for controlled feature acceptance?
- What are the agreed processing, transport, lease, timeout, and retry budgets across the Worker, Queue, and hosted extraction service?
- Are upload limits, retention, and operational-cost ownership explicitly approved?
- Where and how is ingestion job state persisted, including retry metadata, idempotency, and validated results?
- Who owns final approval of the deployment and operational configuration?
- Has the complete controlled menu-ingestion workflow been accepted, including submission, extraction, report persistence, validated draft creation, queue acknowledgement, retries, dead-letter handling, and cross-venue isolation?

## Verification

- Existing VIS-04 adapter tests must continue to pass.
- Python processing tests must run in the documented environment, with the pinned Python CI job passing.
- Contract tests must cover supported and unsupported versions, evidence spans, Unicode offsets, and partial failures.
- Integration tests must verify authorization, tenant isolation, job lifecycle, duplicate protection, and persistence boundaries.
- Staging infrastructure acceptance is documented in `docs/menu-ingestion-infrastructure.md`. It covers hosted service authentication, signed private-source access, source-hash validation, and remote Queue/R2 delivery, retry, acknowledgement, and dead-letter recovery using synthetic test data.
- Infrastructure-level checks do not establish successful real OCR/AI extraction, extraction quality, report-to-draft persistence, or complete feature acceptance.
- Before enabling menu submissions, verify the approved AI provider configuration, hosted extraction, reviewed job/draft migrations, report-storage injection, and aligned processing, transport, lease, timeout, and retry budgets.
- Complete a controlled, authorized synthetic menu test covering submission, extraction, private report persistence, validated database drafts, and acknowledgement. Also test duplicate delivery, conflicting source hashes, report-storage failure, timeout/retry/DLQ handling, and cross-venue isolation.
- Confirm that extracted dishes remain `needs_review` and that no ingestion path bypasses human approval or automatically publishes dishes.
- Keep real submissions disabled until the complete controlled workflow and required operational configuration have been reviewed and accepted.
