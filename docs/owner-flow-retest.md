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

Optional S09 description assistance shortens an existing owner/saved description by selecting a complete literal sentence. It does not generate recipes, ingredients, allergen claims or preparation facts. Output remains an unverified proposal requiring acceptance and review. Ingredient/allergen suggestion transport remains missing; those buttons stay unavailable. The existing Python ingredient-intelligence classifier retains its separate evidence-bound handoff.

Dashboard AI preserves unknown-freshness abstention. A recent event or HTTP success is not proof of complete report coverage. Positive hosted recommendations still require an approved completeness/freshness source.

## Release and evidence

Apply `20261117130000_owner_test_observations.sql` through the reviewed staging process. The existing runtime receives SELECT on the test-only view; live facts and policies are unchanged.

Both Worker AI flags default off. The staging native rate limiter allows 10 requests/minute. Activation requires securely provisioned OpenAI key/project and a separate report-reference signing secret. Console flags are `VITE_OWNER_AI_ENABLED` and `VITE_OWNER_AI_DISH_ASSISTANCE_ENABLED`; neither contains credentials. Rate limiting is not a total spending cap.

The existing protected staging workflow has an explicit `configure_owner_ai` input. It validates all three AI settings and passes them in its temporary private secrets file only when requested. Ordinary releases retain their previous behavior; provisioning alone does not enable either feature.

Focused regressions cover currency fallback, saved verification, actor/venue isolation, real-data rendering, reference propagation/recovery, CORS, traffic-class isolation, description spans and permission/version rechecks. Record local, mocked and hosted evidence separately. A merge does not prove paid model quality, hosted extraction, destination readback or physical-size AR acceptance.

The focused main candidate passed `pnpm check`: 1,878 unit tests and 106 script tests; `pnpm verify test:db`: 314 SQL assertions, 144 Worker/database integrations and Worker smoke; and `pnpm verify build`. This is a narrower release than develop and intentionally excludes unrelated POS/comparison/evaluation work. Browser checks use the connected Brave session; the automated browser suite has not been run locally for this candidate and must pass CI.

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
