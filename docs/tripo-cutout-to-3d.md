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
