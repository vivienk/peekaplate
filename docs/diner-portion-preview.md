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
Texture dimensions are limited to 2048 on each axis, URLs to 2048 characters, and total
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
bundles and two simple geometric PNG layers. These are test shapes, not restaurant captures.
It also checks existing menu states, publication integrity and refresh behavior.

Physical-device performance, manual screen readers, captured-food fidelity, real approved
asset hosting/publication and hosted end-to-end acceptance remain unverified. No deployment
or production activation is part of this change.
