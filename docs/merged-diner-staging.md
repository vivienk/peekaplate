# Merged diner screens: one-restaurant staging handoff

This release brings the merged Compare picker/result, sample photography and
portion viewer to the existing staging diner. It retains the authored owner
dashboard, source intake, dish editor and temporary S13 publication screen.
It changes no database permissions, Queue configuration or extraction service.

## What is connected

1. Sign in to the existing owner console and select the fictional test restaurant.
2. Open **Menu → Review and publish** and choose an operator-admitted snapshot.
3. Preview its exact bytes, then explicitly approve and publish that revision.
4. Copy the URL returned by the API. The same restaurant keeps its existing
   `/diner/{restaurant_slug}` link when the menu revision changes.
5. Open that URL for Menu, Search, dish details, Save/Saved, Compare/Replace and
   View Portion where the published dish includes reviewed layer metadata.

PR #147 supplies the design sample photos, #196 the Compare design changes and
#162 the portion viewer, camera preview and cleanup/navigation corrections.
The existing Compare picker/result callers from #126/#127 are promoted with them.
#181 and #186 add evaluation/evidence work; #189 adds synthetic dashboard ranking.
Those merges do not by themselves establish fresh hosted analytics or accuracy.

## Synthetic fixture boundary

The retained staging restaurant and menu are fictional. A separate fixture
manifest must record source commits, file hashes, dish/revision bindings and
layer sizes. Reuse the merged sample artwork without changing its original
`needs_review`, `preview_only` or `publication.eligible=false` records. A labelled
staging test admission is not restaurant asset approval or a normal producer run.

The fixture uses real immutable HTTPS asset URLs and exact SHA-256 values, not
`portion-fixtures.invalid` or a demo-mode build flag. Omit `physical_size` because
these photos have no independently measured plate calibration. The normal build
excludes model generation, camera demo/upload controls and provider secrets.
The viewer's ordinary camera permission/fallback behavior remains available.
Ingredient icons fall back to bundled assets if the optional artwork API is absent.

## Release and checks

Deploy the approved exact main commit to the existing staging API (for the strict
optional portion contract) and to the `routing-staging` branch of the existing
diner Pages project. Leave the console deployment, production domains and `.io`
homepage untouched. Queues stay paused; no provider call is required.

Record the release SHA and actual hosted results on the release PR. Required
checks: owner preview/publication and same returned restaurant link; menu images,
Search, Save/Saved, Compare/Replace; fetched layer hashes and View Portion;
return navigation, narrow viewport and original-photo fallback. Capture every
tested page. Local browser mocks are not hosted acceptance evidence.

## Still separate

- #163's authored S10 is verification-only and is not part of this release.
- Saved draft edits still need trusted preparation before they become a public
  immutable snapshot. This release does not automate that missing handoff.
- Restaurant details/setup completion stay unknown where the API has no evidence.
- #173's changed withdrawal behavior must be reviewed and deployed separately.
- Physical-phone scale acceptance, paid model evaluation and real tracking
  delivery remain separate checks; no synthetic fixture proves those outcomes.
