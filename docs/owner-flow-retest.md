# Owner flow retest corrections

This change adapts the merged S09/S10 forms, owner shell and dashboard pages. It does not replace their layouts or create another publication or tracking pipeline.

## Changes

- Missing currency uses the USD pilot default. The raw currency input is removed; existing explicit currencies are preserved, not converted.
- S10 names/categories wrap inside cells. The count describes all dishes in the menu. Upload thumbnails show selected files and release their object URLs afterward.
- Owner navigation unlocks Overview, AI Insight Report, Dish performance and Actions after nonempty saved drafts are verified, or after confirmed publication. Editors retain Setup/Menu. Local checkboxes and merely adding drafts cannot unlock owner pages.
- Existing dashboard presentation receives actual menu/report/action data. Unsupported demo charts, sample actions and generated insights are absent. Empty, unavailable and suppressed remain distinct.
- The dashboard sends the displayed report's `X-Owner-Report-Ref` to analysis. An expired reference offers Reload report; refreshing never automatically spends another model request.
- Actions gets console GET/OPTIONS CORS. Existing authentication and restaurant ownership still apply.
- Existing #219/#221 Screen 9 photo generation now reaches the authenticated extraction host/container. The locked CPU cutout model is included in that image; failed attempts can retry the same photo without triggering on ordinary field edits.
- S13 reuses the existing approved-portion validator and bundle producer. Published layers stay bound to their approved photo/revision and remain available while a newer draft is edited. Withdrawal, revocation and corrupt bytes fail closed. #162's existing diner renderer and approximate camera fallback are preserved.

## Data and AI boundaries

PostHog remains the internal pilot analytics destination. Existing consent-gated `track()` also sends observations through Queue/R2/canonical facts for owner reports. Verification does not publish, grant consent, create activity or waive privacy floors.

The reserved report fixture retains its live-class synthetic history. The approved publication and Poulet demo venues use test-class canonical facts through the new RLS-protected view. No union or relabelling occurs. JSON, CSV and AI rereads select the same class; see [report access](owner-report-staging.md).

Optional S09 description assistance shortens an existing owner/saved description by selecting a complete literal sentence. Ingredient assistance now reuses persisted manual ingredients or source-bound extraction proposals and current owner corrections; it makes no provider call and does not complete a recipe from its name. Empty evidence abstains, and removed ingredients are not resurrected from older originals. Both operations return unverified proposals requiring explicit review. Allergen suggestion transport remains unavailable. The existing Python ingredient-intelligence classifier retains its separate evidence-bound handoff; this integration does not duplicate or bypass it.

Dashboard AI preserves unknown-freshness abstention. A recent event or HTTP success is not proof of complete report coverage. Positive hosted recommendations still require an approved completeness/freshness source.

## Release and evidence

The initial release required `20261117130000_owner_test_observations.sql` through the reviewed staging process; its application/readback is recorded below. The existing runtime receives SELECT on the test-only view; live facts and policies are unchanged.

Both Worker AI flags default off. The staging native rate limiter allows 10 requests/minute. Activation requires securely provisioned OpenAI key/project and a separate report-reference signing secret. Console flags are `VITE_OWNER_AI_ENABLED` and `VITE_OWNER_AI_DISH_ASSISTANCE_ENABLED`; neither contains credentials. Rate limiting is not a total spending cap.

The existing protected staging workflow has an explicit `configure_owner_ai` input. It validates all three AI settings and passes them in its temporary private secrets file only when requested. Ordinary releases retain their previous behavior; provisioning alone does not enable either feature.

Focused regressions cover currency fallback, saved verification, actor/venue isolation, real-data rendering, reference propagation/recovery, CORS, traffic-class isolation, description spans and permission/version rechecks. Record local, mocked and hosted evidence separately. A merge does not prove paid model quality, hosted extraction, destination readback or physical-size AR acceptance.

The historical focused main candidate (PR #223) passed `pnpm check`: 1,878 unit tests and 106 script tests; `pnpm verify test:db`: 314 SQL assertions, 144 Worker/database integrations and Worker smoke; and `pnpm verify build`. That candidate was narrower than develop and excluded unrelated POS/comparison/evaluation work. Its browser checks used the connected Brave session; automated browser execution was left to CI. These counts describe that earlier candidate, not the subsequent baseline reconciliation or ingredient change.

Additional local portion evidence: the real non-root Linux image processed an opaque synthetic JPEG with networking disabled in 41 seconds, returning two hash-validated layers and cleaning its scratch directory. The publication-isolation regression first reproduced an edited draft hiding the still-published portion, then passed with serving authority bound to the exact published snapshot. Connected Brave reproduced the unchanged-photo retry failure and confirmed the corrected second request and preview; these local checks do not establish hosted acceptance.

## Existing implementation reused

| Area | Existing work retained | Correction in this release |
| --- | --- | --- |
| Owner screens | #143/#146 auth, #171/#172 onboarding/editor, #206/#207/#213 wiring | USD fallback, upload preview lifecycle, S10 wrapping and saved-verification navigation |
| Preview and publish | #208/#216 S13 and preparation | Attach approved revision-bound portion through the existing producer and published asset route |
| Portion | #162 renderer/camera, #219/#221 private generation/review | Connect existing extraction host/container, retry same photo, preserve published assets during edits |
| Reports and actions | Existing authored dashboard/performance layouts, #142 actions, #218 report reference | Real-data inputs, isolated test facts, reference forwarding and honest empty/unknown states |
| URL intake | #222 structured HTML intake | Promote its already-reviewed parser, unambiguous-price and fetched-source reuse fixes |

Main's shared command-error helpers, lazy camera loader and performance frame are
preserved. Both demo and live performance use the existing `PerfFrame`; no second
presentation frame or design-token package is added. The source-menu evidence
panel predates this release in #156; its local synthetic fixture is not a Poulet
extraction result.

Staging schema preflight on November 17 applied the two reviewed missing forward
migrations with explicit operator approval. Readback confirmed forced tenant RLS
on Actions and invoker/security-barrier protection on the test view. This schema
check does not establish the still-pending application deployment or hosted UI
round trip. Existing accounts, memberships, Poulet drafts and publications were
not reset.

## Hosted Worker redirect correction

The merged release passed CI, but the hosted S09 photo-generation request returned
503 before reaching the extraction host. The saved photo's R2 size and SHA-256
matched its database row. A bounded diagnostic and the installed workerd runtime
identified `redirect: 'error'` as unsupported at the edge. Mocked fetch tests had
accepted that browser/Node option and missed the failure.

The API and extraction-host portion requests use `redirect: 'manual'` and retain
their existing non-success response checks. Redirects are rejected without
forwarding credentials or following Location. The regression exercises the actual
functions under workerd with a synthetic outbound service, including redirect
rejection; it makes no external provider calls. Node-only bundle CLI readers and
browser clients retain their supported redirect policy.

The two S09 portion actions also reuse the existing authored `Btn` component.
No screen, design-token package, processing service or publication path is added.
The temporary diagnostic was removed from staging after identifying the cause.
At that point hosted generation, approval and publication still required a
retest on the corrected exact-main release; the next section records that run.

## Hosted publication and SVG decoding

On the corrected staging release, the existing authenticated flow generated and
approved the labelled fixture cutout, saved and verified its dish, prepared a new
menu, and published it through S13 at the unchanged restaurant URL. The 46 Poulet
drafts remained intact. This did not rerun OCR or make paid model requests.

The diner then exposed a second integration defect: the published SVG background
returned 200 with correct bytes, but the renderer preserved SVG MIME only for
development fixture URLs. Opaque production asset URLs became untyped blobs and
failed image decoding. The shared verified-layer reader now retains supported
image MIME after its exact size/hash checks. The original renderer, dimension
checks, cleanup, retries and photo fallback remain. Its browser regression uses
an SVG background behind an opaque hash URL instead of two PNG fixtures.

The Menu list no longer claims every portion is disconnected. Its neutral
"Review in dish" label points to the existing editor, where current generation
and approval are authoritative; the list does not invent a persisted status.

The connected Brave browser has Global Privacy Control enabled. Both destinations
remained off after the optional-analytics action, as intended. That establishes
privacy enforcement, not a positive PostHog/canonical delivery result. Independent
GitHub environment approval still gates credential provisioning; owner AI remains
off, and unknown report freshness must still abstain.

## Ingredient proposal continuation

The existing S09 ingredient button now has a server-authorized operation on the
existing dish-assistance route. It reads saved manual fields or current,
source-bound extraction/review values, including explicit owner clears. A changed
draft version, source snapshot or membership invalidates the response. Proposals
remain private and unverified; saving, verification and publication stay separate.
There is no new classifier, OCR run, recipe completion or ingredient-provider call.

Focused route/schema and frontend checks are local regression evidence. This
continuation has no hosted acceptance yet. It does not provision AI credentials,
establish trusted report completeness/freshness, certify allergens or imply paid
model quality. Record its exact release and authenticated screen result before
claiming that new operation has passed on staging.
