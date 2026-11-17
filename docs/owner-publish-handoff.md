# Prepared menu → owner publication → diner

The S13 handoff. Sai's #197 added the data and publication flow below with a temporary
screen; the official S13 presentation (S6-FE-14, `frontend/console/src/publish/MenuPreview.tsx`)
now replaces that screen and keeps this flow unchanged. It follows Figma `3123:12796` /
`3123:12319` (preview), `3123:12795` (Publish Confirmation) and `3123:12742` (live, with Copy
Link), and reuses the merged onboarding layout and buttons. Before publishing, the phone shows the
prepared snapshot in the diner's menu look (the diner app only serves published menus); after
publishing it frames the real diner page at the returned URL. S10 remains verification-only. The
reused account disclosure still labels its dashboard placement as awaiting design review.

## Authored screens and remaining PRs

The live composition reuses the merged `OwnerShell` / `FirstDashboard` from
#125/#139, `OnboardingLayout` and source screens from #171, and Screen 9 from
#172. #156 supplies the API client/mapping, #179 supplies the signed-in restaurant
scope, and #192 restored those authored components around the live data. This
change retains their title/body tokens. Account controls reuse the onboarding
disclosure; at desktop widths the middle scrolls while both side panels remain
available. Mobile retains the authored stacked layout.

- #163 remains a separate S10 verification-only implementation; its title does
  not mean it implements S13 publication.
- #162 remains the draft 2.5D camera/portion integration. The merged diner detail
  still disables View Portion. Its preview is separate from this hosted flow.
- #145/#147 are pending diner icon/photo updates; #196 is a Compare design update.
- #173 changes confirmed-404 withdrawal behavior. Until it is merged and deployed,
  REL-02 must distinguish fresh-load denial from the older retained-menu behavior.

These pending branches are not silently included in the staging release.

## Owner journey

1. Sign in and select an authorized restaurant. Open **Menu → Review and publish**.
2. Choose a prepared menu snapshot. Preview shows the exact admitted revision's
   content after SHA-256, strict schema and venue/menu/revision checks. Unknown
   allergens stay unknown. Incomplete dishes remain unavailable.
3. Review dishes, prices, currency, food information and photos. **Back to Edit**
   returns to the existing saved-dish screen. New draft edits need preparation
   again; they do not silently modify this immutable snapshot.
4. **Publish Menu → Confirm and publish** records menu approval, then publication
   through the existing owner-only commands with expected versions and stable
   retry IDs. Neither preview, save nor verification publishes anything.
5. Only after publication succeeds, retrieve the authoritative **diner URL** for
   open/copy/share. Reload reads the published state. If link retrieval fails,
   retry that read without publishing again. A conflict requires a fresh preview.

The existing API allocates `/diner/{restaurant_slug}` on publication; the draft
URL in the Figma sample is not fabricated. Staging uses the existing
`routing-staging.peekaplate-diner-staging.pages.dev` host. Production activation,
`peekaplate.app`, and the `.io` homepage are unchanged.

## Trusted preparation boundary

The existing [bundle producer](s4-res-bundle-producer.md) prepares content from
approved dish revisions, restaurant-confirmed composition and verified T0
assets. Its operator uploads immutable assets/bundle bytes and admits the handoff.
The browser and normal Worker runtime still cannot insert admission rows.

This screen completes publication of **already prepared** menus. It does not
automate arbitrary upload → approved T0 assets → admission; owner-verified dishes are prepared by the path in "Automatic preparation from Review and publish (Part A)" below. A restaurant with no
prepared menu sees that state explicitly; no synthetic fallback is supplied.
The staging demonstration uses labelled fictional content, not a real venue or
a claim that new provider extraction has run.

## Automatic preparation from Review and publish (Part A)

S11 "Complete verification" stays verification-only. Opening **Review and publish** (S13), and
its **Prepare again** button, call `POST /venues/:venueId/prepared-menus/prepare` (owner-only,
local/staging) before listing prepared menus. It reuses the existing command and producer
(`backend/src/owner-prepare.ts`):

1. **Check:** every active dish of the venue (not removed, not a rejected candidate) must have
   the owner's persisted verification, or preparation stops with `menu_not_verified`.
2. **Approve:** each verified, still-pending draft goes through the existing
   `approveDishDraftAtomic` with the exact draft version, the active extraction and its review
   version, `confirmed: true`, and the persisted verification rechecked inside the command. It
   approves onto a stable dish ID per draft (`owner-prepared-dish:v1`) with a deterministic
   command ID per draft/review/dish version, so a retry after a partial failure replays instead
   of duplicating. The command snapshots the approved facts onto a canonical revision: category,
   price, an explicit ingredient clear, confirmed (manual or corrected) allergens, serving count
   and the selected photo. A dish that cannot become a public fact is reported, not approved.
3. **Produce:** all approved, verified dishes, including those approved by an earlier failed run,
   are read with `loadApprovedDishSources` and built by `produceMenuBundle`, unchanged for the
   operator path. Two owner options: an owner-approved photo bound to the revision's selected
   photo ID (tenant/draft-bound, verified, hash re-checked; never labelled T0 and never a
   calibrated portion source), and the agreed text-only fallback (`images: null`) when there is
   none. Name and logo come from the saved Screen 5 profile with the exporter's
   descriptor/hash/dimension rules (`logo-image.ts`); a selected logo whose bytes are missing or
   changed fails preparation instead of disappearing.
4. **Store and admit:** the exact bytes at `prepared-menus/<venue>/<menu>/<revision>.json`
   (write-once), then `app_private.admit_owner_prepared_menu(...)` (migration
   `20261117010000_owner_prepared_menu.sql`), a `SECURITY DEFINER` function owned by the
   `NOBYPASSRLS` role `peekaplate_menu_preparer`. It requires an `owner` membership, accepts only
   the Worker's own bundle address for that venue/menu/revision and an identical retry.

**Back/Edit:** an owner edit, removal, new photo, extracted-dish correction or un-verification of
an approved draft reopens it (pending, not verified). Its canonical dish keeps its ID and the
next preparation approves a new revision of that same dish; earlier revisions are unchanged.

Admission is not approval or publication: S13 previews the prepared menu and the owner still
confirms and publishes. A failed preparation keeps earlier prepared menus listed and says to
prepare again.

Public delivery: `GET /public/prepared-bundles/:venue/:menu/:revision.json` serves only an
admitted revision of that venue; `GET /public/prepared-assets/:venue/:photo/:sha256` only an
owner-approved photo whose bytes match the hash; `GET /public/prepared-assets/:venue/logo/:sha256.(png|jpg)`
only a Screen 5 logo of a venue with an admitted prepared menu, with matching bytes and type.
All are immutable (`max-age=31536000`) and use the existing diner CORS for `/public/*`. The
admission function and these public reads still need Sai's boundary/security review before
release. Ingredient artwork is unchanged: #165's catalogue and #215's live approved-artwork
lookup with its local fallback.

**Temporary limitation: original-size photos.** Owner-prepared dishes serve the owner's approved
original photo for both `card` and `detail`; it is not resized to `card-480`/`detail-1280` WebP.
For the MVP no image encoder is added to the Worker (Sai, Nov 17). Resizing will reuse the
existing Python asset pipeline (`processing/src/peekaplate_processing/assets.py`, which already
makes those variants); until then this stays an open limitation, not a completed step.

Not yet: owner-written alt text and dietary codes (S09 has no field for them), portions for owner
photos, and hosted acceptance.

## Read API and safety

- `GET /venues/:venueId/prepared-menus` lists at most 100 admitted revisions with
  exact approval identities, hashes and current review/publication versions.
- `GET /venues/:venueId/prepared-menus/:menuId/:revisionId` previews that exact
  revision, never a fallback/latest revision. Both routes are local/staging-only,
  require current owner membership and return `Cache-Control: no-store`.
- The authorization transaction ends before fetching public bundle bytes. Only
  the existing staging diner Pages asset host is accepted; credentials, URL
  query/fragment, alternate ports and redirects are rejected. Fetches have a
  ten-second deadline and a two-megabyte streamed limit. Image origins are also
  checked before rendering. Staff tokens are never forwarded to asset hosting.
- Existing approval, publication, withdrawal and diner-link authorization remains
  authoritative. Editor/viewer/cross-restaurant access is denied. Account/venue
  changes abort the client and discard preview/confirmation state.

## Verification

Focused unit/HTTP checks cover owner-only reads, missing admission, tampering,
identity mismatch, URL/redirect/size rejection and exact-origin CORS. Disposable
database integration covers RLS, approval/publication replay, conflict, automatic
link allocation, withdrawal and current-access denial. Chromium checks cover
desktop/mobile preview, confirmation, returned links, same-command retry,
link-only recovery and stale-version refresh; screenshots accompany each state.

The prepared fetch also runs in local workerd. Hosted testing exposed that
`redirect: 'error'` works in Node but is rejected by Workers; `manual` preserves
the no-follow boundary, and every non-success response (including redirects)
is rejected before its body is consumed. The runtime regression uses no network.
The corrected feature passes `pnpm check` (1,851 unit and 106 script tests).

These local checks do not establish hosted acceptance. Record the exact release,
genuine staff-session publication, diner rendering and cleanup/retained test link
on the release PR before describing the hosted flow as verified. Normal Queues
remain paused; this handoff needs no provider requests or new database grants.
