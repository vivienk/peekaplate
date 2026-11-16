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

Deployment requires the migration, backend/frontend release, saved owner logo, operator-prepared and hosted bundle/assets, and explicit menu approval/publication. Validate Noka's actual assigned diner URL after these gates. Real-device camera/AR, image rights, physical-size calibration, and the operational retention/deletion policy for private superseded logo objects and profile contact/address fields in projections, event payloads and command receipts remain separate acceptance work. Tests and local previews do not establish live approval or production readiness.

## Synthetic browser evidence

These screenshots exercise the real published-menu loader with labelled synthetic assets, not a live restaurant publication. The wide logo stays centered and intact at [390px](evidence/published-logo-390.png) and [1280px](evidence/published-logo-1280.png). Automated checks also cover 320px and 768px widths, missing logos, cross-dish navigation and invalid portion assets.

## Noka staging acceptance checklist

The PR's [diner preview](https://pr-215.peekaplate-diner-preview.pages.dev) and
[console preview](https://pr-215.peekaplate-console-preview.pages.dev) are static,
fixture-only builds with API access disabled. They are not the Noka acceptance
site. Verify their `/peekaplate-preview.json` commit before reviewing a new push.

1. **Release operator:** apply the forward migration above and deploy the reviewed
   backend and console commits to staging. Build the diner with
   `VITE_MENU_SOURCE=live`,
   `VITE_PUBLIC_API_URL=https://peekaplate-api-staging.vxkong.workers.dev`, staging
   mode and `/diner/` base, then deploy the assembled artifact to the existing
   `routing-staging.peekaplate-diner-staging.pages.dev` branch. Record all three
   deployed commit IDs. Preserve existing auth, runtime database and private
   storage bindings. No production/DNS change is required.
2. **Noka owner:** identify the actual tenant/menu IDs and sign in with current
   owner membership. Save the real logo in Restaurant Details (Screen 5), reload,
   and confirm the same image and profile version. Confirm dish revisions, prices,
   ingredients, food declarations and photographic rights; the external restaurant
   menu URL alone supplies none of those approvals. Missing food information stays
   unknown and must not be inferred from generated artwork.
3. **Asset/operator handoff:** provide verified T0 card/detail assets for those
   revisions and, for at least two test dishes, approved captured portion layers
   with exact dish/revision IDs, URL, size, dimensions and SHA-256. Run the producer
   above with `--owner-profile-api` and protected environment credentials. Inspect
   its diagnostics and exact output bytes. Host only the public bundle/logo/T0/
   portion files on immutable deployment URLs under the permitted staging diner
   Pages host; never upload the private request, handoff report or source captures.
   Verify anonymous HTTPS reads, exact hashes and CORS for the routing-staging
   origin. Then rerun the identical producer request with `--admit` through the
   privileged operator connection. Admission is not publication.
4. **Artwork reviewer:** enable `INGREDIENT_ARTWORK_ENABLED=true` in the staging
   backend with its private artwork bucket binding (or the existing ingestion
   bucket fallback). Approve the real generated icon bytes for Noka's normalized
   ingredient labels through `/venues/:venueId/ingredient-icons/review`, with
   current command IDs/versions. Confirm the public label lookup and hashed image
   endpoints return only currently approved artwork. Missing approval should
   deliberately display the local fallback, not trigger generation.
5. **Noka owner:** open Menu → Review and publish, select the admitted snapshot,
   inspect it, and explicitly approve/publish. Retrieve the actual returned diner
   link (`Location` or authenticated `GET /venues/:venueId/menus/:menuId/diner-link`).
   Do not assume the slug is `noka_ramen`: it is server-assigned and may differ.
   The expected host is
   `https://routing-staging.peekaplate-diner-staging.pages.dev/diner/{assigned-slug}`.
6. **Acceptance reviewer:** open that exact URL without a staff session. Record
   the publication ID/revision/hash and deployed commits. Check logo fidelity at
   320/390/768/1280px; open two different dishes, View Portion and browser Back;
   verify each layer belongs to the displayed revision; verify no-WebGL 2.5D and
   correct-dish photo fallback; inspect approved ingredient artwork and fallback
   labels. Use browser request blocking for missing images, and a separate
   synthetic publication for tampered/wrong-revision/revocation/withdrawal cases;
   do not alter Noka's approved files or revoke its artwork merely for a test.
   Record console/network failures, CORS, screenshots and physical-device camera
   results separately. A static preview or successful local suite cannot satisfy
   this hosted checklist.

Outstanding inputs are Noka's authorized tenant/menu identity and owner session,
restaurant-confirmed content, actual uploaded logo, approved T0/portion/artwork
assets, and release/operator execution. This PR does not provision or publish
those inputs. The public `noka_ramen` lookup was rechecked on November 16, 2026 and
still returned 404; the owner-assigned link is the authority if it differs.

## Serving count and measured table placement

Screen 9's Serving Size now records a whole number of people (1–100), or unknown
when blank. Both manual draft snapshots and extracted-dish review corrections
persist it; explicit approval snapshots it onto the dish revision. The producer
reads that approved snapshot into `serving_count`; later draft edits cannot change
an already published dish. Old events/bundles without the optional field remain
readable and never acquire an invented serving count. No schema migration is
needed: existing versioned JSON snapshots store the added optional field.

For measured AR, the operator must supply `portion.physical_size.serving_count`
equal to the approved dish's count, together with the existing owner-confirmed
plate dimensions, source boundary and foreground hash. The producer rejects
missing/mismatched serving bindings on calibrated portions. The diner checks the
binding again before offering measured table AR. Serving two people never doubles
a length: a separately measured 320 mm plate for two uses 320 mm, and a 240 mm
plate for one uses 240 mm. Each distinct serving option needs its own approved dish
revision/assets and measurements; there is no diner-side serving multiplier.

WebXR hit-test placement uses metres and locks the measured plate footprint at
1:1, with the visual-size slider hidden. The image remains a flat cutout, not a
measurement of food height/volume; device validation is still pending. The
ordinary camera preview and CSS 2.5D fallback are labelled approximate. Missing
count/calibration, a different serving, or unavailable tracked AR must never be
presented as actual-size placement. The existing local upload/calibration tools
remain review-only; restaurant measurements and physical-device acceptance are
still required before claiming the Noka result is true to scale.
