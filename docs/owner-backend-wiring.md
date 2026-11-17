# Owner backend wiring and source map

Prepared by Sai · November 16, 2026.

This PR extracts existing backend work from held [#213](https://github.com/vivienk/peekaplate/pull/213)
at `7fea9042` and [#215](https://github.com/vivienk/peekaplate/pull/215) at
`6bf4498f` onto develop `d2ba6ee3`. It does not replace those implementations,
change their screens, or claim the complete hosted journey has passed. #213
remains with Jeffin for frontend corrections. Once this backend PR merges, the
same backend source should leave #213's diff when it is reconciled with develop.

## Existing code reused

| Connection | Existing implementation carried here | Boundary retained |
|---|---|---|
| Restaurant details and logo | Canonical profile contract/service, `/profile` and `/setup` routes, private photo metadata, shared forward migration from #213/#215 | Current staff membership, tenant RLS, versions/receipts/events/outbox. Owner save submits details; it cannot mark them verified. |
| Draft edits and review | Existing owner-menu service/routes and review commands from #213 | Original photos, currency, serving text/count and corrected allergens survive approval. Changed content invalidates earlier verification. |
| Remove and Undo | Existing versioned removal command and metadata from #213 | Reversible removal, exact receipt identity, no destructive deletion or approval/publication side effect. |
| Public branding | #215 producer CLI plus its restaurant/logo-image helpers | Authenticated private logo read, exact verified bytes, public name/logo only; no contacts or staff token in a bundle. |
| Portion metadata | #215 approved-fact/producer/shared-contract mappings | Serving count selects matching revision-bound measurements. A count never multiplies physical dimensions. |

The canonical database objects remain `restaurant_profile` and
`restaurant_profile_photo`, introduced by the unchanged shared migration
`20261116020000_owner_flow_profile.sql`. The removed #215 prototype projection,
alternate `/restaurant-profile` API and prototype migration are not reintroduced.
There is one profile model and one existing authenticated owner-menu transport.

## Duplication and scope checks

- No `frontend/`, shared UI or token implementation is copied or changed.
- #210 is already merged. Its placeholder service, routes and migration are not
  added again; the ingestion repository keeps that code and only adds removal
  row fields needed by the existing review commands.
- OCR, Python extraction, Queues, artwork generation, PostHog and the publication
  command implementations are reused. No second processing or tracking pipeline
  is added.
- No merge ancestry claims that the frontend portions of #213/#215 have shipped.
  This is an extraction of the backend paths, with their original tests.
- The backend must accept the unchanged develop client's legacy draft requests.
  Compatibility tests must distinguish omitted serving extensions from explicit
  clears, preserve already saved extensions and keep command replay semantics.
- Already-built strict client parsers may reject additional response fields.
  Hosted rollout therefore needs matching API/shared-contract frontend builds;
  backend-only merge does not authorize an API-only staging deployment.

## Flow supported by this backend slice

1. An authenticated owner/editor saves restaurant details and original logo
   bytes privately. Setup reads saved status, active menu drafts and publication
   state; it does not invent verification or dashboard metrics.
2. The existing upload/OCR pipeline produces drafts. Review uses the same
   versioned draft/candidate commands to save corrections and photos.
3. Remove/Undo records reversible state. Verification rechecks the exact active
   content versions; an old receipt cannot verify newer content.
4. Approved revisions feed the existing trusted bundle producer. The optional
   owner-profile CLI read supplies public branding to that same producer.
5. After trusted asset preparation/upload/admission, the existing official S13
   API publishes the admitted snapshot and returns its diner URL.

Step 5 does not mean arbitrary new drafts are automatically prepared/admitted.
The newly opened [#216](https://github.com/vivienk/peekaplate/pull/216), at
`25e7af0b`, proposes that automatic preparation layer and is stacked on held #213.
It is not copied or reviewed by this extraction. Its producer reuse, trusted
admission/public asset boundaries and alignment with Teeyansh's existing bridge
need separate review. This PR adds no alternate bridge or runtime admission grant.

## Acceptance record

The carried source already passed combined local Worker/database/browser
checks, but that does not establish this split's compatibility. The standalone
PR records fresh unit, database, typecheck, build and independent-review results.
Keep pending checks labelled NOT RUN until they actually pass.

No hosted migration, deployment, new membership grant, provider call or Queue
activation is performed by this PR. Fresh OCR/provider acceptance, screen wiring
from held #213, same-snapshot owner AI/freshness and physical-device AR acceptance
remain separate gates.
