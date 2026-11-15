# Cutout to 3D with Tripo

The private processing path is **PR25 review cutout → verified PNG → Tripo image-to-model
task → bounded GLB download → local human review**. It does not change the diner preview,
publish a model, deploy a service, or claim accurate serving dimensions. The existing
2.5D cutout and original photo remain available during preparation, generation and failure.

## Run locally

Use the processing Python 3.12 environment with the existing Pillow dependency. No new
Python dependency is required. These commands run from the repository root on macOS/Linux.

```sh
# No network, key or credits: verify the processor manifest and copy the exact PNG.
PYTHONPATH=processing/src python -m peekaplate_processing.generate_model prepare \
  --review-dir /path/to/pr25/review_asset_directory \
  --output-dir /path/to/new/tripo-job

# Configure TRIPO_API_KEY privately in this process, never in VITE_* or command history.
# This step uploads the image to Tripo and can consume provider credits.
PYTHONPATH=processing/src python -m peekaplate_processing.generate_model run \
  --job-dir /path/to/new/tripo-job --wait-seconds 600

# Same run command resumes polling/download for the saved task; it does not submit again.
# Review via localhost (not file://).
python -m http.server 5181 --bind 127.0.0.1 --directory /path/to/new/tripo-job
```

Open `http://127.0.0.1:5181/`. The review page shows the source cutout until a model is ready.
Reload after a CLI run changes the job state. Once ready, drag to orbit the 3D model,
compare with its exact source, reset the camera, or download the GLB. The viewer loads
Google's pinned model-viewer 4.4.0 module from its CDN; blocked/offline/module/model failure
retains the source image. Review-page delivery requires internet for that viewer module.
The source PNG, original photo and downloaded GLB remain local.

The default input is `cutout.png`, not a lossy WebP or a new generated picture. Use
`--source presentation` explicitly to start from the earlier `presentation.png` candidate
instead. Both choices retain the dish/revision and original review-manifest hash. An output
directory is create-only: preparation never overwrites another job.

## Private HTTP API

`peekaplate_processing.model_service:create_app` exposes the same pipeline over FastAPI.
Use the existing processing `service` optional dependencies (FastAPI, HTTPX, Uvicorn).
The API is separate from the extraction service and existing Cloudflare Worker routes.
It is a trusted-backend interface, **not a browser-facing owner API**: the calling backend
must authorize the user before calling it. No service token belongs in frontend code.

Configure these process variables privately; dotenv files are not loaded automatically:

- `TRIPO_SERVICE_TOKEN`: dedicated ASCII secret, at least 48 characters, no whitespace.
- `TRIPO_TENANT_ID`: canonical UUID owned by this service instance. Requests cannot select a tenant.
- `TRIPO_REVIEW_ROOT`: absolute private directory on persistent local storage.
- `TRIPO_API_KEY`: server-only Tripo key. Missing key returns 503 before job creation.

Register verified PR25 review bundles through the trusted server/operator filesystem at
`$TRIPO_REVIEW_ROOT/$TRIPO_TENANT_ID/reviews/<review_asset_id>/`. The manifest's asset ID
must match the folder name. The API accepts neither filesystem paths nor source URLs.
Jobs persist below the same tenant's `jobs/<job_id>/` directory. Do not place this root
inside a public static directory or let untrusted users write it.

```sh
PYTHONPATH=processing/src python -m uvicorn \
  peekaplate_processing.model_service:create_app --factory --host 127.0.0.1 --port 5182
```

All job/artifact routes require `Authorization: Bearer <TRIPO_SERVICE_TOKEN>` and use
`Cache-Control: no-store`. `/health` exposes only service/configuration readiness.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/v1/model-jobs` | Prepare and schedule generation; 202 |
| GET | `/v1/model-jobs/{job_id}` | Read saved status, attempt status and artifact paths; no provider calls |
| POST | `/v1/model-jobs/{job_id}/resume` | Explicitly resume polling/download; 202 |
| GET | `/v1/model-jobs/{job_id}/artifacts/source.png` | Exact verified input PNG |
| GET | `/v1/model-jobs/{job_id}/artifacts/fallback.jpg` | Verified original image |
| GET | `/v1/model-jobs/{job_id}/artifacts/model.glb` | Hash-checked GLB, only when ready |

Create body (8 KB maximum, unknown fields rejected):

```json
{
  "job_id": "22222222-2222-4222-8222-222222222222",
  "review_asset_id": "review_b2f135ce8784a517ca9cf1f3fbc8fcbf",
  "source": "cutout"
}
```

The caller chooses a stable UUID per deliberate generation request. Repeating the same
job ID/input returns 200 with saved state and never schedules another charge. Reusing
that ID with another review asset or variant returns 409. Terminal/ready jobs return their
saved state on resume; ambiguous submissions return 409 and require reconciliation.
Status responses omit provider task IDs, keys, signed URLs and local paths.

Background work runs off the HTTP event loop, with two active attempts per process and
per-job filesystem locks across processes. A full process returns 429; a prepared job may
already exist, so inspect its status and explicitly resume it after capacity is available.
Concurrent work on one job returns 409. This is a bounded local worker, not a distributed
queue: persistent storage is required, and after a restart the caller must explicitly resume
interrupted jobs. `attempt_status: incomplete` means the attempt encountered an error;
inspect the pipeline `status` before resuming. No automatic retries of ambiguous submissions.

Tenant isolation is enforced by server configuration and separate token/root namespaces,
not by trusting tenant fields from clients. This implementation does not add public routing,
owner-session authorization, fleet scheduling, automatic recovery after restart or deployment.

## Provider request and lifecycle

Verified against Tripo documentation on November 12, 2026:

- [Upload](https://developers.tripo3d.ai/en/docs/files): multipart PNG to `POST /v3/files`.
- [Image to model](https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard):
  `POST /v3/generation/image-to-model`, model `v3.1-20260211`, textured PBR GLB,
  standard texture quality, texture model `v3.0-20250812`, requested 50,000-face cap.
  Original-image texture alignment, image-aligned orientation, autofix and auto-size off.
- [Task status](https://developers.tripo3d.ai/en/docs/task-query): `GET /v3/tasks/{task_id}`.

`job.json` records `prepared → uploading → submitting → queued/running → ready`.
Unknown provider states and polling time limits become `waiting`, retaining the task ID.
Failed/cancelled/banned/expired tasks remain terminal. Download failures preserve a successful
provider task for re-query and download, rather than generating another model.

Before a billable submission, `submitting` is saved atomically. Transport uncertainty
becomes `submission_unknown`. Neither state is automatically resubmitted: reconcile that
attempt in Tripo before deliberately preparing another job. There is no claimed provider
idempotency support. A per-job process lock prevents concurrent local submissions; separate
job directories are separate deliberate requests and can incur separate charges.

Exit codes: 0 prepared/ready, 3 pending/waiting, 2 failure or invalid configuration. Error
messages are sanitized. The CLI reads `TRIPO_API_KEY` only from its process environment;
it does not auto-load dotenv files. No credentials, signed output URLs or raw provider
messages are persisted in review artifacts.

## Validation and output boundary

Inputs require a PR25 `review-preview-v1` manifest, matching source/fallback byte counts
and SHA-256, dish/revision UUIDs, and private needs-review/ineligible provenance. PNGs are
bounded to 10 MB and 256–2048 pixels with actual transparency. Original bytes are preserved.

Downloaded GLBs are capped at 50 MB. The API host is fixed, redirects are rejected,
and output downloads only allow `https://cdn.tripo3d.ai` with no bearer credential.
An unexpected provider CDN is a deliberate failure requiring inspection, not arbitrary
URL fetching. Structural GLB checks cover version/length/chunks, embedded buffers and
resources, position accessor bounds, meshes and scene references. This is not a full
glTF validator, face-count verifier, texture-quality assessment or food-fidelity approval.

Artifacts: `source.png`, `fallback.jpg`, `job.json`, `index.html`, and (only after validated
success) `model.glb`. Every output remains `needs_review` and `publication.eligible=false`.
Generated hidden surfaces, plate shape, ingredient identity and scale require human review.
No model is attached to a published menu or the production View Portion flow.

## Verification

```sh
PYTHONPATH=processing/src:processing/tests python -m unittest \
  test_generate_model test_review_preview test_diner_demo -v
```

Tests use synthetic PNGs/GLBs and a fake Tripo transport. They cover exact-byte submission,
current API request shape, timeout/resume without resubmission, ambiguous submission,
concurrent lock, terminal failure, download recovery, integrity failure, CDN credentials,
and malformed/external-resource model rejection. A triangle fixture is not a generated dish.

The actual current cutout was prepared locally without network calls. Live Tripo generation,
provider billing, returned dish quality, phone performance and production publication are
**NOT RUN**, as requested (no live key). Local review is not production acceptance.

### Local results — November 12, 2026

- PASS: focused processing suite (`test_assets test_spatial test_presentation
  test_generate_model test_review_preview test_diner_demo`) — 62 tests.
- PASS: `pnpm verify lint typecheck` and `pnpm verify context:check docs:check`.
- PASS: actual existing cutout preparation, preserving source hash and dish identity.
- PASS: browser smoke test with a clearly labelled synthetic triangle GLB: model loaded,
  source comparison and model return worked, reset remained available, no console errors.
- NOT RUN: live Tripo submission and real generated dish review, per the no-live-key instruction.

The prepared actual-input job is outside the repository in the local outputs directory;
it is `prepared` with `task_id: null`, not a generated 3D result.

### HTTP API verification

PASS: `PYTHONPATH=processing/src:processing/tests python -m unittest
test_model_service test_generate_model test_service test_service_artifacts -v` —61 tests.
This includes13 HTTP API cases for authentication, tenant isolation, bounded requests,
source identity/integrity, idempotent create, conflicting inputs, concurrent work,
nonblocking health, resume, ambiguous submissions and protected artifact downloads.
The transport is fake; the actual preparation/generation state machine is exercised.
PASS: repository lint/typecheck and context/documentation checks.
No live generation, deployment or public owner-API integration was performed.

## View Portion local connection

Run from the repository with Node 24.16 and a Python environment containing the processing dependencies:

```sh
PYTHONPATH=processing/src python -m peekaplate_processing.serve_model_demo \
  --review-dir /absolute/path/to/review_b2f135ce8784a517ca9cf1f3fbc8fcbf \
  --state-dir /absolute/path/to/local-model-state
```

Open `http://127.0.0.1:5173/?scenario=portion-demo`, open the dish, then **View Portion → Preview controls → Generate 3D from cutout**. The launcher registers the existing exact cutout, starts the private API on loopback port 5182 and the diner on 5173, and shares an ephemeral service token only between their server processes. Set `TRIPO_API_KEY` privately in the launcher environment for real generation; it is removed from the diner process environment. Without it, the API returns unavailable and the existing 2.5D preview remains interactive.

The browser uses a same-origin, loopback-only development bridge with a fixed upstream and allowlisted routes. No token is embedded in browser code. Only the explicit DEV portion fixture loads generation controls; the production build excludes this module. The current original cutout is always the generation input, even when the generated presentation image is selected for 2.5D.

The job ID survives closing/reopening in the same browser tab. Checking never starts a second job; interrupted jobs offer explicit resume. The 2.5D image remains visible while generation and the pinned model-viewer load. A successful 3D model supports camera controls, reset and a return to 2.5D; model errors return to 2.5D. Back disposes browser work but does not cancel an already submitted provider job. Jobs remain local review artifacts, never published menu assets. No live provider generation was performed for this integration.

Local connection verification (2026-11-12): PASS lint, typecheck, production build, context/docs checks; 4 proxy tests, 13 API tests, 16 model pipeline tests, 55 browser regressions plus focused reset and stale-attempt recovery checks. New 3D browser success cases substitute the viewer element; they prove UI transitions, not a generated dish GLB. NOT RUN: live Tripo generation (no key).

## Credit rejection and reconciliation

Before uploading a source for a new task, the private pipeline checks available API credits. A zero balance keeps the job prepared with `insufficient_credits`, without uploading or submitting. Positive balance is not a price guarantee: Tripo can still reject a request for insufficient credits. Documented request rejection codes on HTTP 400/401/403/404/429 (or a successful HTTP envelope carrying a documented rejection) are retained as safe reason enums. Provider messages, headers and URLs are discarded. Network errors, server errors and contradictory responses remain `submission_unknown` and cannot be automatically retried.

View Portion displays the credit problem, preserves 2.5D, and offers explicit resume of the same prepared job after the account is funded. Existing unknown jobs are not silently reclassified. Restart the local API through the private launcher to load Python changes; a frontend refresh alone does not update the API.

On November 12, 2026, the signed-in Tripo console showed no tasks in the current month, zero credits spent, zero available credits and zero frozen credits. No new generation was submitted during this reconciliation. The previous failure's exact provider code was not retained, so insufficient credits is the supported diagnosis, not a recovered historical error response. Live successful generation remains blocked by the empty API balance.

Credit-handling verification: 21 pipeline/transport tests, 14 private API tests and five focused browser regressions pass. Browser provider responses are mocked; no credits were spent for these checks.
