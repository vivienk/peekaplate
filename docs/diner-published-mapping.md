# Published diner branding, portion and ingredient mapping

Screen 5 saves a private versioned restaurant profile. JPEG/PNG uploads are decoded in the browser and normalized to PNG at at most 1024 by 512 pixels, preserving the whole image and aspect ratio. The server bounds and validates the PNG, stores content-addressed bytes in `INGESTION_REPORTS_BUCKET`, and commits a tenant-scoped profile event, projection, command receipt and outbox together. A retry returns the same receipt; stale versions conflict. Saving a profile does not publish it.

## Owner to public bundle

Apply migration `20261116010000_restaurant_profile.sql` before using the new Screen 5 API. Owner/editor membership is checked on every read, write and logo download. Contact/address fields stay private. The diner never reads this authenticated API.

The existing operator-controlled producer can use the saved profile:

```sh
pnpm produce:bundle --request work/request.json --t0-root work/t0 \
  --owner-profile-api https://peekaplate-api-staging.vxkong.workers.dev \
  --out work/menu-bundles
```

Supply the existing database credential and `PEEKAPLATE_OWNER_TOKEN` through the operator environment, never a command argument or a `VITE_*` variable. The API origin must be a bare HTTPS origin. The producer fetches the private saved profile and exact logo bytes with redirects disabled, checks size and SHA-256, and writes the logo beneath `work/menu-bundles/assets/restaurant-logos/{venue}/{hash}.png`. Host that assets subtree at the request's `asset_base_url`, alongside the existing T0 assets. Only the name and public image descriptor enter the immutable bundle. Private API URLs, tokens and contact data do not. A profile changed during download fails safely if its logo is no longer current.

Without `--owner-profile-api`, the historical restaurant-confirmed request remains supported; it does not establish Screen 5 provenance. Upload/hosting, review-subject admission, approval and publication remain explicit operator/owner steps. A later profile edit requires a new reviewed bundle and publication. Logo descriptors contribute to the asset approval hash.

## Portion and artwork

The operator-confirmed dish request accepts an optional `portion` matching `PublicPortionSchema`. Supply only reviewed captured-dish layers, with exact public HTTPS URLs, hashes, byte lengths and dish/revision IDs. Processing review manifests are not approval. Production refuses a different dish or revision and includes the portion in both the public dish and asset approval hash. The diner verifies bundle bytes and identities, then verifies every portion layer's size/hash/dimensions. Missing or failed layers retain the selected dish's original photo. CSS 2.5D works without WebGL; table preview is offered for approved portions without automatically requesting camera access. No fixture camera imagery is substituted into a published dish via query parameters.

Ingredient names retain their published identities and labels. Venue-approved artwork is looked up using the existing normalized label contract, and its image URL uses the same public API base. Responses are bounded, require approved state and hash, and reject unexpected/duplicate labels. Leaving the dish cancels refreshes. Failed or revoked images revert to local exact-name icons, with a neutral plate icon for unknown names; the ingredient text remains visible. No icon generation runs in the diner.

The header uses the bundle logo instead of the generic emblem/wordmark. A responsive 240px maximum by 72px container centers it with `object-fit: contain`; important logo content is not cropped. Missing/broken logos show the restaurant name.

## Hosting and acceptance boundary

Build the actual public diner with `VITE_MENU_SOURCE=live` and `VITE_PUBLIC_API_URL=https://peekaplate-api-staging.vxkong.workers.dev`. Generic fixture previews deliberately remain fixtures. Immutable bundle, logo and portion URLs must be reachable from the diner origin; portion byte verification needs asset CORS. Prepared-menu review currently permits only the existing staging Pages asset hosts.

On November 16, 2026, the staging API's `/public/restaurants/noka_ramen` returned 404 with the expected routing-staging CORS header. `https://nokaramen.com/menu` is a restaurant source page, not a PeekaPlate publication. This check does not prove that Noka is absent under every possible link. No live Noka bundle, approved logo, portion layers or artwork approval was available for end-to-end acceptance; no restaurant content was copied into synthetic fixtures or published by this change.

Deployment requires the migration, backend/frontend release, saved owner logo, operator-prepared and hosted bundle/assets, and explicit menu approval/publication. Validate Noka's actual assigned diner URL after these gates. Real-device camera/AR, image rights, physical-size calibration, and the operational retention policy for private superseded logo objects remain separate acceptance work. Tests and local previews do not establish live approval or production readiness.
