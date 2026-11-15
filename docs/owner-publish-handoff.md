# Prepared menu → owner publication → diner

This is the temporary S13 handoff authorized by Sai until the team's official
screen replaces it. It follows Figma `3123:12796` in the existing PeekaPlate
Design file and reuses the merged onboarding layout and buttons. S10 remains
verification-only; no pending S10 implementation is merged by this change.
The page visibly labels S13 as temporary. The reused account disclosure also
labels its dashboard placement as awaiting design review.

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
- #162, #147 and #196 are merged: portion/camera behavior, sample dish photography
  and Compare design changes. Their narrow staging promotion is documented in
  [merged diner staging](merged-diner-staging.md); a merge alone is not hosted evidence.
- Other icon/screen changes remain separate from this promotion.
- #173 changes confirmed-404 withdrawal behavior. Until it is merged and deployed,
  REL-02 must distinguish fresh-load denial from the older retained-menu behavior.

The pending S10/withdrawal branches are not included in this staging release.

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
automate arbitrary upload → approved T0 assets → admission. A restaurant with no
prepared menu sees that state explicitly; no synthetic fallback is supplied.
The staging demonstration uses labelled fictional content, not a real venue or
a claim that new provider extraction has run.

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
