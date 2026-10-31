# VIS-01: staging infrastructure and Python service

Updated October 28, 2026. For Teeyansh's [VIS-01 integration, PR #45](https://github.com/vivienk/peekaplate/pull/45).

## What is ready

Menu extraction has its own Queue and recovery Queue. It reuses the existing
private staging R2 bucket. These are separate from diner observations: a slow
menu job must not hold up diner events. The resources exist and their synthetic
delivery/storage tests passed. Both menu Queues are empty and paused.

The [Python HTTP service](../processing/src/peekaplate_processing/service.py)
adds the missing server layer around Mohammad's existing extraction code. It is
deployed on staging with hosted health, access and private source-read checks
verified. Teeyansh's unfinished PR is unchanged.
Queue and bucket provisioning alone does not enable full menu ingestion.

| Item | Name / binding | Provider ID or state |
| --- | --- | --- |
| Source Queue | `peekaplate-staging-menu-ingestion` / `INGESTION_QUEUE` | `ba21814fe726473b94696ff684d40c32` |
| Dead-letter Queue | `peekaplate-staging-menu-ingestion-dlq` | `70eb635f90e7458197b1d581e6c83284` |
| Existing R2 bucket | `peekaplate-staging-assets` / `INGESTION_REPORTS_BUCKET` | Private; `r2.dev` disabled; no public custom domain or CORS rule |
| Target API Worker | `peekaplate-api-staging` | Existing account `51eda1917fd22a9478808a82d2980741` |
| Python endpoint | `POST /extract` | `https://peekaplate-extraction-staging.vxkong.workers.dev/extract`; internal service authentication configured |

The Worker bindings in `backend/wrangler.jsonc` are now live on staging after
[the protected deployment](https://github.com/vivienk/peekaplate/actions/runs/40577213391)
succeeded. Provider readback verified both menu aliases. Preserve Hyperdrive, Auth, `TEAM_GITHUB_TOKEN` and both
observation bindings. No database, production resource, subscription or extra
bucket is created by this change; normal provider usage can still incur charges.

## Earlier release attempt — October 27, 2026

Historical snapshot: the pending states below are superseded by the hosted
acceptance record later in this document.

[PR #54](https://github.com/vivienk/peekaplate/pull/54) merged to develop and
[PR #55](https://github.com/vivienk/peekaplate/pull/55) promoted the reviewed
setup to main `58838e1b17321685d3b0869484b9a68437eea564`.
[Main CI](https://github.com/vivienk/peekaplate/actions/runs/40577056970) passed.
Deployment was attempted from that exact commit; it was not left untested.

| Check at 20:25 UTC | Actual result | Next action |
| --- | --- | --- |
| [Protected API deployment](https://github.com/vivienk/peekaplate/actions/runs/40577213391) | Waiting for an independent staging reviewer; the initiating account cannot approve itself. | Jeffin or Teeyansh approves the pending deployment. After it succeeds, verify the new `INGESTION_QUEUE` and `INGESTION_REPORTS_BUCKET` bindings. |
| Existing API | Health HTTP 200; October 24 version `fcb87dc6-f1c6-4f1c-84c9-542a8014520f` is still active. Its existing bindings and secret names are unchanged. | Do not claim the new aliases are live before provider readback. |
| Container deployment | Docker build completed, but Cloudflare rejected `/containers/me` with HTTP 401: Workers Paid is required. | Vivien activates the planned Workers Paid subscription; retry the same reviewed configuration. No upgrade was purchased here. |
| Partial extraction Worker | Upload created version `7c275801-96e3-4638-8aaa-8128f05fa062`, but its workers.dev route is disabled and health/extract URLs return 404. Settings readback returned provider HTTP 500. No working container service is established. | Reuse `peekaplate-extraction-staging` on retry; do not create a duplicate host or configure it as a healthy extraction endpoint. |
| Queue/R2 resources | Source/DLQ still exist, with the tested routing, private bucket and paused delivery. | Teeyansh can continue local integration now. Keep real submissions off until the consumer and full acceptance pass. |

The Paid-plan rejection blocks hosted Python extraction, not ongoing contract,
adapter, migration or local-test work. Protected service/signing/provider secrets
and real OCR/LLM extraction still need verification after host activation.
The complete menu-to-draft flow has not been tested in staging. No database
migration, production deployment or existing observation resource was changed.

## Queue settings and storage layout

| Setting | Source | DLQ |
| --- | --- | --- |
| Temporary consumer | HTTP pull `425bf49a283d4dd781262fc3055599cb` | HTTP pull `70b0900c75e84a40bc6af6297948e1bd` |
| Maximum retries | 3 after initial delivery | 100 for controlled recovery |
| Retry delay / visibility | 10 seconds / 30 seconds | 10 seconds / 30 seconds |
| Pull batch / retention | 10 / 86,400 seconds | 10 / 86,400 seconds |
| Delivery outside probes | Paused | Paused |

These pull settings are for infrastructure verification, not the future Python
consumer. **Paused messages still expire after 24 hours.** Leave real submissions
off until the processing flow is accepted. Do not attach a placeholder handler
that acknowledges work without processing it.

Use separate keys in the existing bucket:

```text
menu-ingestion/sources/<server-set tenant UUID>/<server-set job UUID>/source
reports/<server-set tenant UUID>/<server-set job UUID>/extraction.json
```

The first is the service's required input location; the second matches PR #45's
proposed report location. The Worker must authorize the venue, materialize the
source, compute its SHA-256, then enqueue the job. A prefix is an organization
rule, not an access-control boundary. Bucket credentials can read across its
prefixes; keep them server-side and limit them to the staging bucket.

## Python service contract

FastAPI handles HTTP and Uvicorn runs the service. An authenticated Cloudflare
hosting Worker reads the exact private R2 source; Python uses the existing HTTPX
library to download it through that fixed HTTPS origin, without redirects.
No R2 S3 keys are needed. The existing PyMuPDF/OCR/LLM pipeline still
does extraction. PostgreSQL job leases and draft writes remain Worker-owned;
the service has no database credential and cannot publish dishes.

Only the trusted Worker calls this endpoint. Headers must include
`Authorization: Bearer <EXTRACTION_SERVICE_SECRET>`, `X-Job-ID` and `X-Tenant-ID`.
The IDs must match the body and the source key.

Requests also require `X-Source-Capability`: a 15-minute HS256 grant binding the
tenant UUID, job UUID and source SHA-256. The authorized API Worker mints it with
`mintExtractionCapability` only after claiming the current job; mint a fresh
grant for each attempt, not when a job first enters a possibly delayed Queue.
The host verifies it before source reads and before forwarding extraction,
overwrites `X-Source-Hash` with the signed digest, and Python checks that digest
against the body and downloaded bytes. A valid service password alone cannot
read another job's source. The grant stays server-side and out of logs/fixtures.

Example body (synthetic IDs):

```json
{
  "job_id": "00000000-0000-4000-8000-000000000001",
  "tenant_id": "00000000-0000-4000-8000-000000000002",
  "source_type": "pdf",
  "source_url": null,
  "source_storage_key": "menu-ingestion/sources/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000001/source",
  "source_hash": "<64 lowercase hexadecimal SHA-256 characters of source bytes>",
  "idempotency_key": "<existing Worker job command key>"
}
```

- Inputs: `pdf` or `photo`, nonempty, at most 12,000,000 bytes; request at most
  8,192 bytes. Hash and file signature must match. URL/text intake is rejected;
  it needs a reviewed Worker materialization path, not arbitrary Python URL fetch.
- Output: validated existing `MenuExtractionResult` JSON, capped at 24,000,000
  bytes including its source snapshot. `complete`, `incomplete` and `failed`
  remain distinct; every extracted dish stays `needs_review`.
- Status: 401 bad credential; 403 job/key mismatch; 409 hash mismatch; 413 size;
  422 invalid/unsupported input; 429 busy with `Retry-After: 10`; 502 extraction
  unavailable/invalid report; 504 pipeline deadline. Exception details are hidden.
- One extraction runs per service process. Run one process/replica for the pilot;
  this lock is not distributed deduplication. The Worker's durable job claim,
  fencing and idempotent draft persistence remain necessary across retries.
- Each invocation uses a private temporary directory and kills its pipeline
  subprocess after 700 seconds. Cleanup follows success or failure. Provider
  calls use one-page batches and concurrency two. This is a processing cap, not
  a promise that a large menu completes in that time. A hosted front proxy and
  Worker deadline must leave room for R2 transfer and response serialization.
- `GET /health` proves service liveness/configuration, not R2/provider access or
  extraction accuracy. Access logs and public API documentation are disabled.

### Run and package

From the repository root:

```sh
uv sync --project processing --extra service --frozen
uv run --project processing --extra service --frozen python -m unittest discover -s processing/tests
docker build -t peekaplate-extraction:vis01-staging -f processing/Dockerfile processing
```

The Docker context allowlists source, README and lock/config files. It excludes
`.env`, tests, local inputs, outputs and installed environments. The image runs
as UID 10001. Supply secrets through the hosting platform, never build arguments
or committed env files. A local operator may use an ignored private env file:

```sh
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --memory=1g --cpus=1 -p 127.0.0.1:8080:8080 --env-file /private/path/extraction.env peekaplate-extraction:vis01-staging
```

Required service configuration: `EXTRACTION_SERVICE_SECRET` (unique random ASCII,
48+ characters) and `EXTRACTION_SOURCE_ORIGIN` set to
`https://peekaplate-extraction-staging.vxkong.workers.dev`. The hosting Worker
has the existing staging bucket binding and derives each source key from the
authenticated tenant/job path. It forwards only the service settings and the
existing pipeline's OCR/LLM variables into its container. Add that OCR and LLM configuration from its private
environment setup. Neither provider keys nor real test menus enter this repo.
The application API Worker needs the same service secret and the real HTTPS
`EXTRACTION_SERVICE_URL`. GitHub secrets are deployment inputs, not shared keys
that collaborators can retrieve. Use protected operator setup.

Cloudflare Containers is the selected staging host; configuration is in
`backend/wrangler.extraction.jsonc` and the authenticated bridge in
`backend/src/extraction-host.ts`. The account requires `durable_object`
scheduling, named `images.base`, and the direct Durable Object Container API.
The former helper class and application-level `max_instances` cannot be used
with this policy. Startup selects `standard-1` (4 GiB, 1/2 vCPU); `basic` is
not supported by the direct startup API, and `lite` has only 256 MiB.
The Worker always selects the fixed `staging-extractor` name, so application
routing uses one instance. This is not an account-wide billing limit.
One Uvicorn process runs; the native timeout stops the container 60 seconds
after the Durable Object becomes inactive, preserving active HTTP jobs.
An authenticated health probe waits up to 30 seconds before forwarding a
request. Readiness probes may retry; extraction POSTs are forwarded once.
The process lock is not
a replacement for durable job leases. The source-download route does not start
a container, and invalid credentials cannot start one either.
Its compatibility date matches the existing project's October 13 runtime;
the pinned local Wrangler binary cannot execute an October 27 compatibility
date. Advance that date with a separately verified runtime upgrade.

Vivien activated Workers Paid; explicit Container inventory now succeeds.
The scheduler repair in [PR #60](https://github.com/vivienk/peekaplate/pull/60)
is deployed from main `7bbe0d3729503f69a05c0f360ed09a41b9ecaf08`. The existing host and namespace
are reused, with one Container application. The existing uploaded image was
reused by immutable digest; no second large upload was necessary.
Service authentication, source-signing credentials and the API service URL are
configured in protected Cloudflare secret bindings. OCR.space is now configured
and its standalone provider check passed, as recorded below. The full extraction
endpoint still needs the approved AI configuration and its own hosted test.
Subscription readback is denied, so no total monthly bill is certified here.
Container usage is included up to the existing Workers Paid plan allowances,
with overage charges possible. See [current pricing](https://developers.cloudflare.com/containers/platform/pricing/).
This change does not buy or upgrade a subscription.

For a later reviewed release, build and deploy from its exact `main` commit with:

```sh
pnpm --filter @peekaplate/backend exec wrangler deploy --config wrangler.extraction.jsonc
```

Configure the hosting Worker's secret/provider variables using protected secret
inputs, and the API Worker's service URL/secret through its release process.
`EXTRACTION_SOURCE_SIGNING_SECRET` is a second, distinct random 48+ character
secret on the application API Worker and hosting Worker only. **Never forward
it to the Python container.** Its allowlisted environment intentionally omits
this key; the static service secret cannot mint job-scoped grants.
Never save secret values in either Wrangler config. Test the authenticated host
health, bad-secret denial, exact synthetic R2 source read and a real extraction
before connecting the menu consumer. A successful dry run does not prove hosting.

## Integration order and responsibilities

1. **Completed infrastructure:** protected API deployment, menu aliases, the
   hosted Python container and matched service/signing credentials are verified.
   Keep the actual queues paused until feature acceptance.
2. **Mohammad + Sai/Vivien:** OCR credential setup and a fresh OCR-only provider
   check are complete. Configure the approved existing AI provider privately,
   then test genuine full menu extraction and quality. The
   generic MENU_AI_* names refer to a configured provider, not a required new
   subscription. Standalone OCR-only checks can use OCR.space; the current full
   extraction endpoint also requires the AI step. Do not buy another service
   or silently change the extraction model for infrastructure acceptance.
3. **Teeyansh:** verify PR #45 before enabling jobs. Require the input key/hash
   above before enqueue; either reject URL/text clearly or materialize approved
   retrieval output first. PR #45 at `79b2e99` now proposes a 720-second transport
   timeout. Verify that the service's 700-second processing cap, cold startup,
   transfer and response fit the actual overall deadline, with matching
   proxy/queue/lease limits, batch size one and concurrency one for the pilot.
   Verify limits against the selected runtime rather than silently raising them.
   Mint and send the job-bound source capability after the durable claim, using
   the trusted job row's IDs/hash. Do not expose a browser-facing grant-mint route.
4. **Teeyansh + Jeffin:** land reviewed job/draft migrations and verify the R2 report
   adapter is injected into the actual Queue handler; merely binding R2 does not archive reports. Inject
   the adapter, enforce job/tenant scope, and retain validated output before
   durable draft completion/ACK. Test storage errors and conflicting retries.
5. **Operator + Teeyansh:** replace the temporary source pull consumer with the
   reviewed Worker consumer. Recheck actual backlog first; never purge. Preserve
   its DLQ and bounded retries. Do not attach both pull and push consumers or
   route menu jobs to the observation handler. Leave the DLQ for controlled recovery.
6. **Teeyansh with reviewers:** test an authorized synthetic menu through upload
   → Queue → service → private report → database drafts → ACK. Also test duplicate
   delivery, conflicting source hash, storage failure, timeout/retry/DLQ and
   cross-venue denial. Then enable real submissions. PM approval and representative
   extraction-quality checks remain separate from infrastructure acceptance.

Steps 2–4 can proceed in parallel after agreeing the interface; step 6 needs all
of them. No unfinished feature PR was merged to achieve this setup.

## OCR credential and provider check — October 28, 2026

The existing `OCR_SPACE_API_KEY` is now stored in two protected locations:

- GitHub repository `vivienk/peekaplate`, environment **staging**, Actions secret
  `OCR_SPACE_API_KEY`; metadata confirms the October 28 update.
- Cloudflare Worker **peekaplate-extraction-staging**, secret-text binding of the
  same name. Readback confirmed the binding and preserved every other host binding.

No value appears in source, frontend variables, test fixtures, logs or operator
files. The existing host allowlist forwards this variable into Python; it does
not forward the source-signing secret. The focused host regression checks both.
GitHub secrets are encrypted deployment inputs, not credentials collaborators can
retrieve. The current **Deploy staging Worker** workflow deploys the API, not this
separate extraction host. The authorized operator applied the host secret directly;
storing the GitHub secret did not trigger a deployment or enable collection.

**Provider check — PASS:** the existing Python `extract_source` / `OCRSpaceClient`
path made a fresh OCR.space Engine 3 request for a generated three-item menu image.
It completed in **4.654 seconds**, returned `complete`, reported no cache hit, and
contained Tomato Soup / 7.50, Garden Salad / 9.00 and Grilled Chicken / 14.00.
Only fictional test content was uploaded. This proves the supplied credential's
OCR use on that image, not real-menu accuracy or successful hosted job processing.

The secret update created Worker version `7b505396-501e-4d46-870f-d6dbd87655ee`
without changing its main `7bbe0d3` application code, Container image or internal
authentication credentials. Both menu queues remain paused and the temporary
HTTP pull consumers remain in place. No database migration was applied here.

**Still pending:** AI provider URL/key/model configuration for the current full
`/extract` pipeline; review and hosted verification of the job/draft migration;
the real Worker consumer release and complete source-to-report-to-drafts/ACK tests.
Teeyansh can prepare those cases in parallel. Before trusting the new read-only
verification utility, fix its `79b2e99` zero-check path: with no token or report,
it returns `passed: true` and no checks. Mark that run failed or incomplete and
add a regression. Keep production and real restaurant collection off until their
separate release acceptance.

## Hosted acceptance — October 27, 2026 (Phoenix)

The passing service run completed at `2026-10-28T03:43:48.367Z` (UTC), and the
remote Queue/R2 run began at `2026-10-28T03:45:07.923Z`. These are infrastructure
checks using synthetic bytes, not restaurant extraction-quality acceptance.

| Deployed component | Recorded identity |
| --- | --- |
| API application code | Main `58838e1`, protected run [40577213391](https://github.com/vivienk/peekaplate/actions/runs/40577213391) |
| Extraction application code | Main `7bbe0d3729503f69a05c0f360ed09a41b9ecaf08` via [PR #60](https://github.com/vivienk/peekaplate/pull/60); post-merge CI passed |
| Active API version after private configuration | `12dd701c-3d5a-4bf3-95f5-02882da715a6` |
| Active extraction version after private configuration | `313da013-bd3d-4d6d-bf1e-af3e9e4911b3` |
| Container application / namespace | `cba39d4d236043019b3f1491021c1539`; existing host name reused |
| Python image digest | `sha256:01d8b0d9d34e8aa38b26872c73c6abef47bc097ac2813c1aea917e7178eba5ca` |

**Service and private source checks — PASS:** authenticated Python health 200
(5.816 seconds in the passing run); missing/wrong credentials 401; missing or
expired job grants, wrong job/digest and mismatched body scope 403; query-key
override 400; invalid body 422; exact signed private-R2 read 200/no-store.
The real hosted Worker → Python → signed R2 relay round trip rejected unsupported
synthetic bytes with 422 before any provider call. A valid grant whose claimed
hash differed from the stored bytes returned 409. The exact owned test object
was deleted and its absence verified with 404.

**Queue/R2 checks — PASS:** actual source delivery → cloud R2 write/read →
individual ACK; retry attempts 0/1/2/3 → configured DLQ → individual recovery
ACK; concurrent create-only R2 writes had exactly one winner. Both queues ended
with zero backlog and paused delivery; test objects were removed and absence
verified. Observation settings were unchanged. Temporary remote development
sessions were stopped; provider inventory still contains only the two existing
application Workers.

**Existing API checks — PASS:** both team read APIs returned 200 using the
operator's own GitHub identity, and 401 without authentication. API health is
200; existing Auth, Hyperdrive, observation bindings and TEAM_GITHUB_TOKEN were
preserved. No Supabase schema/data or production deployment changed.

The host has EXTRACTION_SERVICE_SECRET and EXTRACTION_SOURCE_SIGNING_SECRET;
the API has the matching two plus EXTRACTION_SERVICE_URL. Values were generated
in memory and written only to protected Cloudflare secret bindings, not files,
chat or Git. The signing key is never forwarded to Python. Opening the host in
a browser without service authentication returns 401 by design. A partial
credential update requires keeping the queues paused and reapplying the full
matched set; allow an old test container to go idle before retesting. Credentials
are opaque in provider readback; never treat a list of names as proof of pairing.
The successful signed read and Python round trip establish the tested pairing.

**NOT RUN:** real OCR/AI extraction (provider keys absent), PR #45's report
adapter/database draft persistence, the complete authenticated upload-to-ACK
flow, representative load/accuracy and production. This setup adds neither a
placeholder feature consumer nor fake successful extraction results.

## Evidence correction and local checks

The earlier 18:57 UTC Queue probe did use Cloudflare's real HTTP pull API,
but its R2 steps and the 19:38 UTC source-relay probe ran with local Wrangler
and forceLocal enabled. They established local behavior, not hosted R2 access;
their earlier remote-R2 claims are superseded by the genuine remote runs above.
The first hosted reader returned 404 for a fixture the local writer reported
as created, exposing that test-helper mistake. Remote-mode fixture writes and
an independently deployed reader then agreed. For provider acceptance, use an
actual remote Worker or explicit remote CLI operation and independent readback;
a remote flag in a local emulator is not proof of destination.

The local Docker smoke remains valid: UID 10001, read-only filesystem, health
200, unauthenticated extraction 401, invalid request 422 and disabled public
OpenAPI 404; the test container was removed. The unchanged Python package's
earlier 111-test run is local evidence only. The scheduler repair passed 69
TypeScript tests, 57 script tests, 73 SQL assertions, 14 database integration
tests, builds, generated binding checks and 13 focused host tests. Readiness
retries, single-POST forwarding, concurrent startup and failure recovery are
covered locally; no production-readiness claim follows from those checks.

Provider references: [scheduling and runtime configuration](https://developers.cloudflare.com/containers/configuration/scheduling-policy/),
[direct Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[instance sizes](https://developers.cloudflare.com/containers/platform/limits/),
[pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/),
[pause/retention](https://developers.cloudflare.com/queues/configuration/pause-purge/).
