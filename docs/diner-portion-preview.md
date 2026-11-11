# Diner portion preview

## Flow and four Figma states

View Portion switches the mounted dish-detail shell into the selected dish's preview.
Back, Escape and browser Back restore the same detail DOM, scroll and CTA focus.
Menu return retains category/search behavior. Dish facts remain on the restored
detail screen; preview hides that card and keeps the dish-name header.

The supplied PeekaPlate Figma file `l7A9n8tACJic0FIhY49Zjw` was inspected in the browser:

| State | Frame | Behavior |
| --- | --- | --- |
| Loading | 846:7146 | Blurred, muted dish photo with exported 64px spinner and loading copy |
| Ready | 258:6000 | Centered dish layers, exported 46px hand icon and drag hint |
| Photo fallback | 221:260 | Original dish photo and the two-line fallback message |
| Failed | 165:2413 | Exported 150px illustration, failure copy and Try again |

The shared Back artwork is an exact 42px SVG export. Assets and source node IDs are
recorded in [preview-assets](../frontend/diner/src/menu/preview-assets/README.md).
Exports are unmodified and used at their root dimensions. Inter is self-hosted under
an alias scoped to preview, so other screens keep their existing typography.
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
`needs_review` and `publication.eligible=false`. No generated candidate is accepted.

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

The relevant interaction logic
from `processing/src/peekaplate_processing/harness.py` and `review_preview_html.py`
is adapted into the diner renderer/controller, not embedded as a review-tool iframe:

- Depth-ordered layers, bounded pitch/yaw (at most ±3°), and depth-weighted 8px/4px parallax.
- Combined pointer and keyboard contributions with immediate reversal at the clamp.
- Mouse movement, horizontal touch drag, native vertical touch scrolling, Home reset,
  smooth return to center and live reduced-motion changes.
- One delayed retry for a failed layer fetch/decode before photo fallback; all work stays
  inside the eight-second attempt deadline and is cancelled on Back/disposal.
- PR25 CSS interactive cutout on unavailable WebGL or context loss. Original photo retention for missing/invalid layers or unsupported CSS transforms.
  Missing photos show the Failed screen. Try again repeats the selected dish's load,
  including detail → card → missing-placeholder photo recovery, without pushing history.

The Three.js renderer remains lazy, event-driven and bounded. Its CSS fallback uses PR25 perspective(900px), bounded rotation and depth-ranked layers without WebGL. Both paths verify exact bytes, hashes and decoded dimensions. It disposes its canvas,
textures, geometry, bitmaps, observers and short animation frames. No idle animation loop.
Photo fallback requires no WebGL. No actual-size, weight or nutrition claim is added.

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
- Interactive cutout fallback (no WebGL): `http://127.0.0.1:5173/?scenario=portion-demo&previewState=fallback`
- Photo fallback (missing cutout assets): `http://127.0.0.1:5173/?scenario=portion-demo&previewState=photo`
- Failed: `http://127.0.0.1:5173/?scenario=portion-demo&previewState=failed`

The loading scenario deliberately delays each local layer by three seconds; it then
completes normally. Photo/failed scenarios deliberately keep failing so their
screens remain inspectable, including repeated Try again. The ready scenario is the
working captured-photo tilt demo. These use actual state transitions, not static mockups.

Demo imagery is the prior user-supplied capture/mask, not generated food. Demo menu
facts are explicitly placeholders. Demo modules, query controls and URL substitution
are DEV-only; production builds exclude the demo photo assets. Live-menu selection
is unchanged. The reserved `.invalid` mapping is development-wide, not an approval gate.

## Changed files

- Flow/UI: `frontend/diner/src/menu/dishDetail.ts`, `menuScreen.ts`, `portionPreview.ts`,
  `portionRenderer.ts`, `portionCssRenderer.ts`, `portionAssets.ts`, `portionMotion.ts`, `portionDemo.ts`, `fixtures.ts`, `style.css`,
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
