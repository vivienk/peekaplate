# FE-06.4 staging setup and controlled run

This narrow release promotes the merged #161 private draft/photo verification
runtime and its unchanged migration. It does not promote unrelated develop
imports, owner actions, cron cleanup, frontend changes or provider configuration.
The retained retention helper is required by the original integration tests;
there is no scheduler or retention configuration activating it in this release.

## Deployment baseline

The November 14 operator audit observed API version
`50223a8f-e9d5-46ec-9de0-10a88abd9664` from main `2fabd48`, and extraction Worker
version `60b99488-78f3-4d6a-a497-2ff1597f1ab7`. The latter matches the version in
the previous successful fictional Vision V4 run. Its service/source signing,
AI provider URL/key/model and OCR secret bindings are present. Secret presence
does not establish fresh provider validity or representative accuracy. The current
container listing did not expose an image digest; do not invent one from the
source branch. Record exact final API/main version and hosted evidence on the
release PR after deployment.

Use the existing API at
`https://peekaplate-api-staging.vxkong.workers.dev` and extraction service at
`https://peekaplate-extraction-staging.vxkong.workers.dev`. A protected health
response is an authentication signal, not an extraction acceptance result.
No new hosting, bucket, subscription or Cloudflare operator account is needed
for the tester. Sai operates infrastructure; the tester uses a staff session.

## Migration and identity preflight

Inspect the hosted ledger and actual columns/grants before applying only
`20261113010000_menu_verification_lifecycle.sql`. A newer migration entry does
not prove this older missing entry ran. Preserve the accepted migration bytes;
do not apply unrelated pending migrations or run a destructive down migration.
The photo-column UPDATE grants are required by approval/rejection. Record the
history entry, four new columns and restricted runtime privileges afterward.

Each tester creates and confirms their own account using the
[staging auth entry](https://peekaplate-console-staging.pages.dev/owner-auth).
Resolve the confirmed Supabase UUID before granting temporary owner access to
the existing synthetic venue `4c1b9f0d-cc45-4229-828e-e239b6906ac8` only. Save the
previous membership state privately and restore it afterward. Signup does not
grant a restaurant. Never share a personal password, staff JWT or service-role
key through GitHub credentials. Real identity mappings stay in the private test
handoff, outside public fixtures and evidence.

Use a separately confirmed, denied identity and a different venue for negative
checks. A 401 means identity failed; it cannot count as a 403 authorization denial.
For a non-mutating viewer probe use the identity-first #161 `/verify` handler:
an authorised owner with an empty JSON body receives 400, while a viewer receives
403 before body validation. A 400 presence probe alone proves neither migration
compatibility nor the verification lifecycle. Read real draft/photo metadata and
exercise valid versioned commands during the approved synthetic run.

## Queue and provider window

Reuse `peekaplate-staging-menu-ingestion` and its dedicated `-dlq`, the existing
API consumer, private staging R2 binding and database. The audit found all four
menu/observation Queues and DLQs paused with zero backlog. Menu delivery is
batch-size 1, concurrency 1, retry-delay 60 seconds and maximum retries 3. Paused
messages still expire. Do not purge unknown work or redirect the observation
pipeline. Leave observation collection paused throughout this menu test.

The proposed run is one labelled, one-page fictional menu in a coordinated
30-minute window, with at most two actual provider requests total. Count provider
retries, fallbacks and repeated deliveries. A local verifier counter cannot
enforce requests made by the Queue consumer/Python service. Pin the actual
request-budget mechanism before intake or unpausing delivery; otherwise retain
the block and perform read-only preflight only. No paid calls or Queue activation
are authorised by a passing verifier or this document.

Before the window, record the source SHA-256, API/extractor versions, migration
and identity checks, actual request budget and empty/isolated backlog. Stop on
unexpected work or budget uncertainty. Afterward pause delivery, confirm source
and DLQ backlog, restore membership and retain labelled evidence. Do not announce
hosted acceptance until expected and actual results agree.

## Evidence boundary

Capture request/job/extraction IDs, source and report hashes, provider attempts,
draft and evidence identities, correction/save/reload results, version conflicts,
owner/viewer/cross-tenant denials and cleanup. Bind the report to the requested
job/source; an equal draft count is insufficient provenance. Accept only matching
schema/pipeline pairs `(1, "2")` or `(2, "3")`. Never commit tokens, real emails,
raw provider errors or personal menu material. Local tests and historical hosted
results remain distinct from a fresh FE-06.4 execution.

The tester owns the current harness in #184; the operator release supplies the
deployed #161 contract and migration. Keep report validation, actual provider-call
accounting and valid authorization probes aligned before calling that run ready.
