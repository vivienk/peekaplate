# T0 asset delivery and 2.5D feasibility handoff

Task: [S3-VIS-03 — Deliver approved T0 assets and 2.5D fallback](https://app.clickup.com/t/86bcnfw7r).
DRI Marwan, with Mohammad supporting image extraction. Harshita owns the diner
viewer integration ([S3-DIN-03](https://app.clickup.com/t/86bcnfvdy)), which this
work does not implement. PM Vivien and diner approver Adam own acceptance.

Upstream: [2D → 3D / spatial dish generation slice](https://app.clickup.com/t/86bcexezr)
(Vivien and Adam, still in progress). This work validates and delivers assets
against that slice; it does not repeat generation setup.

Downstream: [S3-RES-02 publication APIs](https://app.clickup.com/t/86bcnfvbt) and
[S3-DIN-03](https://app.clickup.com/t/86bcnfvdy) wait on this asset path, and
[S3-ARC-01](https://app.clickup.com/t/86bcnfuur) owns the frozen contract.

## Included implementation

Use `processing/`. `prepare_t0_bundle` prepares one captured dish photo into
four delivery variants (`card-480` and `detail-1280`, WebP and JPEG), keeps the
original bytes, normalizes orientation and alpha, and writes `manifest.json`
with source and variant hashes, dimensions, processing steps, warnings and
byte measurements. `prepare_spatial_bundle` validates a human-prepared layered
sample against an approved T0 bundle with bounded manifest reads, decodes and
verifies the T0 detail variant as an opaque JPEG matching the manifest
dimensions before copying it as `fallback.jpg`, copies the layers, writes
`spatial-manifest.json` and a dependency-free `harness.html`, and includes all
delivered files in `measurements.total_asset_bytes` against the configured T1
budget.

Preparation is create-only and content-addressed. `asset_id` derives from the
source bytes, the caller-supplied dish and revision identifiers, and the recipe
version; there is no timestamp in the identity. An existing bundle directory is
refused and never overwritten. Use one output root per revision. The spatial
`asset_id` derives from the T0 `asset_id`, each layer's name, depth and SHA-256
in manifest order, the motion limits and the recipe version, and the spatial
manifest records the layers manifest's `capture_evidence` and
`rights_confirmed`.

The manifest never self-approves. `review.status` is `needs_review` and
`publication.eligible` is `false` in every generated bundle, including the
spatial manifest. There is no approval function and no publication path.

The harness keeps the approved T0 photo visible at all times (`<img id="fallback" src="./fallback.jpg">` renders even with JavaScript disabled), fades the layers
in after decode, and drives rotation and layer parallax from the combined
pointer and arrow-key input, reconciling the stored keyboard offsets on both
keydown and pointer updates so reverse input responds immediately after
saturation and `Home` resets both axes. Paint order assigns distinct integer
`z-index` ranks (`1..N`) from stable depth ordering, so closely spaced or
delayed background layers cannot cover the foreground. It honours
`prefers-reduced-motion` with a live `change` media-query listener that immediately
clears existing transforms, zeroes input offsets, and blocks movement without
page reload, and counts layer retries using a prototype-safe `Object.create(null)`
map (`metrics.layerRetries`). It falls back to the T0 photo when 3D CSS is
unsupported or a layer fails to load. It exposes
`window.__peekaplateSpatialMetrics` with fetch, decode, frame-timing, viewport
and fallback state, and a copy button for the same JSON.
The suite covers deterministic hash addressing, create-only refusal,
orientation and alpha normalization, failure without output, manifest
non-approval, layer and fallback hashing, revision mismatch, layer dimension,
alpha and background rules, motion limits, budget enforcement and repeated
spatial bundle refusal.

## Optional post-cutout dish presentation pipeline

`peekaplate_processing.presentation` implements the post-cutout dish presentation
prompt and offline candidate validator requested in ClickUp task S3-VIS-03
(comment `90140274443174`). It pairs a source dish cutout with a framing/lighting
reference image and the frozen presentation prompt (`presentation-prompt-v1`),
requesting a standalone square dish-and-plate asset:

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

Key architecture and safety invariants:
- **Prompt & Multimodal Request:** Uses Vivien Kong's verbatim presentation prompt
  (`presentation-prompt-v1`, SHA-256 tracked in the manifest). `build_multimodal_messages`
  assembles Image 1 (source dish cutout data URL) and Image 2 (reference framing data URL)
  into the standard multimodal format.
- **Provider Abstraction:** `PresentationProvider` defines the pluggable generation
  interface following PR #24's `OCRProvider` pattern. `FilePresentationProvider`
  enables reproducible offline candidate validation and test runs.
- **Strict Image Validation:** Cutouts require PNG or WEBP with transparent background
  (`min_a == 0, max_a > 0`). Reference inputs require PNG, WEBP, or JPEG. Generated
  presentation PNGs must be square (`width == height >= 512`, preferably `2048x2048`),
  carry genuine alpha transparency, and have all four corner pixels `(0, 0)`, `(w-1, 0)`,
  `(0, h-1)`, `(w-1, h-1)` fully transparent (`alpha == 0`), rejecting opaque
  checkerboards, gray rectangles, or baked-in edges.
- **Provenance Manifest (`PresentationManifest`):** The output `presentation-manifest.json`
  links the source T0 `asset_id` and manifest SHA-256, source JPEG SHA-256, cutout
  SHA-256, reference SHA-256, prompt SHA-256, model version, dish and revision UUIDs,
  and optional PR #24 `draft_id`.
- **Human Review Gate:** Manifests never self-approve (`review.status = "needs_review"`,
  `publication.eligible = False`). Fidelity requirements (`preserved_original_viewpoint`,
  `reconstructed_details_flagged`, `fidelity_notes`) persist on `manifest.prompt` and
  emit explicit review warnings flagging reconstructed unseen food or cropped details.
- **Automatic Fallback Retention:** If generation fails, the provider returns an error,
  candidate dimensions/alpha/corners are invalid, or byte budget is exceeded, the pipeline
  preserves the approved original-photo T0 `fallback.jpg`, sets `fallback_retained = True`,
  `active_display_path = "fallback.jpg"`, `presentation = None`, and records error
  reasons in `processing.validation_errors`. The CLI exits 2 on fallback retention so
  operators are alerted while the valid fallback bundle is preserved.

## Integration review requested

- The Python `AssetManifest` and `SpatialManifest` JSON is the proposed handoff
  for [S3-ARC-01](https://app.clickup.com/t/86bcnfuur). S3-DIN-03 must not
  consume it in production until S3-ARC-01 freezes the equivalent TypeScript
  contract. A Zod schema, if requested, is a separate S3-ARC-01 change and is
  not included here.
- Align the manifest's `fallback` and `publication` fields with the
  [S3-RES-02](https://app.clickup.com/t/86bcnfvbt) boundary while that work is
  still unbuilt. S3-RES-02 and S3-DIN-03 are recorded as waiting on VIS-03.
- `--budget-bytes` stays optional for T0 and records `not_configured` when it is
  omitted; no pass threshold is invented. The spatial ceiling of 400,000 bytes
  comes from ADR 0004 and is provisional until this repository measures the
  real render budget.
- `dish_id` and `revision_id` are caller-supplied. The manifests record them
  and never verify them against the backend. Re-issuing a revision over an
  unchanged source produces the same `asset_id` and is refused as already
  existing; recompute into a fresh output root per revision.
- The spatial pipeline validates a human-prepared layered sample. It never
  generates layers, food imagery or depth maps.

## Acceptance still required

The verification run used a synthetic fixture labelled `SYNTHETIC FIXTURE`. It
proves determinism, create-only behaviour, manifest fields and the harness
failure paths. It is not a dish-quality, rights or publication result.

Before acceptance, prepare the permitted restaurant photos with real dish and
revision identifiers and capture evidence naming the source, then record the
manifest hashes, variant byte totals and measurement JSON in the pull request.
Do not commit photos or private paths. Vivien and Shirley still review rights,
dish facts and publication eligibility.

For VIS-05, the layered sample must be human-prepared from one capture and
human-verified to depict the same dish. The harness metrics are evidence for
the pull request, not a substitute for a real-phone measurement: p75 startup,
p95 frame time, VoiceOver and TalkBack remain manual gates. Chromium device
emulation is not a phone measurement.

If no permitted layered sample exists yet, the T0 bundle plus the synthetic
harness evidence stands as the deliverable and the real-sample demonstration
stays pending PM and design review. Generated food imagery is not an
acceptable substitute.

## Verification record

See the pull request body for the exact commands, results and limits. The
harness was exercised in Chromium at a 390×844 viewport with a device pixel
ratio of 3: layers loaded, the fallback stayed visible, pointer and keyboard
movement stayed within ±3°, `Home` reset the movement, reduced motion applied
no transform, a deleted layer produced `layer_load_failed` with the T0 photo
still visible, a missing manifest produced one retry, and a missing fallback
produced `fallback_load_failed`. Those are local measurements, not a phone
benchmark.
