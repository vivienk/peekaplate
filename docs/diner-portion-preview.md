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

## PR25 logic integrated into the diner

[PR25](https://github.com/vivienk/peekaplate/pull/25) is merged as `95fbe1a` and already
supplies the repository's offline processing modules. The relevant interaction logic
from `processing/src/peekaplate_processing/harness.py` and `review_preview_html.py`
is adapted into the diner renderer/controller, not embedded as a review-tool iframe:

- Depth-ordered layers, bounded pitch/yaw (at most ±3°), and depth-weighted 8px/4px parallax.
- Combined pointer and keyboard contributions with immediate reversal at the clamp.
- Mouse movement, horizontal touch drag, native vertical touch scrolling, Home reset,
  smooth return to center and live reduced-motion changes.
- One delayed retry for a failed layer fetch/decode before photo fallback; all work stays
  inside the eight-second attempt deadline and is cancelled on Back/disposal.
- Original photo retention for missing/invalid layers, failed WebGL and context loss.
  Missing photos show the Failed screen. Try again repeats the selected dish's load,
  including detail → card → missing-placeholder photo recovery, without pushing history.

The Three.js renderer remains lazy, event-driven and bounded. It disposes its canvas,
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
- Photo fallback: `http://127.0.0.1:5173/?scenario=portion-demo&previewState=fallback`
- Failed: `http://127.0.0.1:5173/?scenario=portion-demo&previewState=failed`

The loading scenario deliberately delays each local layer by three seconds; it then
completes normally. Fallback/failed scenarios deliberately keep failing so their
screens remain inspectable, including repeated Try again. The ready scenario is the
working captured-photo tilt demo. These use actual state transitions, not static mockups.

Demo imagery is the prior user-supplied capture/mask, not generated food. Demo menu
facts are explicitly placeholders. Demo modules, query controls and URL substitution
are DEV-only; production builds exclude the demo photo assets. Live-menu selection
is unchanged. The reserved `.invalid` mapping is development-wide, not an approval gate.

## Changed files

- Flow/UI: `frontend/diner/src/menu/dishDetail.ts`, `menuScreen.ts`, `portionPreview.ts`,
  `portionRenderer.ts`, `portionMotion.ts`, `portionDemo.ts`, `fixtures.ts`, `style.css`,
  `preview-assets/*`, and local `fixture-assets/portion-demo/*`.
- Data: `adapter.ts`, `published.ts`, `types.ts`, `wire.ts`,
  `packages/contracts/src/index.ts` and `packages/contracts/src/portion.ts`.
- Build: diner `package.json`, `pnpm-lock.yaml`, `scripts/check-bundle.mjs` and its tests.
- Checks: `portion.test.ts`, `portionMotion.test.ts`, `tests/e2e/portion.spec.ts`,
  `playwright.portion.config.ts`, and geometric texture fixtures.
- Handoff: this document, `docs/CONTEXT.md`, and sanitized observations in `errors.md`.

## Verification boundary

Node 24.16.0 / pnpm 11.25.0, local isolated branch `codex/diner-portion-integration`.
Based on develop `96b8de1`; PR25, PR69 and PR136 are already in that base.

- PASS: `pnpm exec vitest run frontend/diner/src/menu packages/contracts/src/index.test.ts` — 213 tests.
- PASS: `pnpm verify lint typecheck build` — all packages; Worker build is a dry-run.
- PASS: `pnpm exec playwright test --config playwright.portion.config.ts --workers=2` — 42 behavior/regression cases passed; three new icon assertions needed a test-only correction for Vite SVG data URLs.
- PASS: `pnpm exec playwright test --config playwright.portion.config.ts tests/e2e/portion.spec.ts --grep Figma --workers=2` — all four state checks passed after that correction. All 45 cases now have passing evidence.
- PASS: `pnpm verify lint context:check docs:check` and `git diff --check`.
- Inspected all four 390px screenshots: exact icon assets, geometry, copy, Back and retry placement. Dynamic captured imagery differs from the design sample by intent.
- NOT RUN: physical phones, manual VoiceOver/TalkBack, genuine approved publication,
  hosted asset loading, full default browser suite and database suite.

Local screenshots, synthetic bundle tests and a supplied-photo demo are not production
acceptance. No push, PR creation, merge or deployment has been performed.
