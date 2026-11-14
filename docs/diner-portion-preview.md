# Diner portion preview

## Flow and four preview states

View Portion switches the mounted dish-detail shell into the selected dish's preview.
Back, Escape and browser Back restore the same detail DOM, scroll and CTA focus.
Menu return retains category/search behavior. Dish facts remain on the restored
detail screen; preview hides that card and keeps the dish-name header.

The four state categories come from the supplied PeekaPlate Figma file `l7A9n8tACJic0FIhY49Zjw` was inspected in the browser:

| State | Frame | Behavior |
| --- | --- | --- |
| Loading | 846:7146 | Blurred, muted dish photo with exported 64px spinner and loading copy |
| Ready | 258:6000 | Dark Figma stage, centered 250px interactive dish and 46px gesture hint |
| Photo fallback | 221:260 | Original dish photo and the two-line fallback message |
| Failed | 165:2413 | Exported 150px illustration, failure copy and Try again |

The shared Back artwork is an exact 42px SVG export. Assets and source node IDs are
recorded in [preview-assets](../frontend/diner/src/menu/preview-assets/README.md).
Failure/loading artwork remains unchanged. The latest user direction selects the Figma screen designs while retaining the accepted PR25 generated image and movement. The preview uses dark surface, Inter typography, centered imagery and original exported artwork. Compare/reset and local image selection remain in an expandable Preview controls area below the composition. Other screens retain their typography.
Web safe-area insets replace the design's native iOS status bar; fake device time and
battery icons are not rendered. Food imagery remains selected-dish data.

## PR25 processing and interaction integration

[PR25](https://github.com/vivienk/peekaplate/pull/25) is merged as `95fbe1a` and already
supplies the repository's offline processing modules. The new
`processing/src/peekaplate_processing/diner_demo.py` directly calls PR25's
`prepare_review_preview` with a verified T0 manifest and supplied mask. That processor
verifies the source, creates the cutout, retains the original fallback and records
provenance. The adapter converts that cutout to bounded WebP layers and exports
`demo.json`; `portionDemo.ts` and `fixtures.ts` consume its actual dish/revision IDs,
dimensions, hashes and motion limits. The review manifest remains attached with
`needs_review` and `publication.eligible=false`. The public delivery adapter accepts no generated candidate.

To regenerate from a captured T0 bundle and matching grayscale mask, use the processing
Python environment (Pillow and Pydantic required), from the repository root:

```sh
PYTHONPATH=processing/src python -m peekaplate_processing.diner_demo \
  --t0-manifest /path/to/t0/manifest.json \
  --mask /path/to/supplied-mask.png \
  --output-dir /path/to/new-demo-directory \
  --capture-evidence 'Source capture evidence; local review only'
```

Output is create-only. Copy the generated `demo.json`, `photo.jpg`, `dish.webp` and
`background.webp` into `frontend/diner/src/menu/fixture-assets/portion-demo/` together.
Never relabel this output as approved public content. This integrates PR25's captured
photo/supplied-mask path; it does not invoke optional generated presentation candidates
or create a hosted approval/publication service.

The local review demo additionally restores the exact earlier `cutout.png` and
`presentation.png` from review asset `review_b2f135ce8784a517ca9cf1f3fbc8fcbf`.
`review-images.json` preserves their original hashes, dimensions and needs-review,
publication-ineligible provenance. The selector defaults to the generated presentation;
choose Original cutout to inspect the supplied-mask result. Neither PNG is re-encoded.
This override requires DEV, the explicit portion-demo scenario, matching dish/revision
and reserved fixture URLs. Its private images are capped at 10 MB each; it does not
relax the 180 KB public contract. Production excludes both images and the selector.

Movement and image handling follow `review_preview_html.py`; screen composition follows the three requested Figma frames:

- CSS `perspective(900px)`, at most ±3° pitch/yaw, and foreground translation up to
  5px horizontally / 3px vertically. Manifest motion limits can restrict rotation.
- One shared clamped x/y position: pointer movement replaces it; arrow keys adjust
  it by 1/6. Pointer tracking uses 55ms linear transitions; keys/reset use 300ms ease-out.
- Horizontal touch tilt, native vertical scrolling, Home/reset, pointer-leave/blur reset,
  touch-release reset and immediate live reduced-motion handling.
- Centered 250px stage within the existing 390px diner shell on #2a2d36, with
  contained cutout and `drop-shadow(0 14px 9px #2223)`. The spatial backdrop layer is
  verified but visually omitted; positive-depth layers move together. No WebGL or Three.js
  dependency remains. The 42px Back, 64px loading, 46px hand and 150px unavailable
  exports retain their native geometry. Loading uses 20.5px blur at 61% opacity.
- Show original photo / Show review candidate switches the mounted original and card,
  resets motion and updates aria-pressed. Reset view centers the card. Compare is disabled
  until the original and cutout are ready. Original-photo failure blocks interactive view.
- Loading, ready, photo fallback and failed/retry states remain in the same detail shell.
  Missing or invalid cutouts retain the photo; missing photos show the failure illustration.
  Retry preserves history; Back/Escape restores detail focus and scroll.

Both images and delivered layers remain bounded and validated. One delayed layer retry
stays within the eight-second attempt deadline; Back cancels loads and releases blob URLs.
No reviewer downloads or publication actions are exposed in the diner UI.

## Asset handoff and publication boundary

The optional public `portion` field is revision-bound and validated by
`PublicPortionSchema`. It contains width/height, two to six HTTPS layers with exact
byte lengths, SHA-256 and depths, and optional PR25-shaped motion limits. Existing
photo-only menus and manifests without motion remain compatible (default ±3°).
Exactly one layer has depth zero and at least one has positive depth. Dimensions
are capped at 2048, combined layer bytes at 180 KB, and serialized manifest at 20 KB.
The renderer verifies fetched lengths, hashes and decoded dimensions; it does not
send credentials or follow redirects. Production asset hosting requires CORS.

The public shape is distinct from PR25's private processing manifests. Those outputs
remain `needs_review` and `publication.eligible=false`; they are not promoted by this
viewer. Reviewed asset mapping, approval-bound manifests and immutable publication
remain prerequisites for real restaurant visuals. No backend route, approval, cloud
upload, deployment, tracking event or live-menu activation is added here.

## Try all states locally

Start `pnpm --filter @peekaplate/diner dev`, open one of these URLs, select the demo
dish, then View Portion:

- Ready: `http://127.0.0.1:5173/?scenario=portion-demo`
- Loading then Ready: `http://127.0.0.1:5173/?scenario=portion-demo&previewState=loading`
- Interactive cutout (legacy fallback demo link): `http://127.0.0.1:5173/?scenario=portion-demo&previewState=fallback&demoVisual=cutout`
- Photo fallback (missing cutout assets): `http://127.0.0.1:5173/?scenario=portion-demo&previewState=photo`
- Failed: `http://127.0.0.1:5173/?scenario=portion-demo&previewState=failed`

The loading scenario deliberately delays each local layer by three seconds; it then
completes normally. Photo/failed scenarios deliberately keep failing so their
screens remain inspectable, including repeated Try again. The ready scenario is the
working review-image tilt demo. These use actual state transitions, not static mockups.

Demo imagery includes the prior user-supplied capture/mask and the earlier generated presentation, explicitly labelled for local review only. Demo menu
facts are explicitly placeholders. Demo modules, query controls and URL substitution
are DEV-only; production builds exclude the demo photo assets. Live-menu selection
is unchanged. The reserved `.invalid` mapping is development-wide, not an approval gate.

## Changed files

- Flow/UI: `frontend/diner/src/menu/dishDetail.ts`, `menuScreen.ts`, `portionPreview.ts`,
  `portionRenderer.ts`, `portionAssets.ts`, `portionMotion.ts`, `portionDemo.ts`, `fixtures.ts`, `style.css`,
  `preview-assets/*`, and local `fixture-assets/portion-demo/*`.
- Data: `adapter.ts`, `published.ts`, `types.ts`, `wire.ts`,
  `packages/contracts/src/index.ts` and `packages/contracts/src/portion.ts`.
- Build: diner `package.json`, `pnpm-lock.yaml`, `scripts/check-bundle.mjs` and its tests.
- Checks: `portion.test.ts`, `portionMotion.test.ts`, `tests/e2e/portion.spec.ts`,
  `playwright.portion.config.ts`, and geometric texture fixtures.
- Processing: `processing/src/peekaplate_processing/diner_demo.py` and
  `processing/tests/test_diner_demo.py`.
- Handoff: this document, `docs/CONTEXT.md`, and sanitized observations in `errors.md`.

## Verification boundary

Node 24.16.0 / pnpm 11.25.0, local isolated branch `codex/diner-portion-integration`.
Based on develop `96b8de1`; PR25, PR69 and PR136 are already in that base.

Final command results and all four screenshots are recorded in
[the PR evidence report](../qa-reports/diner-portion-preview/README.md).

Local screenshots, synthetic bundle tests and a supplied-photo demo are not production
acceptance. No merge or deployment is authorized by this change.

## Local camera / AR portal

The explicit DEV `?scenario=portion-demo` flow opens the camera automatically from **View Portion**, with the 2.5D dish already visible. Preview controls retain **View on your table** for reopening. This is a modal portal shared by the current exact 2.5D cutout and the validated local 3D job, when available. Generation remains separate: opening the portal does not upload camera frames or submit a Tripo job.

- Supported immersive-AR browsers request hit-test and DOM overlay from an explicit **Start table AR** tap. The placement ring appears only on an approximately horizontal, upward-facing detected surface. The first valid table hit automatically positions the cutout/model; **Reposition**, rotation and visual-size controls adjust the same scene.
- The default preview starts the camera automatically, requesting browser permission if needed. This uses a local camera stream behind the same renderer and clearly labels placement as manual, without surface tracking. The dish is immediately centered; tap to reposition. It is not world-anchored AR.
- **Show 3D / Show 2.5D** switches representations at the same position. A missing or broken GLB keeps 2.5D; both are explicitly visual scale, not calibrated portion measurement. Cutout geometry remains a flat image at the contact point, not reconstructed volume.
- Camera permission is requested when View Portion opens. Denial leaves Back usable. Closing, Escape, browser Back, page exit or a hidden manual-camera page stops camera tracks; a stream arriving after dismissal is stopped immediately. XR end closes the portal and returns to the established preview.

This feature and its Three.js bundle are excluded from production builds. Localhost is secure for camera permissions on the computer running the server. Phone testing needs a secure reachable origin or localhost port forwarding; the current loopback setup does not automatically make the demo reachable from a phone. No deployment, public tunnel or new permissions were configured.

Verification boundary: browser tests use a synthetic camera stream and a labelled synthetic triangle GLB with the real Three.js renderer. They cover placement controls, rotation input, 3D/2.5D switching, failed GLB, denied/pending permissions, XR-request fallback and stream cleanup. Real device surface detection, tracking stability, physical-scale quality and a real generated dish in AR require device testing; desktop checks are not that evidence.

AR verification on November 12, 2026: full 63-test portion/menu browser suite passed; two additional textured-GLB cleanup regressions passed. Lint, typecheck, context/docs checks and build passed. Production JavaScript was checked to exclude portal controls and the GLTF loader. Camera feeds in automated tests are synthetic; physical table tracking is still NOT RUN.

The local demo now opens the camera/table portal automatically on the first ready 2.5D screen. The camera and visible cutout start automatically; immersive AR remains an optional explicit upgrade. Back returns to the existing preview; changing the cutout does not reopen the portal. Preview controls retain a manual reopen button.

## Hosted PR camera demo
PR builds opt into the captured-dish camera demo through the existing PEEKAPLATE_PREVIEW_DEMOS build flag. Open `/?scenario=portion-demo`, select the dish and View Portion. HTTPS allows camera permission on phones; camera starts automatically and the 2.5D cutout is visible immediately. The dialog fits up to 390 × 844 CSS pixels, with full-viewport immersive AR if available. Tripo generation and the loopback bridge remain DEV-only; normal production builds exclude the demo.

PR #145 menu integration: the hosted demo retains the full Ember & Stone fixture menu and categories, with the captured-dish demo in its first slot. Header/logo/search, outline hearts, Back, and dish-information icons follow #145. Existing Save/Compare behavior is unchanged; this is a visual integration, not the dependent Saved-route implementation. Other dishes retain their own assets or the unavailable preview.


## Owner plate calibration (PR162)

Local review upload now accepts the owner's round plate diameter or rectangular width/depth (cm). After selecting the original photo, adjust the visible boundary using Left/Top/Width/Height percentages, then explicitly confirm the measurement and boundary. Changing any input or photo clears confirmation. Generate preview without confirmation retains approximate sizing.

The ingestion API accepts `X-Plate-Calibration` JSON; CLI accepts `--plate-calibration plate.json`, and batch jobs accept `plate_calibration`. Fields: `shape` (`round` or `rectangular`), `width_mm`, `depth_mm` (30–1000 integer mm), `source_sha256`, EXIF-oriented `source_width_px` / `source_height_px`, normalized `boundary: {x,y,width,height}`, and `confirmed: true`. Round width and depth must match. The processor validates against the exact uploaded original before emitting a foreground-hash-bound `physical_size`; a mismatched photo or invalid boundary is rejected. Legacy serving width alone never enables calibrated scale. Outputs remain needs-review and publication-ineligible.

The image frame width in world metres is `plate.width_mm / 1000 / boundary.width`; transparent margins, utensils and garnish do not define the plate width. In tracked table AR, a fixed-size circle/rectangle footprint uses the supplied real plate dimensions. The upright 2.5D card remains an approximation, particularly for angled source photos; this does not recover depth or guarantee visual accuracy. Generated 3D bounds are not treated as a calibrated plate. Physical-device validation remains pending. Plain camera mode always says approximate, regardless of owner measurements; it has no measured table distance.

Original photo / Return to AR is directly available in the fullscreen portal and preserves the exact source URL. Existing Compare, back navigation, four preview states and PR147 menu photographs remain intact. No default dimensions were invented for fixtures. The owner calibration editor/private upload bridge is local DEV-only; this change does not expose a public upload endpoint or add owner-console publication.


## Direct plate interaction (PR162)

The camera portal now offers direct pointer/touch drag-to-tilt. Seven copies of the captured cutout, with progressively darker back layers, imply a thin plate edge; no new food image is generated. The reference Figma Make preview was inspected on 2026-11-13: 900px perspective, seven layers at 1.6px spacing, and a 450ms cubic-bezier(.22,1,.36,1) transform transition. The Three renderer adapts these visual settings to world coordinates. Motion is bounded to 24 degrees pitch, 10 yaw and 12 roll; it does not expose the missing back of a 2.5D photograph.

Drag changes appearance only. The owner's calibrated footprint stays outside the tilted/scaled content group, preserving its physical dimensions and table anchor. Reposition explicitly recentres camera placement or reacquires a tracked table; taps no longer teleport the dish. Reset tilt returns to neutral. Arrow keys and Home update immediately; reduced motion uses smaller direct movements with no settling animation. Original photo and 3D mode disable the 2.5D gesture. Back/disposal releases pointer capture, animation frames and media-query listeners. Camera mode remains labelled approximate.
