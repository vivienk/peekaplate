# FE-06.4 staging acceptance: verifier and run handoff

## Current operator handoff — November 14, 2026

[PR #185](https://github.com/vivienk/peekaplate/pull/185) promoted #161's verification slice.
Staging API runs main `20e52a3`, Worker `0c60d064-c804-44a0-b4f3-3aaf44e64848`.
Main CI and five hosted health/denial checks passed. Migrations `20261112010000`
and `20261113010000` are applied; the new columns, restricted updates and RLS were verified.

Extraction Worker remains `60b99488-78f3-4d6a-a497-2ff1597f1ab7`. Service/signing/OCR/model
binding names are present. This is version/configuration evidence, not a fresh extraction
result or a verified current container-image digest.

The tester's confirmed account has temporary owner access only to the labelled synthetic
restaurant. Its identity mapping is private; no password or JWT is shared. A different
venue remains inaccessible. The approved Cloudflare invitation grants Developer Platform
Editor and was pending acceptance when sent. It covers existing platform resources across
the account; the authorized execution scope remains staging only.

All four menu/observation Queues and DLQs were empty and paused after deployment.
Menu delivery uses batch 1, concurrency 1, retry delay 60 seconds and retries 3.
No provider requests or Queue activation occurred during that setup. Refresh these
dated observations before execution. See [release evidence](https://github.com/vivienk/peekaplate/pull/185)
and [the operator guide](https://github.com/vivienk/peekaplate/blob/main/docs/fe064-staging-setup.md).

## Verifier scope

`scripts/verify-ingestion-e2e.mjs` reads an existing job and its drafts. It checks
tenant/job/row identities, expected successful outcome, released lease, exact
attempt-scoped archive key, nonempty unique drafts and initial review state.
Cross-venue and viewer probes require a genuine 403; 401 is authentication failure.
The viewer uses the identity-first `/verify` route. An owner's empty-body 400 proves
route presence only, not a successful verification, database migration or publication.

A supplied report must use schema/pipeline `(1,"2")` or `(2,"3")`. Its source hash,
status, count and producer draft/evidence identities must agree with the API. Raw
Python reports do not require `extraction_id`; producer IDs and physical row UUIDs
are separate. Evidence includes the inspected file's SHA-256. The tester must separately
record its authenticated R2 download key/hash: a local file cannot prove its own origin.
The production adapter owns complete extraction-schema validation and accuracy needs
independently reviewed reference answers.

Missing/malformed/failed jobs, empty drafts, report-only runs and a requested report
without a reader fail. Default expected outcome is `complete`; explicitly select
`--expected-status incomplete` for partial-result diagnostics. Run initial-draft
checks before correction/approval changes review state. PASS covers recorded checks
only; it does not close FE-06.4 or certify UI/provider behavior.

## Provider allowance

The verifier makes **zero provider requests itself**, while upstream usage is **unknown**:
`providerCallsConsumed: null`, `providerBudgetEnforced: false`.
`--max-provider-calls 2` records the approved allowance only. The former unused local
counter and synthetic-label helper did not limit consumer/Python requests and were removed.

Before intake or unpausing, establish actual request accounting and a bounded mechanism
that respects the two-request allowance, including retries, fallbacks and redeliveries.
A single menu/page, batch size 1 or a passing verifier does not enforce it. If the limit
cannot be guaranteed, retain the execution block until an explicit revised allowance
is recorded. This PR does not authorize extra paid requests.

## Tester sequence

1. Accept the Cloudflare invitation and verify the intended account. Use your own
   confirmed staging-app session; Cloudflare and application logins are separate.
2. Pin API/extractor/harness versions, migration evidence, fictional input hash, empty
   backlogs and actual request-budget mechanism. Keep observation collection paused.
3. Verify owner access on synthetic A and no access on B. Use a separately confirmed
   test alias without restaurant membership, or an authorized viewer's own session,
   for the second denied identity. Never borrow another person's password or JWT.
4. Agree the bounded 30-minute window, submit one fictional menu and enable only its
   menu delivery after prerequisites hold. Record actual provider attempts and R2 key/hash.
5. Supply `PEEKAPLATE_STAFF_TOKEN` and `PEEKAPLATE_VIEWER_TOKEN` in the local process
   environment. Do not commit them or put them in command arguments. Run:

   `node scripts/verify-ingestion-e2e.mjs --job-id <JOB_UUID> --venue-id <A_UUID> --cross-tenant-venue-id <B_UUID> --require-pr161 --max-provider-calls 2 --report-json <PRIVATE_DOWNLOADED_REPORT> --evidence-out <PRIVATE_EVIDENCE_PATH>`

6. Separately capture extraction quality, R2 persistence, correction/save/reload,
   evidence mapping, conflicts and authorization denials with expected/actual results.
7. Re-pause delivery, inspect source/DLQ backlogs without purging unknown work, end
   sessions and coordinate removal of temporary app membership. Preserve the linked
   staging Auth accounts. No production changes.

## Review evidence

The author's initial missing-#161/access audit is historical; #185 supersedes those
deployment/migration claims. Fresh authenticated provider/UI acceptance remains **NOT RUN**
until its controlled session records evidence. Re-review reproduced nine regression
failures before correction. Focused tests, real PostgreSQL/Worker checks and hosted
smoke results are recorded separately on the PR; mocked responses do not count as hosted acceptance.

---

## Reconciled author preflight

Author commit `3c9bd3c` independently corrected the viewer route and version pairing,
added optional expected-source pins and documented why the verifier cannot limit upstream calls.
The final implementation retains those source pins as `--expected-source-id` and
`--expected-source-hash`, adds identity/shape/privacy regressions and removes the unused
local guard instead of reporting a fabricated zero. Source/report mismatches fail.

The author's earlier read-only preflight saw API health 200 and protected routes 401.
That is an authentication signal; owner/viewer/cross-venue acceptance still needs fresh
authorized sessions. Private staff identifiers are omitted from this public document.
Cloudflare access is delegated through the approved invitation, so the tester can operate
existing staging resources after accepting it. No new extraction deployment is required
merely because GitHub Actions has no extraction runs; the existing operator deployment
is pinned above. Actual provider accounting/enforcement remains a separate gate before
paid execution; no large new budget subsystem is implemented by this read-only PR.


