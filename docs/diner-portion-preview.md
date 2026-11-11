# Diner portion preview

The View Portion button now switches the existing dish-detail shell into its preview state.
It retains the selected dish name, price, description and original photograph. Back, Escape
and browser Back restore the same detail DOM, scroll and CTA focus; menu return retains the
existing category/search behavior. No separate preview page or review-tool iframe is used.

Reference: existing `dishDetail.ts` at develop `96b8de1`, DIN-04/DIN-04A in the
[implementation plan](implementation_plan.md), and [ADR 0004](adr/0004-visual-tiers.md).
That base contains a disabled View Portion action but no implemented preview screen.
This reuses its top bar, image region, dish text and tokens. Final Figma/design acceptance
is still required; no newly inspected Figma frame is claimed.

## Asset handoff

`PublicMenuCompleteDishSchema` accepts an optional `portion` described by
`PublicPortionSchema` in `packages/contracts/src/portion.ts`. Existing photo-only bundles
remain valid. A public portion contains schema version 1, exact dish/revision UUIDs,
shared width/height, and two to six layer records with HTTPS URL, SHA-256, byte length
and depth. Exactly one depth is zero, at least one is positive, all depths are 0–1.
Texture dimensions are limited to 2048 on each axis, URLs to 2048 characters, serialized manifest bytes to 20 KB, and total
layer bytes to 180 KB. All layers share the captured frame and must be reviewed together.

The published-menu adapter copies this optional field through to the diner model. An
identity mismatch is discarded rather than displaying another dish's assets. The renderer
fetches only these URLs, without credentials or redirects, and checks exact byte length,
SHA-256 and decoded dimensions before showing a canvas. Public asset hosting needs CORS.
The eight-second attempt deadline includes dynamic import, fetch and decode. Missing assets,
invalid identity, fetch/decode/hash/dimension failures and WebGL loss retain the dish photo;
if the photo also fails, the dish text and back action remain usable.

This is a public-delivery shape, **not** PR25's private processing manifest. Processing
outputs remain `needs_review` and `publication.eligible=false`; no browser approval flag
or guessed asset path converts them. The existing producer has no mapping from reviewed
spatial layers into this optional field yet. Asset review, producer handoff, asset-manifest
approval binding and an immutable approved publication must be completed before enabling
real dish visuals. Do not hand-edit a live bundle or substitute generated edible surfaces.

No actual-size, weight, portion-measurement or nutrition claim is added. The menu's existing
approved description is retained; absent portion facts are not invented. No new observation
events or changes to consent, publication refresh or other diner actions are introduced.

## Renderer and verification boundary

Three.js 0.183.2 is pinned and dynamically imported only after View Portion has a valid
manifest. Its mount/update/dispose lifecycle owns one canvas, textures, materials, geometry,
image bitmaps and observers. Drawing is event-driven, paused offscreen/in a hidden document,
with bounded ±3° tilt, keyboard access and reduced-motion support. Photo fallback needs no
WebGL. The initial graph budget remains 150 KB gzip; the T1 build check reserves 180 KB
for layers and 20 KB for the manifest within the 400 KB total allowance.

Run `pnpm exec vitest run frontend/diner/src/menu packages/contracts/src/index.test.ts`
and `pnpm exec playwright test --config playwright.portion.config.ts --workers=2`.
The dedicated browser configuration runs the real diner with intercepted synthetic public
bundles and simple geometric PNG layers, with distinct foregrounds for two dishes. These are test shapes, not restaurant captures.
It also checks existing menu states, publication integrity and refresh behavior.

Physical-device performance, manual screen readers, captured-food fidelity, real approved
asset hosting/publication and hosted end-to-end acceptance remain unverified. No deployment
or production activation is part of this change.


## Changed files

- UI and navigation: `frontend/diner/src/menu/dishDetail.ts`, `menuScreen.ts`,
  `portionPreview.ts`, `portionRenderer.ts`, and `frontend/diner/src/style.css`.
- Data handoff: `frontend/diner/src/menu/adapter.ts`, `published.ts`, `types.ts`, `wire.ts`,
  `packages/contracts/src/index.ts`, and `packages/contracts/src/portion.ts`.
- Dependencies and budget: `frontend/diner/package.json`, `pnpm-lock.yaml`,
  `scripts/check-bundle.mjs`, and `scripts/check-bundle.test.mjs`.
- Tests: `frontend/diner/src/menu/portion.test.ts`, `tests/e2e/portion.spec.ts`,
  `playwright.portion.config.ts`, and the three geometric PNGs in `tests/fixtures/portion/`.
- Handoff and verification: this document, `docs/CONTEXT.md`, and `errors.md`.

The implementation is isolated on `codex/diner-portion-integration`, based on develop
`96b8de1d70ff599179f6eb5dbd7557a589c27a45`. Related PR25 (asset preparation), PR69
(menu/detail), and PR136 (published-menu connection) are already merged into this base.
Tracking PR77/80/84 were also confirmed merged; this change adds no tracking events.

Before claiming live T1 analytics, resolve the public response's existing T0 tier semantics
and connect actual-tier exposure observations. This is separate from rendering and is not
silently inferred from a View Portion click.


## Verification record — November 10, 2026

Commands used Node 24.16.0 and pnpm 11.25.0. PASS means local evidence only.

| Command | Result |
| --- | --- |
| `pnpm exec vitest run frontend/diner/src/menu packages/contracts/src/index.test.ts` | PASS, 210 tests on final application sources |
| `pnpm exec playwright test --config playwright.portion.config.ts --workers=2` | PASS, 38 tests, 1.8 minutes; includes existing menu/publication regressions |
| `pnpm exec playwright test --config playwright.portion.config.ts tests/e2e/portion.spec.ts --workers=2` | PASS, final 12 preview cases, 1.1 minutes after distinct-image/tilt assertions and manifest byte cap |
| `pnpm check` | PASS, 1,210 unit tests plus 73 script tests, 4 optional skips on implementation commit 70913ed, before the final manifest-byte test/refinement |
| `pnpm verify lint typecheck build context:check docs:check` | PASS on final application sources; both frontends and Worker dry-run |
| `git diff --check` | PASS |
| `pnpm verify test:db` | NOT RUN; no database/migration or backend behavior change |
| Full default browser suite, physical phones and manual screen readers | NOT RUN; focused browser configuration covers the affected diner flow |

The final build's budget check reports 51,945 gzip bytes for initial diner JavaScript
(limit 150,000) and a 324,288-byte T1 delivery allowance (limit 400,000). The emitted
renderer file is about 125 KB gzip. No renderer appears in the initial import graph.
The 390px preview screenshot was inspected; it displays clearly synthetic geometry.

Two independent automated read-only reviews of 70913ed found no supported blocking
architecture/correctness defects. Final refinements tighten the serialized byte cap
and add distinct-rendered-image/keyboard evidence; they do not change navigation.
These reviews are not human approval or production acceptance. No branch push,
PR creation, merge or deployment was performed.
