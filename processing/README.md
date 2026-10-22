# Menu processing and OCR evaluation

Adapted from the existing ingestion implementation at commit `28b91d0` in
[staging PR 16](https://github.com/vivienk/peekaplate_staging/pull/16); original
authorship is retained in `pyproject.toml`. Application work targets `develop`
in the canonical `vivienk/peekaplate` repository.

Python 3.12+ and frozen uv dependencies are required for ingestion:

```sh
uv sync --project processing --frozen
uv run --project processing --frozen python -m unittest discover -s processing/tests
```

The CLI accepts local PDFs, menu photos, UTF-8 text and public static menu URLs.
It preserves source snapshots, page/segment text, draft spans and errors. Usable
native PDF text avoids OCR; scanned/image-bearing pages use OCR.space Engine 3.
Deterministic layout parsing rejects ambiguous layouts. Optional configured AI
extraction already exists, but supported text/table layouts require no LLM.

Create a private `processing/.env` from the blank-key example. Register your own
`OCR_SPACE_API_KEY` with [OCR.space](https://ocr.space/ocrapi); keep it outside
version control and browser configuration. From `processing`:

```sh
uv run --frozen python -m peekaplate_processing.extract_menus \
  --input /path/to/permitted-menu.pdf --output work/menu-report-001.json
```

For a credential-free dry run use `--input tests/fixtures/menu.txt`. Output is a
versioned report object with a `drafts` array, not an array alone. Drafts remain
`needs_review`. Exit codes: 0 complete, 2 incomplete, 1 failed. Choose a fresh
output filename. Extraction success does not mean correct facts or publication.

Source inputs/reports belong in ignored private storage; a report contains the
original source snapshot. Do not commit restaurant menus/photos without permission.
Menu images are text evidence, not verified photographs of actual plated dishes.

## Source regions

OCR requests now explicitly request overlays. Reports retain literal word boxes,
uploaded-byte hashes, upload dimensions and page identifiers. Coordinates refer
to uploaded-image pixels after EXIF orientation and resizing. Map using recorded
dimensions when inspecting the original. Engine 3 boxes are approximate.
Absent/malformed overlays are explicitly `unavailable`/`invalid`; page text
remains available. Overlay requests cost time; settings participate in cache keys.

OCR JPEG uploads are bounded at 950,000 bytes, with a 20-page local PDF job bound.
These implementation limits are not a free-throughput promise. Check current
[OCR.space quotas](https://ocr.space/ocrapi) before live runs. No automatic vendor
switch, paid upgrade or generated food imagery is included.

## Frozen field evaluation

`evaluate_menu.py` uses only the standard library and never calls a provider.
Human reviewers align expected dishes to `evidence[].draft_id`; name matching
would conceal name errors. Null alignment means missed dish; unmatched
predictions count as extras. Freeze each report hash and renew alignment when
reports change. Keep a held-out set and cases for readable/scanned PDF,
rotation, blur, low contrast, multi-column layout, missing fields and failed pages.

A private dataset manifest has `schema_version: 1`, `dataset_version`,
`environment` (`fixture`, `local` or `staging`), named `reviewer`,
`reviewed_at`, and `cases[]`. Each case contains `id`, `conditions[]`,
`report_path` relative to the dataset directory, `report_sha256`,
`source_sha256`, and `expected[]`. Each expected dish contains a unique `id`,
`match_draft_id` (or null), and `fields` labelling all six of `name`,
`description`, `category`, `price_amount`, `price_currency` and `ingredients`.
Use null for unknown facts, decimal strings for prices, and distinct ingredient
strings only when explicitly declared. Do not label absent ingredients as [].

```sh
python3 evaluate_menu.py --dataset work/dataset-v1.json --output work/errors-v1.json
```

Output includes expected/actual errors, per-field counts, missed/extra dishes,
source-span/snapshot errors (including followed menu documents), extraction/model versions, frozen report/dataset hashes, environment and source-condition groups.
Text scoring uses NFC/casefold/whitespace normalization; prices use decimal
equality; ingredient order is ignored. Totals include unknown labels, so inspect
unsupported/missing counts and dish detection separately. Structural provenance
does not establish semantic support. Tests contain synthetic labels only.

Zhiliang approves criteria/thresholds; Uneeza receives reproducible outputs;
Sai independently validates. `acceptance` remains unassessed. Fixture tests do
not measure real menu OCR accuracy or supply their sign-off.

## Delivery boundary

See [the task plan](../docs/ocr-delivery.md). Ingestion/review integration,
backend tenant authority, human approval/publication and diner rendering remain
separate work. The inherited Python draft is not the TypeScript staff payload.
`declared_allergens` remains absent from this inherited schema; adding it
requires the agreed evidence/review contract, never image-based inference.

EasyOCR's Python library and the hosted `easyocr.org` API are distinct services.
Neither is added here. Comparing providers requires the exact service, credentials
and the same reviewed corpus; no pricing/performance equivalence is assumed.

## T0 asset preparation and delivery

`peekaplate_processing.assets` prepares one captured dish photo into approved
delivery variants. `python -m peekaplate_processing.prepare_assets` writes a
bundle directory that contains the byte-identical source, four variants and
`manifest.json`:

```sh
uv run --project processing --frozen python -m peekaplate_processing.prepare_assets \
  --input work/photos/dish.jpg \
  --dish-id 11111111-1111-4111-8111-111111111111 \
  --revision-id 22222222-2222-4222-8222-222222222222 \
  --capture-evidence "Permitted capture; see the private capture log." \
  --captured-at 2026-10-01T12:00:00+00:00 \
  --output-root work/vis03/<revision-id>/t0 \
  --budget-bytes 400000
```

`--dish-id` and `--revision-id` are caller-supplied backend identifiers and are
never verified against the backend. `--capture-evidence` is required and must
identify the capture; `--captured-at` is optional but must carry a timezone and
must not be in the future. `--budget-bytes` is optional: when omitted the
manifest records `not_configured` and no threshold is invented. Exit codes: 0
ready, 2 failed. Unexpected errors propagate so CI fails loudly.

The bundle is content-addressed: `asset_id` is `t0_` plus the first 32 hex of
the SHA-256 over source bytes, dish ID, revision ID and the recipe version.
There is no timestamp in the identity, so the same source and revision always
produce the same `asset_id`. Preparation is create-only: an existing bundle
directory is refused and its `manifest.json` is left untouched. Use one output
root per revision.

Variants are `card-480` and `detail-1280`, each as WebP (quality 82) and JPEG
(quality 85). Images are never upscaled; a source smaller than the detail edge
produces smaller variants and a warning. Orientation is normalized, alpha is
flattened to RGB on white, and the original bytes are preserved as `source.*`.
The manifest records source and variant SHA-256 values, byte sizes, pixel
dimensions, processing steps, warnings and measurements.

Preparation never approves anything. `review.status` is always `needs_review`
and `publication.eligible` is always `false`. Rights, dish facts, revision
currency and publication eligibility stay human decisions. The manifest is a
proposed handoff for the S3-ARC-01 TypeScript contract; do not consume it in
the application until that contract is frozen.

## 2.5D feasibility sample

`peekaplate_processing.spatial` validates a human-prepared layered sample
against an approved T0 bundle. It never generates layers or food imagery.

```sh
uv run --project processing --frozen python -m peekaplate_processing.prepare_spatial \
  --t0-manifest work/vis03/<revision-id>/t0/<asset_id>/manifest.json \
  --layers work/vis03/layers.json \
  --output-root work/vis03/<revision-id>/spatial \
  --budget-bytes 400000
```

`--budget-bytes` is mandatory for spatial assets; the verification run uses the
ADR 0004 T1 ceiling of 400,000 bytes, which is provisional until the render
budget is measured in this repository. The layers manifest is caller-supplied
JSON with `schema_version: 1`, `tier: "T1"`, the `dish` reference, `motion`
limits of at most ±3°, a `layers[]` list of bare filenames with `depth` values,
`capture_evidence` and `rights_confirmed: true`. Layer files must sit beside the
layers manifest.

Validation is strict on purpose. Layer dimensions must equal the T0
`detail-1280` variant exactly, one layer must be the opaque background
(`depth: 0`), every other layer must carry an alpha channel, names must be
unique and the dish revision must match the T0 manifest. A mismatch, an
oversized sample or an unusable manifest fails with exit code 2 and writes
nothing.

The bundle contains the copied layers, `fallback.jpg` (the approved T0 detail
variant, verified against its manifest hash), `spatial-manifest.json` and
`harness.html`. The harness is a dependency-free static page labelled
"Feasibility harness — not the diner viewer". It keeps the T0 photo visible at
all times, fades layers in after decode, and drives both rotation and layer
parallax from the combined pointer and arrow-key input, clamped to the manifest
limits with `Home` to reset. Paint order comes from layer depth, so a slow
background cannot cover the foreground. It honours `prefers-reduced-motion`,
and degrades to the T0 photo when 3D CSS or a layer is unavailable. It records
`window.__peekaplateSpatialMetrics` with fetch, decode, frame-timing, viewport
and fallback state, and offers a copy button for the same JSON.

The harness is a feasibility measurement, not a diner renderer and not a phone
benchmark. Real captured-dish review, rights review and publication approval
remain human gates.
