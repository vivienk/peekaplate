# S3-AI-02 — Ingredient Intelligence & Dietary Classification

P0 implementation for [AI-02](https://app.clickup.com/t/86bcry0gn), scheduled in
Sprint 4. This is a local processing feature and a shared review contract, not a
completed hosted owner-review feature.

## Implemented flow

[VIS-02](https://app.clickup.com/t/86bcnfw5g) extracts only explicitly supplied
ingredient phrases. `run_pipeline` now writes `ingredient-review.json` alongside
its unchanged `extraction.json`. AI-02 does not change the extraction prompt,
train a model, complete recipes, call an API, or write database/publication state.
The separately versioned sidecar preserves compatibility with VIS-02's strict
v1 extraction schema.

For an existing extraction, run from the repository root:

```sh
uv run --project processing --frozen python -m peekaplate_processing.ingredient_intelligence \
  --input work/example/extraction.json --output work/example/ingredient-review.json
```

Choose a new output path. The command preserves prior output and prints a
sanitized error for malformed, oversized or unwritable input. It needs no model
or OCR credentials and makes no external calls.

The producer is
`processing/src/peekaplate_processing/ingredient_intelligence.py`. The shared
consumer contract is `packages/contracts/src/ingredient-intelligence.ts`.
The synthetic shared fixture is checked against the Python producer and parsed
by the TypeScript consumer; it is not restaurant ground truth.

## Rules and evidence

`ingredient-rules.1` is a deliberately small, authored exact-phrase vocabulary.
It normalizes Unicode NFKC, case and whitespace, with explicit aliases such as
prawns → shrimp, groundnuts → peanut and soya → soybean. Original phrases and
exact source text remain available. No fuzzy matches, automatic translation,
substring ingredient detection, or composite-recipe expansion are used.

Recognized ingredients can suggest the nine US major allergen categories:
milk, egg, fish, crustacean shellfish, tree nut, peanut, wheat, soy and sesame.
This vocabulary follows the [FDA category reference](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies);
it is not a complete global allergen taxonomy or a regulatory certification.
The mapping is authored locally, not downloaded from Open Food Facts.

The same rules can suggest incompatibility with vegan, vegetarian or gluten-free
diets. The policy treats meat/fish/crustaceans as excluding both vegan and
vegetarian, milk/egg/honey as excluding vegan, and wheat as excluding gluten-free.
It does not infer vegetarian status from cheese (rennet unknown), wheat absence
from rice, or gluten-free status from the absence of a wheat match. Pesto,
stock, sauces, gelatin and unrecognized compound ingredients remain unresolved.

Every matched ingredient cites the source ID, segment, exact text and Unicode
code-point offsets, plus its rule ID. The assessment pins source checksum, draft
ID/index, input digest and policy version. The digest covers source metadata,
draft, segments and evidence; a changed recipe/source must produce a new
assessment. It is an invalidation key, not a signature or proof of authorship.

Evidence must uniquely identify a ready segment and reproduce the draft source
text. Duplicate/missing evidence, failed segments, crossed source IDs and invalid
spans abstain. Negation, alternatives, optional substitutions, dietary qualifiers
and precautionary wording in the cited context also abstain. The conservative
context-wide check can suppress a valid match when an unrelated dish on the same
page contains a qualifier. This is intentional until dish-level association is
reviewed. English qualifiers and aliases are limited; multilingual input is not
certified. Even a successful literal match retains `association: unverified`.

| Result | Meaning |
| --- | --- |
| Ingredient `needs_review` | Exact rule and matching source text; dish association still unverified |
| Ingredient/assessment `unknown` | No usable rule/evidence; investigate the reason code |
| Allergen `possible_presence` | Review-only candidate from cited ingredient; never an approved “contains” label |
| Dietary `possible_incompatible` | Review-only exclusion candidate |
| Allergen/diet `unknown` | No conclusion, including where other ingredients are recognized |

All outputs require owner confirmation and have `publishable: false`. There is
no representation for an inferred allergen-free/compatible label or approval.
Source completeness, kitchen preparation, substitutions and cross-contact are
never established by this classifier. No probability scores are invented.

## RES-01 integration and owner boundary

[RES-01](https://app.clickup.com/t/86bcnfv2q) can consume
`IngredientReviewHandoffSchema` and `ingredientAssessmentForReview`. The adapter
checks the expected draft/source/digest and reconstructs cited slices using
Unicode code points, including non-BMP characters. It preserves unknowns and
original phrases instead of converting them to unchecked dietary badges.

Expected identities, digest and source segments must come from trusted saved
processing output and the current authorized draft, never from browser fields.
Schema validation and a matching digest do not authenticate a producer, verify
rule accuracy or grant tenant access. The adapter is a data boundary, not an
HTTP route, importer, storage service or owner authorization system.

The current `develop` console is a shell; RES-01's authenticated review API,
correction persistence and UI are not merged. Do not claim an integrated owner
confirmation flow from these unit tests. The required completion sequence is:

1. Import the trusted extraction and sidecar under server-derived venue authority.
2. Show originals, evidence, unresolved reasons and every proposed label in RES-01.
3. Persist owner decisions separately through the canonical command/event path,
   with current membership, expected revision, command identity and audit data.
4. Recompute on ingredient/source corrections; invalidate prior confirmation on
   revision, evidence or policy changes. Unknowns require explicit investigation.
5. Require applicable owner-confirmed claims before RES-02 publication. Never
   copy this sidecar directly into a public menu or approve it on draft save.

Existing `CreateDishRevisionSchema` rejects added classification/approval fields.
This change adds no new public payload, SQL migration or tenant-authority field.
It does not merge the pending ingestion, owner-agent or publication PRs.

## Optional reference services

- [Open Food Facts ingredient analysis](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/get-ingredient-related-analysis/)
  is the first candidate for expanding reference coverage, but packaged-product
  matches cannot establish restaurant recipes. The documented workflow includes
  human review of OCR. A future pinned taxonomy import needs provenance, license
  review, coverage tests and explicit unknown handling; none is silently fetched.
- [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide/) supplies food/nutrient
  reference data and requires an API key. It is not used as an allergen verifier.
- [Groq hosted inference](https://console.groq.com/docs/rate-limits) is optional
  future interpretation assistance. Its organization/model rate limits and model
  outputs must not determine allergen facts or bypass evidence/owner review.

No new provider is justified for this deterministic first implementation. Unknown
inputs remain unknown when services are absent; no API keys or outbound data are
needed. Future adapters must add bounded requests, rate-limit/outage tests and
provenance while preserving this review boundary.

## Verification and remaining acceptance

Regression coverage includes all nine supported categories; dairy/honey versus
vegetarian exclusions; absent/empty/plant-only input; unknown recipes; negation,
substitution and precautionary text; missing/failed/duplicate/tampered evidence;
Unicode offsets; immutable input, changed digests, offline round-trip and
no-overwrite; strict TypeScript states and refusal of publication fields. The
existing 35-page synthetic pipeline test also checks one sidecar assessment per
draft with unchanged IDs. These tests demonstrate behavior, not field accuracy
on reviewed restaurant datasets.

Remaining P0 acceptance: RES-01 live import/persistence/UI, authenticated owner
confirmation and revision invalidation, RES-02 enforcement, representative
reviewed ground truth and independent product/domain acceptance. Merge, deploy
and production readiness are separate from this implementation.
