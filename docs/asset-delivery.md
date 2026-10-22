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
sample against an approved T0 bundle, copies the layers, copies the T0 detail
variant as `fallback.jpg`, and writes `spatial-manifest.json` plus a
dependency-free `harness.html`.

Preparation is create-only and content-addressed. `asset_id` derives from the
source bytes, the caller-supplied dish and revision identifiers, and the recipe
version; there is no timestamp in the identity. An existing bundle directory is
refused and never overwritten. Use one output root per revision.

The manifest never self-approves. `review.status` is `needs_review` and
`publication.eligible` is `false` in every generated bundle, including the
spatial manifest. There is no approval function and no publication path.

The harness keeps the approved T0 photo visible at all times, fades the layers
in after decode, and drives rotation and layer parallax from the combined
pointer and arrow-key input, clamped to the manifest limits with `Home` to
reset. Paint order follows layer depth, so a slow background cannot cover the
foreground. It honours `prefers-reduced-motion`, and falls back to the T0 photo
when 3D CSS is unsupported or a layer fails to load. It exposes
`window.__peekaplateSpatialMetrics` with fetch, decode, frame-timing, viewport
and fallback state, and a copy button for the same JSON.

The suite covers deterministic hash addressing, create-only refusal,
orientation and alpha normalization, failure without output, manifest
non-approval, layer and fallback hashing, revision mismatch, layer dimension,
alpha and background rules, motion limits, budget enforcement and repeated
spatial bundle refusal.

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
