# S3-VIS-03 QA and verified fix report

Date: 2026-10-29 (updated after rebase onto `develop` `0477653`, PR #25 viewer findings, and ClickUp presentation addition)
Base commit: `0477653153b7032192882452e2a5a70d628e85d8` (`origin/develop`, including PRs #63, #62, #61, #60, #57, #54, #48, #47, #41, #39, #38, #24, #23)
Branch: `feat/s3-vis-03-asset-delivery`
Pull request: [vivienk/peekaplate#25](https://github.com/vivienk/peekaplate/pull/25)
ClickUp: [86bcnfw7r](https://app.clickup.com/t/86bcnfw7r)
## Environment

| Item | Value |
|---|---|
| OS | Windows 10.0.26200, x64 |
| Python | 3.12.13 through `uv` |
| uv | 0.11.30 |
| Node.js | 24.16.0 |
| pnpm | 11.25.0 |
| Browser | Managed headless Chromium, 390x844 viewport, effective DPR 1.25 |
| Source data | Synthetic fixtures only; repository contains no image assets |

No real restaurant capture, approved layered sample, phone or screen reader was available. Those gates are recorded as `BLOCKED`, not inferred from synthetic results.

## Baseline at `1355175`

| Check | Result | Status |
|---|---|---|
| Python suite | 120 tests, 117 passed, 3 failed | `FAIL` |
| TypeScript unit tests | 56 Vitest tests passed | `PASS` |
| Script tests | 21 `node --test` tests passed | `PASS` |
| T0 700x700 JPEG | exit 0, 272,193 B of 400,000 | `PASS` |
| T0 create-only rerun | exit 2, manifest SHA-256 unchanged | `PASS` |
| T0 3000x4000 EXIF-6 JPEG | oriented 4000x3000, card 480x360, detail 1280x960 | `PASS` |
| T0 negatives | small budget, text input, timezone-less date and blank evidence all exit 2 with no output | `PASS` |
| Spatial negatives | revision mismatch, opaque non-background layer and oversized PNG all exit 2 with no output | `PASS` |
| Harness over `file://` | manifest fetch blocked, one retry, "Preview unavailable", fallback visible | `PASS` |
| Harness over HTTP | 3 layers, spatial and fallback visible, byte total matched manifest | `PASS` |
| Harness failure injection | layer, manifest and fallback failures reported expected errors and retries | `PASS` |

The three Python failures are `test_evaluation.test_private_output_preserves_existing_result`, `test_ingestion.test_private_report_cli_returns_incomplete_exit_code` and `test_ocr_space.test_valid_engine3_cache_avoids_another_request_even_without_key`. All assert `stat().st_mode & 0o777 == 0o600`; on this NTFS volume `os.chmod(path, 0o600)` reports `0o666` (`438 != 384`). The tests come from the stacked OCR commit `33057cc`, CI runs Ubuntu, and they were deliberately not modified.

## Confirmed defects and fixes

### D1 — spatial asset IDs ignored layer names and depths

Before the fix, `processing/src/peekaplate_processing/spatial.py:73-75` hashed only the T0 id, concatenated layer SHA-256 values, motion JSON and recipe version. Three distinct manifests produced the same synthetic id `t1_3dc672d50cc06e4178260637a0b3c3b2`: the default depths, rebalanced depths `0.55/0.7`, and `accent` renamed to `garnish`. A fresh output root therefore created a different bundle under the same id, while the original root refused it as already existing.

Fix: `processing/src/peekaplate_processing/spatial.py:73-78` builds a deterministic JSON signature containing each layer's `name`, `depth` and `sha256`, then hashes it with the T0 id, motion JSON and recipe version. Layer order remains part of the manifest identity.

### D2 — spatial manifests dropped capture evidence and rights confirmation

`processing/src/peekaplate_processing/schemas.py:264-265` required `capture_evidence` and `rights_confirmed: true` in `LayersInput`, but `SpatialManifest` had no corresponding fields and `spatial.py` never wrote them. The delivered artifact therefore lost the validation trace that T0 stores in `AssetManifest.source.capture_evidence`.

Fix: `processing/src/peekaplate_processing/schemas.py:315-316` makes both fields required in `SpatialManifest`, and `processing/src/peekaplate_processing/spatial.py:100-101` copies them from the validated layers input. No TypeScript consumer reads this manifest, and bundles are create-only, so no runtime migration is required.

### P2 #1 — fallback image was not decoded or dimension-checked (`spatial.py:read_detail_bytes`)

Review finding (`@hemu77`): `read_detail_bytes` verified `sha256` against the T0 manifest but did not decode the file or check its pixel dimensions, allowing a manifest with a matching hash over corrupt bytes (`b"not-a-jpeg" * 20`) or mismatched dimensions to be copied as `fallback.jpg`.

Fix: `processing/src/peekaplate_processing/spatial.py:185-202` verifies `len(data) == detail.size_bytes` and `sha256`, decodes the bytes through `open_layer_image(data)`, requires `image_format == "JPEG"` and `not has_alpha`, and verifies `oriented.size == (detail.width, detail.height)` before closing the image.

### P2 #2 — stored keyboard offset accumulated unbounded saturation (`harness.py:onKeyDown`)

Review finding (`@hemu77`): pressing `Home`, pressing `ArrowRight` 40 times, and then pressing `ArrowLeft` once left the scene at `rotateY(3deg)` because `keyboard.yaw` accumulated `20` degrees while `render()` only clamped the displayed rotation.

Fix: `processing/src/peekaplate_processing/harness.py:150-162` bounds `keyboard.yaw` and `keyboard.pitch` on every arrow keydown against the combined pointer + keyboard limits (`clamp(pointer.x*maxYaw+keyboard.yaw±step, maxYaw)-pointer.x*maxYaw` and `clamp(-pointer.y*maxPitch+keyboard.pitch±step, maxPitch)+pointer.y*maxPitch`), so reverse input responds on the first key press after saturation.

### P2 #3 — manifest byte limit was checked after full-file allocation (`spatial.py:read_bounded`)

Review finding (`@hemu77`): `Path(path).read_bytes()` read the entire file (`read(-1)`) before checking `len(data) > MAX_MANIFEST_BYTES`.

Fix: `processing/src/peekaplate_processing/spatial.py:167-175` opens the path in binary mode and reads `source.read(MAX_MANIFEST_BYTES + 1)` (`100,001` bytes) before rejecting empty or oversized inputs.

### P2 #4 — spatial budget excluded delivered `harness.html` and `spatial-manifest.json` overhead (`spatial.py:prepare_spatial_bundle`)

Review finding (`@hemu77`): `total_asset_bytes` summed only layer images and `fallback.jpg` (`48,823` bytes), while the delivered directory contained `62,930` bytes (`14,107` bytes of `harness.html` + `spatial-manifest.json`), contrary to ADR 0004 ("T1 adds at most 400 KB including compressed code, manifest and textures").

Fix: `processing/src/peekaplate_processing/spatial.py:77-136` encodes `harness.html` and converges `spatial-manifest.json` over 3 iterations so `measurements.total_asset_bytes` equals the exact byte sum of all delivered files (`layers/*`, `fallback.jpg`, `harness.html`, `spatial-manifest.json`), checks `total_asset_bytes > budget_bytes` before creating output directories, and writes both text artifacts via `.write_bytes(...)` for platform-independent byte totals.

### Rebase reconciliation (`assets.py:read_source`)

Rebasing onto `origin/develop` (`5c0cb3f`, after PR #23 and PR #24 `78ebb47`) dropped the older stacked OCR commit `33057cc`. In merged PR #24, `sources.check_size` was inlined into `sources.read_file`, so `processing/src/peekaplate_processing/assets.py:120-121` now performs the `not data or len(data) > MAX_SOURCE_BYTES` check directly. All 3 Windows POSIX `0o600` test failures from `33057cc` are gone on the rebased branch.

### Follow-up PR review fixes (`harness.py` & `test_spatial.py`)

- **Static fallback image source (`harness.py:35`, P2):** Added `src="./fallback.jpg"` directly to `<img id="fallback" src="./fallback.jpg" alt="Approved dish photo">` so the T0 dish photo renders even with JavaScript disabled (`naturalWidth=1280`, `naturalHeight=960` verified in Chromium).
- **Pointer + keyboard saturation reconciliation (`harness.py:128-153`, P2):** `onPointerMove` and `render` now reconcile `keyboard.yaw = yaw - pointer.x*maxYaw` and `keyboard.pitch = pitch + pointer.y*maxPitch` after clamping the combined rotation, so `Home` → 40× `ArrowRight` → pointer right edge → 1× `ArrowLeft` immediately steps from `3deg` to `2.5deg` (`translate(2.66667px, 0px)` on `subject`).
- **Stable integer `z-index` depth ranks (`harness.py:230-288`, P2):** Replaced `Math.round(layer.depth * 1000) + 1` with distinct `1..N` integer ranks from stable `(layer.depth, index)` sorting so closely spaced depths (`0.0`, `0.0001`, `0.0002`) receive `z-index` `1`, `2`, `3` and a delayed background never covers foreground layers.
- **Loaded-layer harness regression (`test_spatial.py:318-513`, P3):** Exposed `globalThis.CSS = globalThis.window.CSS` (and `window.CSS.supports` in `harness.py`), asserted `layersLoaded == 3`, `spatialVisible == true`, and `subject` parallax transforms across keyboard-only and mixed pointer+keyboard saturation/reversal, and added `test_harness_preserves_depth_order_for_closely_spaced_delayed_layers`.

### PR #25 viewer findings (`@vivienk`, commit `921b32d`)

- **Live `prefers-reduced-motion` media-query listener (`harness.py:65-173`, P2, review 4396991434):**
  Replaced one-time `Boolean(window.matchMedia(...).matches)` evaluation with a retained `MediaQueryList` and live `change` listener (`motionQuery.addEventListener("change", onMotionChange)` / `addListener`). Added `clearTransforms()` and `syncReducedMotion()`. When reduced motion is toggled live, existing transforms on `#layers` and child `<img>` elements are immediately cleared to `""`, rotation/pointer/keyboard offsets are zeroed, and further movement handlers exit early.
- **Null-prototype `layerRetries` and `ranks` (`harness.py:71, 243, 285`, P3, review 4396991442):**
  Initialized `layerRetries: Object.create(null)`, `imageDecodeMs: Object.create(null)` and `ranks = Object.create(null)`. `loadLayer` counts retries using `Object.prototype.hasOwnProperty.call(metrics.layerRetries, layer.name) ? metrics.layerRetries[layer.name] : 0`. Valid layer names such as `"constructor"` record integer `1` rather than appending string `"function Object() ... 1"`.

### ClickUp task S3-VIS-03 presentation pipeline addition (`@vivienk`, comment `90140274443174`)

- **Frozen presentation prompt & multimodal request builder (`presentation.py`, `presentation-prompt-v1`):**
  Embeds Vivien Kong's verbatim prompt requesting a photorealistic square dish-and-plate PNG with genuine transparent background and clean antialiased edges. `build_multimodal_messages` packages Image 1 (dish cutout data URL) and Image 2 (reference framing data URL).
- **Injectable `PresentationProvider` & `FilePresentationProvider` (`presentation.py`):**
  Pluggable generation abstraction following PR #24's `OCRProvider` pattern, supporting offline candidate PNG validation.
- **PNG, alpha, square, and transparent-corner validation (`presentation.py`):**
  Requires square PNG (`width == height >= 512`, preferably `2048x2048`), genuine alpha channel (`min_a == 0, max_a > 0`), and fully transparent corner pixels `(0, 0)`, `(w-1, 0)`, `(0, h-1)`, `(w-1, h-1)` to eliminate opaque checkerboards, gray rectangles, or watermarks.
- **Provenance manifest (`PresentationManifest`):**
  `presentation-manifest.json` links source T0 `asset_id` and manifest SHA-256, source image SHA-256, cutout SHA-256, reference SHA-256, prompt SHA-256, model version, dish/revision identifiers, and optional PR #24 `draft_id`.
- **Human review gate & fidelity notes (`schemas.py`, `presentation.py`):**
  Manifests never self-approve (`review.status = "needs_review"`, `publication.eligible = False`). Fidelity limitation flags (`--preserved-original-viewpoint`, `--reconstructed-details-flagged`, `--fidelity-note`) persist on `manifest.prompt` and emit explicit review warnings.
- **Automatic T0 fallback retention (`presentation.py`, `prepare_presentation.py`):**
  When candidate generation or validation fails, or candidate byte budget is exceeded, the approved original-photo T0 detail JPEG is automatically retained as `fallback.jpg` with `fallback_retained = True`, `active_display_path = "fallback.jpg"`, `presentation = None`, and CLI exit code 2.

## Regression evidence

Added to `processing/tests/test_spatial.py:156-177`:

- `test_asset_id_tracks_layer_names_and_depths`
- `test_manifest_records_capture_evidence_and_rights`

Red state before implementation, exactly two failures:

```text
FAIL: test_asset_id_tracks_layer_names_and_depths
AssertionError: 't1_97984284432d9a862cb34b4d1c5356f7' == 't1_97984284432d9a862cb34b4d1c5356f7'

ERROR: test_manifest_records_capture_evidence_and_rights
AttributeError: 'SpatialManifest' object has no attribute 'capture_evidence'
```

Green state after implementation:

```text
Ran 10 tests in 8.160s
OK
```

Added for the four P2 review findings (`processing/tests/test_spatial.py:231-395`):

- `test_corrupt_or_mismatched_fallback_is_rejected_even_when_hash_matches`
- `test_manifest_reads_are_bounded_before_allocation`
- `test_budget_accounts_for_delivered_bundle_overhead_at_exact_boundaries`
- `test_harness_clamps_stored_keyboard_state_and_reverses_immediately`

Red state before P2 fixes (5 failures):

```text
FAIL: test_budget_accounts_for_delivered_bundle_overhead_at_exact_boundaries
AssertionError: 48823 != 62931

FAIL: test_corrupt_or_mismatched_fallback_is_rejected_even_when_hash_matches
AssertionError: ExtractionError not raised

FAIL: test_harness_clamps_stored_keyboard_state_and_reverses_immediately
AssertionError: 'perspective(900px) rotateX(0deg) rotateY(3deg)' != 'perspective(900px) rotateX(0deg) rotateY(2.5deg)'

FAIL: test_manifest_reads_are_bounded_before_allocation
AssertionError: Lists differ: [-1] != [100001]
```

Green state after P2 fixes and rebase onto `origin/develop`:

```text
Ran 15 tests in 11.301s
OK
```

Full Python suite on rebased branch:

```text
Ran 140 tests in 18.481s
OK
```

## Test matrix

| Case | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| T0 JPEG preparation | Ready bundle, source and variants hashed, review required | exit 0, 272,193 B, `needs_review`, `eligible=false` | `PASS` | Baseline manifest |
| T0 create-only rerun | Refuse without changing bytes | exit 2, manifest SHA-256 unchanged | `PASS` | Baseline rerun |
| T0 EXIF orientation | Orient before resizing | 4000x3000 source, 480x360 card, 1280x960 detail | `PASS` | Baseline manifest |
| T0 invalid budget/input/date/evidence | exit 2, no output directory | All four rejected before output | `PASS` | Baseline negative runs |
| Spatial revision mismatch | Reject, write nothing | exit 2, no output | `PASS` | `test_revision_mismatch_is_rejected` |
| Spatial opaque non-background layer | Reject, write nothing | exit 2, no output | `PASS` | `test_layer_dimensions_alpha_and_background_rules` |
| Spatial oversized PNG layers | Reject over budget | exit 2, no output | `PASS` | `test_motion_limits_and_budget_are_enforced` |
| D1 name/depth collision | Different names or depths produce different ids | Regression test failed before, passes after | `PASS` | `test_asset_id_tracks_layer_names_and_depths` |
| D2 provenance | Serialized manifest retains both validated fields | Regression test failed before, passes after | `PASS` | `test_manifest_records_capture_evidence_and_rights` |
| P2 #1 corrupt/mismatched fallback with matching hash | Reject before output | Both corrupt bytes and half-size JPEG rejected with no output | `PASS` | `test_corrupt_or_mismatched_fallback_is_rejected_even_when_hash_matches` |
| P2 #2 keyboard & mixed pointer+keyboard saturation reversal | 40x `ArrowRight` (+ optional right-edge pointer) then 1x `ArrowLeft` -> `2.5deg`; same for pitch | `rotateY(3deg)` -> `rotateY(2.5deg)`, `subject` `translate(2.66667px, 0px)` | `PASS` | `test_harness_clamps_stored_keyboard_state_and_reverses_immediately` + Chromium |
| P2 #3 bounded manifest read | `source.read(100001)` before size check | Spy recorded `[100001]` for valid and oversized manifests | `PASS` | `test_manifest_reads_are_bounded_before_allocation` |
| P2 #4 full bundle budget accounting | Reject image-only budget (`48,823`), accept exact delivered budget | Image-only and `delivered - 1` rejected; exact `delivered_bytes` accepted | `PASS` | `test_budget_accounts_for_delivered_bundle_overhead_at_exact_boundaries` |
| Static fallback with JS disabled | Fallback photo renders without script execution | `src="./fallback.jpg"`, `naturalWidth=1280`, `naturalHeight=960` | `PASS` | `test_spatial.py` + Chromium |
| Delayed background with close depths (`0`, `0.0001`, `0.0002`) | Background keeps lowest `z-index` even when appended last | `domOrder=["subject","accent","background"]`, `zIndices={"background":1,"subject":2,"accent":3}` | `PASS` | `test_harness_preserves_depth_order_for_closely_spaced_delayed_layers` |
| Fixed synthetic bundle | Reprocesses successfully | T0 `t0_ab4bb80d…`, T1 `t1_1170ed2e…` (`63,595` B delivered) | `PASS` | `processing/work/qa-vis03/` |
| Harness over HTTP | 3 layers, fallback retained, byte total matches delivered bundle | `layersLoaded=3`, both visible, `63,595 == 63,595` | `PASS` | `harness-metrics-loaded.json` |
| Pointer/keyboard clamp & immediate reversal | Clamps at `3deg`, reverses to `2.5deg` on single opposite key | Verified in Chromium for keyboard-only and mixed pointer+keyboard | `PASS` | Chromium evaluation |
| `Home` reset | Zero both axes | `rotateX(0deg) rotateY(0deg)` | `PASS` | Chromium evaluation |
| Missing layer | `layer_load_failed`, retry once, fallback visible | `layerRetries.subject=1`, fallback visible | `PASS` | `harness-metrics-layer-failure.json` |
| Missing manifest | One retry, fallback visible | `manifestRetries=1`, fallback visible | `PASS` | `harness-metrics-manifest-failure.json` |
| Missing fallback | `fallback_load_failed` | error recorded, fallback hidden | `PASS` | `harness-metrics-fallback-failure.json` |
| Failure recovery | Restoring each file restores the 3-layer preview | Every restore reloaded successfully | `PASS` | Browser reruns |
| TypeScript & script tests | All unit and script tests pass | Vitest + `node --test scripts/*.test.mjs` passed | `PASS` | `pnpm verify test` |
| Lint, typecheck, build | All tracked files pass | Biome, 5 typechecks, 3 builds passed | `PASS` | `pnpm verify lint typecheck test build` |
| Python suite (rebased) | All tests pass on Windows | 110 tests, 110 pass, 0 failures | `PASS` | Full suite output |
| Context/docs checks | Fresh context and valid local links | 10 modules, 10 handoffs; 43 Markdown files | `PASS` | `pnpm verify context:check docs:check` |
| PR body check | Valid when applicable | "not applicable to this event" | `PASS` | `pnpm verify pr:check` |
| PR mergeability | Rebased cleanly onto `origin/develop` (`5c0cb3f`) | Linear history on top of merged #23/#24/#38/#39 | `PASS` | `git log origin/develop..HEAD` |
| Live `prefers-reduced-motion` toggle | Clears transforms, zeroes offsets, blocks movement without reload | `rotateY(0.5deg)` -> `""`, metrics `reducedMotion: true` | `PASS` | `test_harness_responds_to_live_reduced_motion_changes` + Chromium |
| Constructor-named layer retry count | Integer count without prototype pollution | `layerRetries: {"constructor": 1}`, `typeof === "number"` | `PASS` | `test_harness_counts_numeric_retry_for_constructor_named_layer` |
| Presentation 2048x2048 transparent PNG | Generates ready bundle, links T0/cutout/reference provenance | `pres_...` bundle, `needs_review`, `eligible=false`, `active_display_path="fallback.jpg"` | `PASS` | `test_valid_2048_transparent_presentation_bundle_links_provenance_and_stays_needs_review` |
| Multimodal presentation payload | Exact verbatim prompt, cutout & reference data URLs | 3 content parts, prompt matched, data URLs matched | `PASS` | `test_multimodal_request_embeds_cutout_and_reference_image_bytes_with_exact_prompt` |
| Non-square / opaque / over-budget presentation | Retains T0 fallback, records errors, CLI exits 2 | `status="fallback_retained"`, `fallback_retained=true`, `fallback.jpg` byte-identical to T0 | `PASS` | `test_opaque_non_square_or_over_budget_candidate_retains_t0_fallback` |
| Presentation fidelity warnings | Flags persist on manifest and emit review warnings | `reconstructed_details_flagged`, `preserved_original_viewpoint`, review warnings emitted | `PASS` | `test_reconstructed_details_and_viewpoint_limitations_are_recorded_in_warnings` |
| Rebase onto develop `0477653` | Linear history on top of latest PRs #63/#62/#61/#60/#57/#54 | Clean rebase, 140 Python tests pass | `PASS` | `git log origin/develop..HEAD` |

Biome also scans untracked generated `graphify-out/` JSON. That directory was moved outside the worktree only for the lint gate and restored byte-for-byte afterward; no repository file was changed for this workaround.

## Budget measurements

| Fixture | Total bytes | Budget | Status |
|---|---:|---:|---|
| T0 700x700 JPEG | 272,193 | 400,000 | `PASS` |
| T0 3000x4000 EXIF-6 JPEG | 330,054 | 400,000 | `PASS` |
| T0 fixed synthetic rerun | 36,855 | 400,000 | `PASS` |
| T1 PNG at detail-1280 | >400,000 before fallback; background 1,538 KiB, alpha subject 1,858 KiB | 400,000 | `FAIL` |
| T1 lossy WebP q82 recorded bundle | 369,408 (92.4%) | 400,000 | `PASS` |
| T1 fixed synthetic rerun (including `harness.html` + `spatial-manifest.json`) | 63,595 (48,823 image bytes + 14,772 harness/manifest bytes) | 400,000 | `PASS` |

The PNG result is a budget/product decision, not a validation defect: refusal is correct. The ADR 0004 ceiling is unreachable with lossless PNG layers at `detail-1280`; the recorded WebP q82 trial fits at 92.4%. PM and ADR owners must choose the accepted format/quality before a real sample is prepared.

## Harness evidence

The fixed bundle was served with `python -m http.server 8973 --bind 127.0.0.1`. Chromium was forced to `prefers-reduced-motion: no-preference` through CDP before reload because the headless default silently zeroes every transform.

Loaded metrics (rebased + all review fixes): `manifestFetchMs=2.8`, `firstRenderMs=15.3`, `layersLoaded=3`, `spatialVisible=true`, `fallbackVisible=true`, `spatialError=null`, `totalAssetBytes=63595`, `budgetBytes=400000`, `zIndices={"background":"1","subject":"2","accent":"3"}`. Mixed pointer+keyboard saturation check in Chromium: `Home` -> 40x `ArrowRight` -> pointer right edge -> 1x `ArrowLeft` (`rotateX(0deg) rotateY(2.5deg)`, `subject` `translate(2.66667px, 0px)`) -> `Home` (`rotateX(0deg) rotateY(0deg)`).

Evidence files, intentionally not committed:

- `processing/work/qa-vis03/harness-loaded.png`
- `processing/work/qa-vis03/harness-metrics-loaded.json`
- `processing/work/qa-vis03/harness-metrics-layer-failure.json`
- `processing/work/qa-vis03/harness-metrics-manifest-failure.json`
- `processing/work/qa-vis03/harness-metrics-fallback-failure.json`

The harness requires HTTP. Opening `harness.html` through `file://` blocks the manifest `fetch`; after one retry it shows "Preview unavailable" and retains the fallback. `processing/README.md:184-186` now documents this requirement.

## Independent code review

A separate read-only `reviewer` agent reviewed the complete working diff before commit. Verdict: `READY TO MERGE`. It found no critical or important issues. Its one minor note was that layer order forms part of the identity because it controls equal-depth paint order; `docs/asset-delivery.md:31-32` now states that the signature uses manifest order. The reviewer confirmed the two regression tests exercise the real bundle path, the new required schema fields have no TypeScript consumer, and no out-of-scope test was weakened.

## ClickUp acceptance checklist

| Acceptance criterion | Status | Evidence |
|---|---|---|
| Process sources with immutable source/revision references and processing state | `PASS` | T0 and T1 manifests carry source hashes, `source_t0`, dish/revision and ordered processing steps |
| Demonstrate one approved 2.5D sample when ready | `BLOCKED` | Only the labeled synthetic sample exists; no approved human-prepared capture |
| Failures retain approved T0 photo | `PASS` | Layer, manifest and fallback failure runs retain fallback where applicable |
| Measure mobile load/render cost against agreed budget | `BLOCKED` | Desktop headless Chromium only; no real-phone p75/p95 |
| Avoid fabricated food imagery and unapproved substitutes | `PASS` | Synthetic geometries explicitly labeled `SYNTHETIC FIXTURE`; no generated food |
| Verify missing images, failed downloads, rendering errors and retries | `PASS` | Three failure injections plus recovery runs |
| Publication eligibility requires human approval | `PASS` | Every generated manifest remains `needs_review`, `eligible=false` |
| Linked PR, CI/build and browser evidence | `PASS` | PR #25, local Python/TS/build/harness evidence in this report |
| Independent review by Sai (`@hemu77`) | `PASS` | Reviewed `786ebb4` and `388f66d`; all inline P2/P3 findings and rebase onto `#23/#24` addressed with regression tests |
| Rebase after PR #24 and rerun CI | `PASS` | Rebased onto `origin/develop` (`5c0cb3f`, including `#23` and `#24`); all 110 Python tests pass |
| Real restaurant photo, phone measurement and VoiceOver/TalkBack | `BLOCKED` | No permitted capture or device available |
| S3-ARC-01, S3-DIN-03 and S3-RES-02 alignment | `BLOCKED` | Contract freeze and downstream integration remain open |
| PM acceptance, restaurant handoff and diner approval | `BLOCKED` | Vivien, Shirley and Adam sign-off outstanding |

## Blocked and not tested

`BLOCKED`:

- Real permitted restaurant photo and real layered sample.
- Real-phone startup, frame-time and thermal measurements; the recorded viewport used DPR 1.25, not a phone.
- VoiceOver and TalkBack verification.
- PNG-versus-WebP budget decision by PM/ADR owners.
- External re-review sign-off by `@hemu77` on the rebased commit and human publication approvals (Vivien, Shirley, Adam).

`NOT TESTED`:

- Production publication API, because S3-RES-02 is not built.
- Diner viewer integration, because S3-DIN-03 is separate.
- Full 3D rendering, which is outside S3-VIS-03.
- Production deployment and real-device network variability.

## Publication record

- Initial QA fix commit: `8fa4a0bf3a53443b7e9dce60731c6ae4fdc1c783` ([issuecomment-6388963012](https://github.com/vivienk/peekaplate/pull/25#issuecomment-6388963012))
- Rebased + P2 review fix commit: `35098ad97affed0aa9bbb6efd73c5149fb97ecfd`
- PR inline review replies: [r4372018203](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372018203), [r4372018339](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372018339), [r4372018465](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372018465), [r4372018903](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372018903)
- PR rebased verification comment: https://github.com/vivienk/peekaplate/pull/25#issuecomment-6402325653
- ClickUp task `86bcnfw7r`: rebased QA summary comment `90140273173592` posted; status and assignee deliberately unchanged.
- Follow-up viewer & test fix commit: `72cdb4e`
- Follow-up PR inline review replies: [r4372231047](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372231047), [r4372231101](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372231101), [r4372231219](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372231219), [r4372231319](https://github.com/vivienk/peekaplate/pull/25#discussion_r4372231319)
- Follow-up PR verification comment: https://github.com/vivienk/peekaplate/pull/25#issuecomment-6402612252
- Follow-up ClickUp comment on `86bcnfw7r`: `90140273180794`
