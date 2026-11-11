# Staging ingestion release candidate

This candidate promotes the merged extraction PR58, orchestration PR45 and
architecture proposal PR44 onto the main release baseline. It adds the missing
authenticated source-upload API and a main-SHA-guarded extraction deployment.
It does not configure production or supply an owner upload screen.

## Reconciled November 10 release scope

The release retains the current main publication, review, owner-report and diner
integrity code. It also carries PR122's connected Save/Saved screens and PR115's
corrected recovery procedure. Saved refreshes use the current dish revision without
another shortlist-view event; keyboard removal retains a usable focus target.

The Python service uses vision-first extraction with OCR-plus-image fallback after
provider failures. Its V1 transport marker remains compatible while
`configuration.extraction_mode` identifies actual direct vision; this is not OCR
evidence. Raw local vision attempts are excluded from the hosted artifact bundle.
The earlier opt-in-only PM note remains a release decision: the final reviewed
candidate requires explicit human approval of this vision-first staging behavior.

Local review verified 501 guarded offline Python tests and wheel/sdist packaging,
213 SQL assertions and 88 real Worker/PostgreSQL tests. Two Save browser regressions
failed before correction and passed afterward. Final combined checks and hosted
acceptance are recorded in [PR118](https://github.com/vivienk/peekaplate/pull/118),
including exact commit/version IDs, timings, Queue state and cleanup. Local tests
do not establish hosted provider accuracy or a completed rollback drill.

Reuse the existing staging Worker, extraction host, Queue/DLQ and private asset
bucket. Keep observation delivery paused and run menu delivery only within the
approved synthetic acceptance window; restore its paused state afterward. Verify
the live migration history before applying anything. Existing applied migrations
are never modified or reapplied blindly.

## Upload contract

The staging API enables `global_fetch_strictly_public` so its authenticated HTTPS
request reaches the extraction Worker on the same account. Without it Cloudflare
returns error1042 before the extraction service or model runs. This staging-only
flag preserves the existing service authentication, signed source capability and
production configuration. See [Cloudflare fetch routing](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).

`POST /venues/{venueId}/menus/uploads` is available only in local/staging.
Send a valid staff bearer token, `Idempotency-Key` (16–128 ASCII letters, digits,
underscore or hyphen), and raw PDF, PNG or JPEG bytes with the matching MIME type.
The server verifies identity and current writable venue membership before reading
the source. It bounds the body at12,000,000 bytes, checks the file signature,
computes SHA-256, creates/reuses a job, writes its canonical private source key,
then queues the job. No caller-supplied storage key, tenant or hash is trusted.
Successful dispatch returns202 with the job. Failed storage does not dispatch.
Retry with identical bytes and the same idempotency key after a transient failure.
Extraction drafts remain unapproved; this endpoint cannot publish.

## Required release order

1. Obtain review of the exact candidate commit and passing CI, including the
   Linux Python suite and Docker-backed migration/database checks. Follow
   [CONTRIBUTING](../CONTRIBUTING.md) and [ADR0012](adr/0012-main-environment-promotion.md).
2. Merge the reviewed candidate into main. Record the exact main SHA and reviewer.
3. Verify the staging database identity and apply the forward migration
   `20261026220000_menu_ingestion_drafts.sql` through the established migration
   process. Record the migration/version and runtime-role read/write checks.
4. Run **Deploy staging extraction** from main with `expected_sha` equal to that
   reviewed main SHA. Existing Cloudflare runtime secrets are preserved. Confirm
   the host and container versions and artifact-storage acceptance together.
5. While delivery is paused, remove the old HTTP pull consumer and deploy the API
   from the same main SHA with its checked-in menu Worker consumer. Keep menu queue delivery paused until
   the migration, service, signed source access and staff identity are verified.
6. Read back the configured menu consumer: batch size1, concurrency1, batch
   timeout1s, three retries, default retry delay60s and the existing menu DLQ.
   Lease-aware per-message retry may delay through the15-minute fence. Verify
   no unexpected backlog, then resume only the menu queue for controlled acceptance.
   Observation queue state must remain unchanged. The existing720s extraction
   transport timeout is a bounded happy-path budget, not proof all700s model runs
   plus startup/source/archive overhead fit; timeout/retry testing remains required.
7. With a real staging staff session for a disposable test venue, upload the
   synthetic two-dish PDF, poll the authenticated job endpoint and read its drafts.
   Verify source/report hashes, immutable artifact identity, database job/draft
   linkage, review-required state and successful ACK. Repeat the same submission
   to prove idempotency; reject a different-venue session. Record retry/DLQ cases
   separately from the happy path. Remove only the owned test artifacts/data using
   an authorized administrative path; runtime has no DELETE grant.

## Evidence boundary

The November7 live test of the earlier deployed extraction service returned
HTTP200, status complete, two expected review-required dishes, model
`gemini-3.8-flash`, zero reported errors, and36s extraction time. Its synthetic
source was removed and read back as404. That test did not deploy this candidate,
exercise its new upload API, or prove database persistence/queue acknowledgement.

Local candidate checks cover types, unit tests, source hash/type/size checks,
authorization boundaries and storage-before-dispatch ordering. Hosted owner
acceptance remains NOT RUN until the release prerequisites above are satisfied.
