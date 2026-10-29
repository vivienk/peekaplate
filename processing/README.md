# Menu extraction

The optional staging HTTP service wraps this same pipeline; it does not replace
the CLI. See [VIS-01 infrastructure and service handoff](../docs/menu-ingestion-infrastructure.md)
for the request contract, Docker commands, secrets, limits and activation gates.
Install `uv sync --project processing --extra service --frozen` before running
the complete test suite, including HTTP boundary tests. CLI-only use does not
need the service extra. No hosted service is implied by this package.

Local PDF/image acquisition plus your LangGraph orchestrator/worker pattern.
OCR.space code and the existing dish/source schema are retained. The old custom
LLM client, review/evaluation layer, website reader and pipeline were removed.
The previous implementation is recoverable from the local branch
`archive/processing-before-pymupdf`. Private `.env`, inputs and saved results
under `work/` remain outside Git.

## Flow

1. **PDF:** PyMuPDF extracts every page's native text. Keep it when the page
   has at least 20 non-whitespace characters, even if it also contains images.
   Pages below that cutoff, including empty pages and pages with only a page
   number, are rendered and sent to the existing OCR.space adapter. This also
   handles short-text/vector-only pages without embedded raster images.
   Keep the original native text and its character count in the page report.
2. **Image:** validate/rotate/resize, then call the same OCR.space adapter.
3. **Orchestrator:** split page-number/text pairs into batches of ten by default;
   `--batch-pages` accepts 1–10 pages per request.
4. **Workers:** `ChatOpenAI` requests the generated dish JSON schema; complete
   response content is parsed locally and validated with `DishBatch`.
   LangGraph `Send` dispatches batches. The CLI defaults to one request at a time;
   `--llm-concurrency 2` allows two overlapping calls, with dispatches spaced
   at least 3.1 seconds apart.
5. **Synthesizer:** combine worker results in page order using Python. No LLM call.

The LLM sees only `{"pages": [{"page_number": 1, "text": "..."}]}` plus its schema
and extraction instructions. The prompt includes the exact generated JSON schema
and a complete synthetic input/output example, showing separate `price_amount`
and `price_currency` keys and required unknown fields set to null. This reinforces
provider-side schema requests; local strict validation remains mandatory. It does not receive OCR overlays or source images.
Names/prices/attributes are checked literally against their cited page. Original
page text is attached by code as evidence, avoiding model-generated source quotes.
This is page-level evidence, not proof of correct dish/price associations.
Unknown facts stay null and every dish remains `needs_review`.

**LLM verification is yours to add.** No verification/review agent is included.
Add your verification node after `synthesizer` in `workflow.py` when ready.

## Run

OCR calls use the `OCRProvider` interface in `ocr.py`. `OCRSpaceClient` inherits
from it and remains the default provider. Python callers can pass an existing
provider with `extract_source(path, ocr_provider=provider)`; PDF and image
acquisition depend on the interface's `extract(image)` method. This boundary is
currently OCR.space Engine 3-compatible only: returned `settings` must contain
the integer `OCREngine=3`. Both input paths reject incompatible settings before
accepting text, so another engine cannot silently produce Engine 3 evidence.
Supporting a different provider requires an explicit evidence-contract update.
The default provider, CLI flags and environment names are unchanged.

From `processing`, configure your private `.env` using `.env.example`:

```sh
uv sync --frozen
uv run --frozen python -m peekaplate_processing.extract_menus \
  --input work/test-menus/Dennys_Menu.pdf --output work/dennys-pages-v2.json
```

The command above extracts page text without calling any LLM. For the full graph:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input work/test-menus/Dennys_Menu.pdf --run-dir work/dennys-redesign-001
```

A2Agent takes precedence when any of `a2agent_api_key`, `a2agent_url` or
`a2agent_api_MODEL` is configured; all three are then required. These names are
case sensitive and match the existing private `.env`. For MiniMax M3 use
`https://api.a2agent.me/v1` and `minimax-m3`, as documented in the
[A2Agent quickstart](https://docs.a2agent.me/quickstart) and
[MiniMax catalog](https://a2agent.me/models/minimax-m3). Nara-only/OpenRouter-only
parameters are not sent to A2Agent. Availability and strict-schema support still
need the one-request live check below. Leave all A2Agent fields blank to select
the existing providers.

Otherwise, the graph uses `NARA_ROUTER_KEY`, `NARA_ROUTER_URL` and `NARA_ROUTER_MODEL`
when any Nara setting is present; all three must then be supplied. Use
`https://router.bynara.id/v1` as the Nara chat base URL. Otherwise it uses
`MENU_AI_API_KEY`, `MENU_AI_API_URL` and `MENU_AI_MODEL` from `.env`.
Nara requests do not include OpenRouter-specific routing parameters. They send
`reasoning_effort="none"` to request direct extraction, as described in the
[Nara reasoning documentation](https://router.bynara.id/docs). Provider support
for that control may vary.
The configured provider/model is retained; the research example's hard-coded
`gpt-4o` is not used. The full chat endpoint URL is normalized to the SDK base URL.
Each uncached nonempty batch makes one extraction request; no planner,
synthesis or verification request is made. Automatic SDK retries are disabled.
An unsupported name or wrong page rejects that dish. Unsupported optional
descriptions, categories, ingredients, prices and currencies are cleared to null
with field-specific review warnings, preserving the supported name and other
supported fields. The generated unsupported values are not accepted as facts.
Malformed or schema-invalid output still
rejects the batch. Prices attached to explicit `P`/`PHP` prefixes are recognized;
a peso symbol/prefix alone does not establish a three-letter currency code.
OpenRouter requests strict-parameter support and optional reasoning disabled;
actual provider support must be tested live.

To diagnose the provider before another PDF run, make one small request with the
same dish schema, without OCR or writing a run directory:

```sh
uv run --frozen python -m peekaplate_processing.check_llm
```

For response-format diagnosis only, the fixed synthetic check can print a preview:

```sh
uv run --frozen python -m peekaplate_processing.check_llm --show-response
```

This still makes one synthetic request and writes no files. The preview is opt-in,
limited to 4,000 characters, key-redacted and JSON-escaped for terminal display.
It is not available as a PDF pipeline flag.

The pipeline prints acquisition/cache totals and elapsed time for each LLM batch.
`extraction.json` stores acquisition timing and per-batch durations under
`configuration`. Batch progress prints retained dish counts and errors immediately.
Partially accepted batches are marked `incomplete`. Errors distinguish timeouts, connection failures, HTTP failures
and unusable schema output. Validation failures show up to three known field
paths and validation rules (for example, `dishes[0].price_amount (string_type)`),
including errors raised inside the SDK before raw output is returned. These
examples are diagnostic categories, not established causes of a live failure.
Normal extraction errors do not log provider messages, response values or page text.
The SDK receives a JSON-schema dictionary so eager Pydantic parsing does not
hide raw response content. Code validates the actual content, rather than using
the SDK parser's possibly repaired result. A single complete outer Markdown
JSON fence is removed. A complete leading MiniMax `<think>...</think>` wrapper
is discarded before parsing the final JSON; reasoning-only or unfinished wrappers
are rejected. Empty content, malformed/truncated JSON, duplicate keys,
nonstandard numeric constants and unsupported fields are rejected. No model
repair request is made.
The SDK HTTP timeout is supplemented by a cancellable 90-second deadline for
each LLM batch using async invocation. `--llm-timeout` changes this deadline
(up to 300 seconds). An expired request is cancelled and its batch rejected;
other batches can still succeed. Calls are sequential by default;
`--llm-concurrency 2` overlaps at most two with no automatic LLM retries.
This preserves the call count and may reduce total waiting time. It does not
shorten a single generation or guarantee router reliability. This bounds waiting; it does not guarantee provider speed.

To retry the LLM using saved acquisition output, bypass all PDF rendering/OCR:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input work/test-menus/Dennys_Menu.pdf \
  --pages-json work/dennys-nara-0080/pages.json \
  --run-dir work/dennys-nara-0090 \
  --llm-timeout 90
```

For the approved smaller-batch trial, add `--batch-pages 2` and choose a fresh
run directory. A 35-page document produces up to 18 sequential requests
(17 pairs and one final page), compared with four at the default size of ten.
This reduces work per request but may increase total calls and pacing overhead;
live performance must be measured. Deadlines, strict validation and page-level
evidence are unchanged. Invalid batch sizes are rejected before acquisition.

Complete, schema-valid model candidates are cached privately in `work/llm-cache`
before grounding checks. Matching source bytes, exact page text, provider/model,
request settings, prompt and schema reuse those candidates without another model
call. Schema and grounding checks run again on every reuse, including nulling
unsupported optional fields. Batch metrics record `cache_hit`. Failed, truncated,
refused or malformed responses are not cached. No raw response, reasoning or API
key is stored in this cache. Use `--no-llm-cache` to disable reading and writing it.

POSIX cache files are checked for mode `0600`. Windows permissions depend on
the containing directory's ACLs; POSIX mode bits do not verify Windows privacy.
Windows ACL enforcement has not been validated by this suite.
Build configuration also excludes local environment files and the private
project handoff from source distributions and wheels; Git ignore rules alone
do not control package contents.
The synthetic `check_llm` command always makes a fresh request.

Existing runs predate this cache: their discarded model candidates cannot be
recovered from saved drafts. The first new request populates its cache entry;
later matching runs can reuse it, including after other batches fail. This
reduces repeated work, without making the first generation faster.

The saved report is bounded to 32 MB, validated against the page/text limits,
and its source hash, stored snapshot and actual page coverage must match
`--input`. PDF coverage is checked from metadata without rendering. Omitted
segments are rejected. Missing/failed pages stay explicit:
this option never retries them or carries over old dish drafts. Omit
`--pages-json` when you want normal acquisition and its one OCR retry.

Each new private run directory contains `pages.json` (acquired source/page data)
and `extraction.json` (dish drafts, evidence and explicit errors). Do not reuse
an existing output filename or directory. A failed batch does not erase other
successful batches. `complete` describes processing, not approved facts.

Limits: 40 PDF pages, 12 MB source, 24 MP input image, 950,000-byte OCR upload,
100,000 acquired characters, 100 dishes per LLM response. The full document
can retain more than 100 supported dishes across batches. OCR retries once for eligible
transport/server errors and retains its existing cache. A changed PDF renderer
can produce different image bytes and therefore new OCR requests rather than
cache hits. The supplied Denny file was rechecked with PyMuPDF: all 35 pages
contain displayed images, with zero native text characters or words. OCR is
required for that copy; text-bearing PDFs skip it. Its SHA-256 is
`2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275`.
Provider quotas and quality remain external. The 20-character cutoff is a
simple fallback rule, not a completeness/quality check; a short legitimate page
will also use OCR. Saved `--pages-json` reports bypass acquisition, so omit that
option when testing the new PDF routing.

For a public menu with extractable text, try the 12-page
[Sen Restaurant dinner menu](https://anlam.com/wp-content/uploads/2019/03/Sen-dinner-feb-2019.pdf).
Download it as `work/test-menus/Sen_Dinner_Menu.pdf`, then test acquisition alone:

```sh
uv run --frozen python -m peekaplate_processing.extract_menus \
  --input work/test-menus/Sen_Dinner_Menu.pdf --output work/sen-pages-001.json
```

Inspect each segment's `method` (`pdf_native` or `ocr_space_engine3`) and
`metadata.native_text_chars` to see which route was used. This command makes
no model requests. The PDF's text is readable through the web reader; local
PyMuPDF verification of that external file is pending a download because the
agent terminal cannot resolve its host.

Run the focused suite:

```sh
uv run --frozen python -m unittest discover -s tests
```

The inherited schema remains a Python draft contract; final TypeScript/backend
integration and the ClickUp ground-truth evaluation are still separate work.
Menu imagery is text evidence, not approved photographs of plated dishes.

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
variant, verified against its manifest size/hash and decoded as an opaque JPEG
matching the detail dimensions), `spatial-manifest.json` and `harness.html`.
`measurements.total_asset_bytes` and the `--budget-bytes` gate include all
delivered files in the bundle directory (`layers/*`, `fallback.jpg`,
`harness.html` and `spatial-manifest.json`). The harness is a dependency-free
static page labelled "Feasibility harness — not the diner viewer". It keeps the
T0 photo visible at all times (`<img id="fallback" src="./fallback.jpg">` renders
even when JavaScript is disabled), fades layers in after decode, and drives both
rotation and layer parallax from the combined pointer and arrow-key input,
reconciling the stored keyboard offsets on both keydown and pointer updates so
reverse arrow keys respond immediately after saturation and `Home` resets to
zero. Paint order assigns distinct integer `z-index` ranks (`1..N`) from stable
depth ordering, so closely spaced or delayed background layers cannot cover the
foreground. It honours `prefers-reduced-motion` with a live media-query listener
that immediately clears transforms, zeroes input offsets, and prevents movement
without page reload, counts layer retries using a prototype-safe `Object.create(null)`
map (`metrics.layerRetries`), and degrades to the T0 photo when 3D CSS or a layer
is unavailable. It records `window.__peekaplateSpatialMetrics` with fetch, decode,
frame-timing, viewport, fallback and retry state, and offers a copy button for
the same JSON.

Serve the bundle over HTTP (`python -m http.server` inside the bundle directory)
because browsers block the manifest `fetch` from `file://`, where the harness
reports "Preview unavailable" after one retry.

The harness is a feasibility measurement, not a diner renderer and not a phone
benchmark. Real captured-dish review, rights review and publication approval
remain human gates.

## Dish presentation prompt and validation (optional extension)

`peekaplate_processing.presentation` implements the post-cutout presentation
pipeline requested in ClickUp task S3-VIS-03. `prepare_presentation` pairs an
approved T0 photo with a dish cutout, framing reference image and the frozen
presentation prompt (`presentation-prompt-v1`), and validates square transparent
PNG candidates (`width == height >= 512`, preferably `2048x2048`):

```sh
uv run --project processing --frozen python -m peekaplate_processing.prepare_presentation \
  --t0-manifest work/vis03/<revision-id>/t0/<asset_id>/manifest.json \
  --cutout work/vis03/cutout.png \
  --reference work/vis03/reference.jpg \
  --candidate-png work/vis03/candidate-2048.png \
  --output-root work/vis03/<revision-id>/presentation \
  --capture-evidence "Permitted studio capture; see the private capture log." \
  --draft-id "draft-dish-42" \
  --model-version "offline-candidate-v1" \
  --budget-bytes 5000000
```

Inputs and outputs:
- Cutout input must be PNG or WEBP with transparent background (`min_a == 0, max_a > 0`).
- Reference image can be PNG, WEBP, or JPEG.
- Candidate presentation image must be a square PNG with an alpha channel and transparent corners
  `(0, 0)`, `(w-1, 0)`, `(0, h-1)`, `(w-1, h-1)` to reject opaque backgrounds or watermarks.
- `presentation-manifest.json` links the source T0 `asset_id` and SHA-256, source JPEG SHA-256,
  cutout and reference SHA-256, prompt SHA-256, model version, dish/revision identifiers, and optional `draft_id`.
- Manifests never self-approve: `review.status` is `needs_review` and `publication.eligible` is `false`.
  Flags (`--reconstructed-details-flagged`, `--preserved-original-viewpoint`, `--fidelity-note`)
  persist on `manifest.prompt` and add explicit review warnings.
- On generation/validation failure, the approved T0 detail photo is automatically retained as
  `fallback.jpg` with `fallback_retained = True`, `active_display_path = "fallback.jpg"`, and CLI exit code 2.
