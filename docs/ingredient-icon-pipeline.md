# Ingredient icon pipeline implementation plan

This pipeline reuses saved menu extraction and ingredient evidence to propose
ingredient artwork for owner review. Artwork approval never confirms a recipe,
changes an allergen classification, or authorizes publication.

## Inspected baseline and design

Implementation starts from develop `bb2e0e8cf71d6f4478538918cb3d3b432bb93230`
(November 12, 2026). The earlier conversation contained the original request but
no implementation. Relevant existing boundaries are:

- `processing/src/peekaplate_processing/run_pipeline.py`: OCR/vision extraction,
  saved reports, and the existing ingredient-review sidecar.
- `ingredient_intelligence.py`: Unicode normalization, exact phrases, source
  evidence and conservative abstention. Its rules and output remain unchanged.
- `review_candidates.py`: snapshot checksum and candidate/source-span validation.
- `backend/src/ingestion/review-bootstrap.ts` and `backend/src/review-command.ts`:
  authorized review sessions and correction handling. No new writes bypass them.
- `processing/src/peekaplate_processing/service.py`: private hosted bundle V1 has
  an exact key set; adding a sidecar requires a negotiated bundle revision.
- `packages/contracts/src/ingredient-intelligence.ts`: existing review-only
  consumer validation; not an icon HTTP API or publication authorization.

The exact [Figma component set 149:2169](https://www.figma.com/design/l7A9n8tACJic0FIhY49Zjw/PeekaPlate?node-id=149-2169)
was inspected in the browser. It has 32 named ingredient variants, small colored
illustrations above light labels, rounded dark tiles, and restrained flat or
simple faceted geometry. Ham is a coral faceted cube; its component measures
92 × 86. The set measures 344.41 × 1128, with 14 horizontal and 12 vertical spacing
shown in the inspector. These set-level values are not a responsive screen spec.
Figma's connector returned a Starter-plan call limit, so exact asset exports,
child styling tokens and high-fidelity design context are unavailable. No artwork
or UI is claimed to match pixel-for-pixel, and no substitute art is shipped.

The versioned vocabulary includes all 32 observed names. Only four explicit
plural/seed aliases supplement them. Chicken is not mapped to grilled chicken,
rice is not mapped to sushi rice, and egg is not mapped to poached egg.

## Implemented local slice

`ingredient_icons.py` provides a private post-processing API and CLI. It validates
the original extraction snapshot and review evidence, calls the existing
ingredient-intelligence producer, and emits `ingredient-icons.v1`. Each entry
retains its original phrase, normalized phrase, ingredient index, source evidence,
grounding reason, optional artwork ID and text fallback. Every entry still needs
review. Empty/missing ingredient lists remain unknown.

Exact vocabulary matches with evidence can propose artwork even when the food
classifier has no rule for that phrase. This adds no allergen knowledge. Missing
evidence, qualified contexts and vision transcription remain unresolved. The
original extraction, allergen/dietary output and all existing review/publication
commands are untouched. The sidecar is not added to the hosted V1 bundle.

`IconStore` accepts curated exports or externally generated artwork. It checks
PNG/WebP format, byte and dimension limits, square geometry, single frame,
transparent corners and visible content. It requires a rights assertion and
provenance/recipe fields. Generated records must be supplied with model and prompt
provenance by the operator; the current free-text recipe is not a verified provider
receipt. It stores immutable content-addressed JSON records and base64 blobs in a
trusted private local directory. This portable local format is not the proposed
R2 delivery format.

Registration creates no approval. An explicit local operator decision records
reviewer, reason and approved/rejected status against the exact asset version.
The selection manifest pins that version. Missing decisions, rejection, wrong
ingredient joins, missing bytes and checksum mismatches fall back to text. Identical
imports/decisions are idempotent; conflicting overwrite attempts fail. Decisions
are final in this offline store: revisions need a new asset recipe/version. A
hosted revocation lifecycle must be implemented before this is a shared service.

The deterministic output cache key covers source/draft evidence digests, mapping
and style versions, and resolved artwork versions. Each build revalidates assets;
a cached proposal never grants approval. No provider call occurs on an icon miss.

### Local APIs and commands

From the repository root, reuse an existing extraction without rerunning OCR:

```sh
uv run --project processing --frozen python -m peekaplate_processing.ingredient_icons \
  --input work/example/extraction.json --output work/example/ingredient-icons.json
```

Optional `--catalogue work/private-icon-catalogue --selections selections.json`
resolves reviewed artwork. Selections are an object such as
`{"salmon":"<64-character asset ID returned by register>"}`. With no catalogue,
all entries retain text fallbacks. Outputs are create-only; choose a new path.
The existing pipeline CLI accepts `--ingredient-icons` to write this sidecar
after extraction. A sidecar error returns failure while retaining extraction.

Python callers use:

```python
store = IconStore(Path("work/private-icon-catalogue"))
asset_id = store.register(
    exported_png_bytes, ingredient_id="salmon", origin="curated",
    provenance="Figma ingredient component export and asset source record",
    recipe="export revision 1", rights_confirmed=True,
)
store.review(asset_id, status="approved", reviewer="actual reviewer ID",
             reason="Identity, style, rights and small-size legibility checked")
proposal = build_icon_handoff(report, store=store, selections={"salmon": asset_id})
```

These are trusted offline operator APIs, not authenticated service endpoints.
Do not expose arbitrary catalogue paths, reviewer IDs or selections to browsers.

## Remaining implementation sequence

### 1 Obtain and approve the reference asset pack

Export the illustration children for all 32 variants, not screenshots of whole
tiles. Record node ID, file revision, original dimensions and permitted use for
each asset. Preserve original bytes. Inspect light/dark contrast and legibility
at the actual icon slot size; the tile's 92 × 86 dimensions are not icon dimensions.
Import approved exports and pin a selection manifest. Curated assets come first.

For missing vocabulary, a future worker may generate an isolated decorative
illustration with transparent background, restrained flat/faceted geometry,
reference palette and no text, tile, plate or photographic texture. Use the
exported approved reference pack only where permitted. Require a design review
against the exact reference. Decorative icons must never be represented as a
capture of the restaurant's dish or as evidence of ingredients/portion size.

### 2 Add bounded asynchronous generation

Define a typed generation recipe containing taxonomy ID, style/reference digest,
prompt version, provider, model version, seed/settings and output format. Derive
the job idempotency key from all of these fields. Send only the canonical ingredient
label and approved style references, never private menu evidence or customer data.
Reuse existing Worker job claims, fencing tokens and retry conventions; do not call
an image provider in an HTTP request or database replay. Limit attempts, elapsed
time, concurrency and per-venue spend; persist terminal errors and use a DLQ.
Return text while a job is pending, rejected, unavailable or out of budget.

Generation is not implemented or invoked in this change. No provider/model is
chosen without capability, license and cost verification. The import API already
accepts generated output after the same image validation and artwork review.

### 3 Add shared contracts and private hosted storage

Introduce strict TypeScript schemas for icon proposals, generation recipes,
asset metadata and review commands, with shared Python/TypeScript fixtures.
Keep them separate from the existing ingredient-intelligence contract.

Proposed storage records:

| Record | Identity and responsibility |
| --- | --- |
| Ingredient vocabulary | Versioned canonical ID, display labels, explicit locale aliases |
| Icon asset | Immutable content digest, style/recipe identity, origin, rights provenance |
| Artwork review | Append-only decision/revocation for exact asset version, actor, time |
| Draft icon proposal | Venue/job/extraction/draft/effective-revision digest and ingredient index |
| Approved icon selection | Revision-bound canonical command result, separate from food approval |
| Generation job | Idempotency key, claim/lease/fencing, attempts, result/error |

Use forward SQL migrations, restricted runtime roles and RLS. Venue-scoped
proposals and private generated candidates stay in private R2 prefixes. Only
centrally approved generic catalogue assets may be shared across venues. Upload
by content hash with create-only semantics; retain MIME, dimensions, hash and
provenance. Raw image bytes, not base64 JSON, belong in hosted R2.

Changing a source, corrected ingredient list, evidence, taxonomy, style or selected
asset invalidates the proposal/confirmation. Rebuild from the current effective
review revision; never accept a browser-provided input digest as authority.

### 4 Add authenticated API and review UI

The following endpoints are proposed, not shipped:

| Endpoint | Behavior |
| --- | --- |
| `GET /venues/:venue/ingestions/:job/ingredient-icons` | Current authorized draft proposals, originals, evidence and fallback reasons; `no-store` |
| `POST /venues/:venue/ingredient-icon-jobs` | Staff-authorized bounded request; 202 and idempotent job identity |
| `GET /venues/:venue/ingredient-icon-jobs/:id` | Current membership check, pending/ready/failed state |
| `POST /venues/:venue/drafts/:draft/ingredient-icon-decisions` | Expected revision and command ID; record owner selection through canonical command path; 409 if stale |
| `POST /internal/ingredient-icon-assets/:id/reviews` | Separately authorized artwork approval/rejection/revocation |

Every request derives venue/actor authority from verified authentication and
current membership, including retries. Reject cross-tenant joins and stale
extraction/session pointers. Rate-limit job creation. Do not accept arbitrary
provider URLs, local file paths or claimed reviewer identity. Atomically record
domain event, projection, command receipt and outbox; replay has no side effects.

The owner UI shows original phrase, evidence, proposed normalized name, artwork
origin, unresolved reason and separate ingredient/artwork decisions. Sauce names
never expand into a guessed recipe. Missing artwork does not block reviewing
valid facts. Ingredient corrections invalidate existing selections; neither an
artwork approval nor a saved draft can skip the allergen/human-review gate.

### 5 Publish only through the existing gate

Extend the immutable public-menu bundle contract only after owner-confirmed
ingredients and the existing publication checks pass. Pin the selected approved
asset ID/hash and display label to the published dish revision. Public assets may
use long-lived immutable caching; the current publication pointer and withdrawal
mechanism remain authoritative. Revocation invalidates affected publication
selections and retires public references through the existing workflow.

Diner components use the inspected design tokens and exact exported artwork,
show visible text labels, avoid duplicate screen-reader announcements, and retain
text on image load/hash/decode failure. Do not create allergen-free badges from
missing icons. Layout/accessibility, small-screen and physical-device checks are
required after UI integration; none is claimed by this local processing change.

## Acceptance tests and rollout

Local tests cover unchanged upstream classifications and drafts; exact/alias
matching; unknown/empty input; qualified/missing/vision evidence; checksum and
offset rejection; pending/rejected/mismatched/corrupt artwork; image validation;
idempotent storage and conflicting decisions; deterministic cache invalidation;
CLI and pipeline opt-in. Synthetic pixels test transport, not visual fidelity.

Hosted acceptance must additionally cover current membership on every route,
cross-tenant and guessed IDs, expected-version conflicts, duplicate requests,
concurrent workers and expired claims, provider timeout/rate-limit/invalid images,
budget enforcement, R2 conditional writes, stale approval invalidation, revocation,
withdrawal and immutable publication hashes. Run a synthetic upload-to-review-to-
publication-to-diner flow, then a restaurant-validated pilot. Roll out behind a
default-off feature flag; disabling it restores text-only ingredients. The plan
does not authorize deployment or change any existing food-safety review policy.
