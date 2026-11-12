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
