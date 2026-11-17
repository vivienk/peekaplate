# Prepared menu → owner publication → diner

Current composition (November 17): authored S05–S13, server preparation, private
portion review and published portion links are connected. The dated slices below
retain their original verification evidence. The new ingredient-proposal change
has no hosted acceptance yet; see [owner-flow retest](owner-flow-retest.md).

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

- S10 verification is integrated separately from S13 publication; its success
  does not publish a menu.
- #162, #147 and #196 are merged: portion/camera behavior, sample dish photography
  and Compare design changes. Their narrow staging promotion is documented in
  [merged diner staging](merged-diner-staging.md); a merge alone is not hosted evidence.
- #145 remains a separate icon branch; other screen work is not silently included.
- #173 changes confirmed-404 withdrawal behavior. Until it is merged and deployed,
  REL-02 must distinguish fresh-load denial from the older retained-menu behavior.

The pending withdrawal branch is not included in this staging release.

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
The browser cannot admit a menu. The owner preparation route uses the restricted
server admission function described below; it does not grant general table writes.

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
   reuses the historical canonical dish ID, or derives a stable ID for a fresh draft
   (`owner-prepared-dish:v1`), with a deterministic
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

**Back/Edit:** an owner edit, new photo, extracted-dish correction or un-verification of
an approved draft reopens it (pending, not verified). Removal reopens it but preserves unchanged
content verification for Undo. Its canonical dish keeps its ID and the next preparation approves
a new revision of that same dish; earlier revisions are unchanged.

Admission is not approval or publication: S13 previews the prepared menu and the owner still
confirms and publishes. A failed preparation keeps earlier prepared menus listed and says to
prepare again.

Public delivery requires the exact currently published snapshot through the existing
publication/approval/bundle join. `/public/prepared-bundles/...` and its selected photo/logo
URLs return 404 before publication and after withdrawal, and `Cache-Control: no-store`.
Photo/logo membership is checked against the hash-verified snapshot; another private upload,
a newer profile selection or a tampered stored bundle cannot authorize bytes.
The owner previews unexposed images through authenticated
`/venues/:venue/prepared-menus/:menu/:revision/assets/:asset/:file` reads. The controller
uses short-lived blob URLs in a presentation copy and revokes them on leaving or changing
the preview; the original content/hash and publication commands remain unchanged.
Ingredient artwork is unchanged: #165's catalogue and #215's live approved-artwork
lookup with its local fallback.

Reopening an approved draft keeps its canonical dish association, including older random
IDs; only fresh Part A drafts derive a new stable ID. Content edits invalidate verification.
Remove/Undo preserves unchanged content verification and its stable retry receipt. The
Part A forward migration permits that pending historical association while
retaining the tenant foreign key, superseded exclusion and pending reviewer-metadata checks.

A fresh owner venue with no profile, drafts or prepared bundles remains empty and reports
`nothing_to_prepare`; it does not receive invented content or a successful publication.
Dashboard publishing still waits for trusted profile verification; the existing Menu path
does not impose that same profile gate. This reconciliation preserves that product behavior
and does not let an owner self-verify restaurant details.

**Temporary limitation: original-size photos.** Owner-prepared dishes serve the owner's approved
original photo for both `card` and `detail`; it is not resized to `card-480`/`detail-1280` WebP.
For the MVP no image encoder is added to the Worker (Sai, Nov 17). Resizing will reuse the
existing Python asset pipeline (`processing/src/peekaplate_processing/assets.py`, which already
makes those variants); until then this stays an open limitation, not a completed step.

Owner-approved 2.5D layers can accompany the exact approved dish revision through
the existing preparation path. Physical calibration is not inferred from the
photo. Owner-written alt text and dietary codes remain unsupported S09 inputs.
Hosted evidence is recorded by release in [owner-flow retest](owner-flow-retest.md);
it does not establish acceptance of subsequent ingredient-proposal changes.

## Read API and safety

- `GET /venues/:venueId/prepared-menus` lists at most 100 admitted revisions with
  exact approval identities, hashes and current review/publication versions.
- `GET /venues/:venueId/prepared-menus/:menuId/:revisionId` previews that exact
  revision, never a fallback/latest revision. Both routes are local/staging-only,
  require current owner membership and return `Cache-Control: no-store`.
- The authorization transaction ends before reading bundle bytes. The existing
  staging diner Pages host and the exact Worker-owned prepared-bundle path are
  accepted through their respective validators; credentials, URL
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
That Part A correction passed `pnpm check` (1,851 unit and 106 script tests).

These local checks do not establish hosted acceptance. Record the exact release,
genuine staff-session publication, diner rendering and cleanup/retained test link
on the release PR before describing the hosted flow as verified. Normal Queues
remain paused; this handoff needs no provider requests or new database grants.
