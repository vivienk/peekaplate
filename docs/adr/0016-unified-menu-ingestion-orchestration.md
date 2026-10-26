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

7. Select the execution service, queue, storage bindings, and job-state
   persistence only after confirming the supported deployment architecture.
   A queue alone does not execute the Python processing package.

8. Test contract compatibility, source validation, tenant isolation, job
   transitions, retries, duplicate submissions, partial failures, evidence
   integrity, and the end-to-end path from submission through review.

## Consequences

- The existing processing and handoff implementations remain the preferred
  reusable boundaries.
- The implementation requires an explicit job lifecycle and a defined
  Python execution mechanism.
- Queue and object-storage reuse cannot be assumed from the existing
  observation-specific bindings.
- Draft extraction remains separate from dish revision persistence and
  publication.
- Python processing tests and a pinned Python CI job must be integrated into
  the repository verification workflow.

## Open Questions

- Which supported service will execute Python processing in deployed
  environments?
- Should menu ingestion use dedicated queue and storage resources, or can
  existing resources be safely shared?
- Where will job state, retry metadata, and validated results be persisted?
- What are the agreed limits, retention policy, timeout, and retry budget?
- How should duplicate submissions be identified and handled?
- Which owner approves the deployment, resource, and operational-cost
  decisions?

## Verification

- Existing VIS-04 adapter tests continue to pass.
- Python processing tests run in the documented environment.
- Contract tests cover supported and unsupported versions, evidence spans,
  Unicode offsets, and partial failures.
- Integration tests verify authorization, tenant isolation, job lifecycle,
  duplicate protection, and persistence boundaries.
- An end-to-end test demonstrates submission, processing, validated draft
  output, and human-review gating without automatic publication.
