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
automate arbitrary upload → approved T0 assets → admission; owner-verified dishes are prepared by the narrower path in "Automatic preparation after verification (Part A)" below. A restaurant with no
prepared menu sees that state explicitly; no synthetic fallback is supplied.
The staging demonstration uses labelled fictional content, not a real venue or
a claim that new provider extraction has run.

## Automatic preparation after verification (Part A)

Vivien confirmed for MVP that completing S10 verification prepares the menu automatically, so
the owner continues to S13, previews it and explicitly publishes it. After the S11 "Menu
verified" result, the console calls `POST /venues/:venueId/prepared-menus/prepare`
(owner-only, local/staging):

1. **Read:** verified, active drafts of that venue (`verification_status = 'verified'`, not
   removed, not a rejected candidate), with RES-01.2 corrections applied, and each draft's
   owner-approved photo (`menu-assets/<venue>/<photo>/<sha256>`, hash re-checked). Unverified
   drafts are never read.
2. **Build:** `backend/src/owner-prepare.ts` produces Bundle v1 with the producer's rules: the
   same canonical bytes, `menu-revision:v1` / `content-approval:v1` / `asset-approval:v1`
   derivations, decimal price normalisation and completeness checks. A dish missing a
   description, representable price, currency, confirmed ingredients or category becomes an
   identity-only placeholder. A dish without an approved photo is published **text-only** for
   now (`images: null`, allowed by Bundle v1 since Nov 17): name, price, description,
   ingredients and allergens, with the diner's empty image box. Owner-entered ingredients and allergens are used
   only when `confirmed`; unknown allergens stay `null`. Alt text is `Photo of <dish>`
   (owner-written alt text is not stored yet). Dietary codes are empty. The menu id is derived
   per venue (`owner-prepared-menu:v1`).
3. **Store:** the exact bytes at `prepared-menus/<venue>/<menu>/<revision>.json` in the private
   ingestion bucket, write-once; an existing key must hash to the same content.
4. **Admit:** `app_private.admit_owner_prepared_menu(...)` (migration
   `20261117010000_owner_prepared_menu.sql`), a `SECURITY DEFINER` function owned by the
   `NOBYPASSRLS` role `peekaplate_menu_preparer`. It requires the current tenant and an `owner`
   membership for the current actor, accepts only the Worker's own bundle address for exactly
   that venue/menu/revision, inserts `menu_review_subject` + `public_menu_bundle`, accepts an
   identical retry and rejects a conflicting one. The runtime role still cannot insert either
   table directly; the operator `--admit` path is unchanged.

Admission is not approval or publication: S13 lists the prepared menu (newest first), previews
it and the owner still confirms and publishes. A failed preparation never undoes verification;
the console says so and Review and publish can be retried.

Public delivery: `GET /public/prepared-bundles/:venue/:menu/:revision.json` serves only an
admitted revision of that venue; `GET /public/prepared-assets/:venue/:photo/:sha256` serves only
an owner-approved photo whose bytes match the hash. Both are immutable (`max-age=31536000`), use
the existing diner CORS for `/public/*`, and the S13 preview reads owner-prepared bundles from
the bucket directly (no Worker self-fetch). Staging serves no diner CSP that would block API
images; PR previews do not call the API.

Not yet: owner-written alt text and dietary codes, photo resizing to `card-480`/`detail-1280`
(the approved original is used for both), logo (Vivien's #215), and hosted acceptance.

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
