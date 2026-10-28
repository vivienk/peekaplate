# VIS-01: staging infrastructure and Python service

Updated October 27, 2026. For Teeyansh's [VIS-01 integration, PR #45](https://github.com/vivienk/peekaplate/pull/45).

## What is ready

Menu extraction has its own Queue and recovery Queue. It reuses the existing
private staging R2 bucket. These are separate from diner observations: a slow
menu job must not hold up diner events. The resources exist and their synthetic
delivery/storage tests passed. Both menu Queues are empty and paused.

The [Python HTTP service on develop](https://github.com/vivienk/peekaplate/blob/develop/processing/src/peekaplate_processing/service.py)
adds the missing server layer around Mohammad's existing extraction code. It is
container-ready, not a deployed service. Teeyansh's unfinished PR is unchanged.
Queue and bucket provisioning alone does not enable full menu ingestion.

| Item | Name / binding | Provider ID or state |
| --- | --- | --- |
| Source Queue | `peekaplate-staging-menu-ingestion` / `INGESTION_QUEUE` | `ba21814fe726473b94696ff684d40c32` |
| Dead-letter Queue | `peekaplate-staging-menu-ingestion-dlq` | `70eb635f90e7458197b1d581e6c83284` |
| Existing R2 bucket | `peekaplate-staging-assets` / `INGESTION_REPORTS_BUCKET` | Private; `r2.dev` disabled; no public custom domain or CORS rule |
| Target API Worker | `peekaplate-api-staging` | Existing account `51eda1917fd22a9478808a82d2980741` |
| Python endpoint | `POST /extract` | Local/container implementation; hosted URL and secret not configured |

The Worker bindings are declared in `backend/wrangler.jsonc`, staging only.
They become live only after a reviewed `main` release passes the protected
staging deployment. Preserve Hyperdrive, Auth, `TEAM_GITHUB_TOKEN` and both
observation bindings. No database, production resource, subscription or extra
bucket is created by this change; normal provider usage can still incur charges.

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
  calls use OCR-plus-image input, one-page batches and concurrency two. This is a processing cap, not
  a promise that a large menu completes in that time. A hosted front proxy and
  Worker deadline must leave room for R2 transfer and response serialization.
- `GET /health` proves service liveness/configuration, not R2/provider access or
  extraction accuracy. Access logs and public API documentation are disabled.

### Private review artifact retention

The follow-up service explicitly selects `ocr_image`. All three modes remain
CLI/Python options; the public HTTP request body above is unchanged. The public
response remains `MenuExtractionResult`, not a new review/UI envelope.

The host negotiates internal `X-Extraction-Artifact-Bundle: 1` with Python. Before
temporary cleanup, Python captures the validated report, final `timings.json` and
private `review-suggestions.json`. The bounded internal version1 bundle is limited
to32 MB (report24 MB, suggestions8 MB, timing1 MB individual read limits). Missing
or mismatched artifacts fail closed rather than being silently dropped. Expected
CLI exits0/2 preserve complete/partial reports; exit1 is retained only with an
actual failed report, still subject to source/schema validation. A process timeout
without final artifacts remains504, not an invented successful bundle.

After the existing service credential and tenant/job/hash grant checks, the host
writes a create-only object in the same private bucket:

```text
menu-ingestion/review-artifacts/<server-set tenant UUID>/<server-set job UUID>/<server-generated attempt UUID>/bundle.json
```

The key and scope never come from browser fields. Repeated attempts receive
separate keys; conditional writes cannot overwrite history. No general bucket
write route is exposed. A storage failure/collision cannot return extraction
success. The response's existing `configuration` metadata carries
`private_review_artifact` (version, private key and exact stored-byte SHA-256),
not the private suggestions themselves. It is a reference, not authorization or
a public URL. No source-signing key or R2 credentials enter Python.

The stored bundle retains the original source snapshot/hash and actual page-image
metadata. Rendered image `path` values are local-run references, not cloud URLs;
authorized reviewers inspect the retained original source/page. Precise dish
rectangles and image-backed RES fields are not invented. Authenticated reviewer
asset delivery remains with VIS-01/RES owners; do not expose bucket keys publicly.
No retention period is invented here; apply approved private-evidence access,
retention and deletion policy before enabling real jobs.

This archive does not replace PR45's job/report storage, database completion,
lease/fencing, queue ACK or review corrections. Host and container must be
released together after owner review: an old unbundled service cannot satisfy
new retention guarantees. Mocked storage tests and package/dry-run builds do not
prove hosted R2/Container behavior, memory/disk limits or the full700s budget.
No deployment or resource/subscription change is part of this follow-up.

### Run and package

From the repository root:

```sh
uv sync --project processing --extra service --frozen
uv run --project processing --extra service --frozen python -m unittest discover -s processing/tests
docker build -t peekaplate-extraction:vis01-staging -f processing/Dockerfile processing
```

The Docker context allowlists source, README and lock/config files, then explicitly
denies nested `.env`/`.env.*`, private local notes, JSONL history and bytecode caches
after the source allowlist. Tests, local inputs, outputs and installed environments
remain excluded. Static rule regressions do not substitute for a real image build. The image runs
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
environment setup. No provider keys or new private live-run inputs/outputs are
added by this follow-up; previously authorized source fixtures have their own
provenance notes. Never copy private evaluation folders into a release.
The application API Worker needs the same service secret and the real HTTPS
`EXTRACTION_SERVICE_URL`. GitHub secrets are deployment inputs, not shared keys
that collaborators can retrieve. Use protected operator setup.

Cloudflare Containers is the selected staging host; configuration is in
`backend/wrangler.extraction.jsonc` and the authenticated bridge in
`backend/src/extraction-host.ts`. It uses one `basic` instance (1 GiB memory,
1/4 vCPU), one fixed Durable Object name, one Uvicorn process, and sleeps after
60 idle seconds. The SDK keeps active requests alive; the process lock is not
a replacement for durable job leases. The source-download route does not start
a container, and invalid credentials cannot start one either.
Its compatibility date matches the existing project's October 13 runtime;
the pinned local Wrangler binary cannot execute an October 27 compatibility
date. Advance that date with a separately verified runtime upgrade.

The host is not yet deployed. The initial missing `containers:write` scope is
resolved: the scoped Wrangler login succeeded and retained existing Worker/Pages
access. The account is still on Free; **Vivien will activate the $5/month Workers
Paid plan**. Keep this configuration and wait for that upgrade; no alternative
hosting provider or automatic purchase is needed. The explicit-account Container
inventory currently returns the expected Paid-plan eligibility denial.
`/workers/standard` reported true despite that denial, so that flag must not be
treated as proof of paid billing activation. Subscription readback was denied.
Container usage is included up to the existing Workers Paid plan allowances,
with overage charges possible. See [current pricing](https://developers.cloudflare.com/containers/platform/pricing/).
This change does not buy or upgrade a subscription.

After Vivien's upgrade is active and the service is released from reviewed
`main`, the operator deploys with:

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

1. **Sai / deployment reviewer:** release the binding-only `main` change through
   the existing staging approval gate. The actual queues can remain paused.
2. **Mohammad + Sai/Vivien:** confirm Vivien's Workers Paid upgrade is active,
   deploy the Cloudflare container host, configure
   the service secret and OCR/LLM credentials, and verify genuine source extraction. The
   hosted service and real provider accuracy are not covered by local tests.
3. **Teeyansh:** align PR #45 before enabling jobs. Require the input key/hash
   above before enqueue; either reject URL/text clearly or materialize approved
   retrieval output first. Its current optional-hash/URL admission and 120-second
   extractor timeout are incompatible with this bounded service. Configure a
   measured overall budget (for example 720 seconds at the Worker, with matching
   proxy/queue/lease limits), batch size one and concurrency one for the pilot.
   Verify limits against the selected runtime rather than silently raising them.
   Mint and send the job-bound source capability after the durable claim, using
   the trusted job row's IDs/hash. Do not expose a browser-facing grant-mint route.
4. **Teeyansh + Jeffin:** land reviewed job/draft migrations and the R2 report
   adapter. PR #45 currently calls `processQueueBatch(client, batch, extractor)`
   without `reportStorage`; merely binding R2 does not archive reports. Inject
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

## Verification record

The live provider probe at `2026-10-27T18:57:46.560Z` passed using synthetic
run `bf506728-7747-40d4-8e7d-06333f1b8cd0`:

- Source delivery → R2 write/read verification → individual ACK.
- Four delivery attempts (`0, 1, 2, 3`) → configured DLQ → individual recovery ACK.
- Two concurrent R2 create-only writes: exactly one won; later conflicting writes
  could not replace it. This tests R2 behavior, not PR #45's report adapter.
- Source/DLQ backlog zero; both paused again; exact test objects deleted and
  absence verified. Observation queue/consumer settings remained unchanged.
- Bucket remained private. No restaurant rows, database schema or production data changed.

The probe used temporary local Wrangler code with a remote R2 binding and
Cloudflare's HTTP pull API. It exercised real provider resources without deploying
a placeholder application consumer. The source/report paths above were not
created by this probe: its files used `infra-probes/vis01/<run-id>/` only.

Local service tests use synthetic storage/provider doubles; they do not certify
hosted extraction, Queue-to-database integration or OCR/LLM accuracy. See the PR's
verification record for final commands, counts and runtimes.

The final local Docker smoke passed in 3.753 seconds: non-root UID 10001,
read-only filesystem, health 200, unauthenticated extraction 401, authenticated
invalid request 422 and disabled public OpenAPI 404; the container was removed.
A separate actual workerd + remote R2 check passed in 3.112 seconds at
`2026-10-27T19:38:10.577Z`: exact synthetic source bytes 200/no-store,
missing/wrong credentials 401, a job-A grant requesting job B 403, a digest
outside the signed grant 403, key override 400, then
exact cleanup and 404 readback. This probe did not start a hosted Container or
call OCR/LLM providers. The Python suite passed 111 tests in 4.538 seconds,
including 22 service tests; the host's nine TypeScript checks passed in 502 ms.
The partial-result regression uses a real child process that writes an
incomplete needs-review report and exits 2; the service preserves it as HTTP 200.

Provider references: [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/),
[pause and retention](https://developers.cloudflare.com/queues/configuration/pause-purge/),
[DLQ routing](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/),
[Containers setup](https://developers.cloudflare.com/containers/get-started/),
[FastAPI containers](https://fastapi.tiangolo.com/deployment/docker/).
