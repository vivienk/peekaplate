# RES-01.1: candidates and source evidence

The review exporter accepts extraction schema 1 / pipeline 2 and
[schema 2 / pipeline 3](processing-v3.md). New reports preserve category hierarchy,
the category heading page and printed price options. Legacy exports stay unchanged.

The offline exporter turns the existing processor report into versioned review
data. It does not acquire menus, call OCR or an LLM, correct facts, approve dishes,
save review corrections to a database or publish a menu.

## Flow and ownership

```text
Menu PDF/photo
  -> existing OCR + LLM processor
  -> extraction.json
  -> review_candidates exporter (RES-01.1)
  -> review-candidates.json
  -> review API and correction persistence (RES-01.2, Marwan)
  -> evidence-linked review UI (RES-01.3, Nifemi)
  -> frontend/API integration (RES-01.4, Jeffin)
  -> human review and QA (RES-01.5)
```

Teeyansh's ingestion orchestration can hand over the existing full extraction
result. It does not need another OCR/LLM implementation. The exporter is a Python
function and a local command. The separately merged optional HTTP boundary is
documented in [menu-ingestion infrastructure](menu-ingestion-infrastructure.md);
VIS-01 still needs its service/report adapter and staging acceptance. No new
server or endpoint is introduced by this producer/export follow-up.

Python validates the extraction schema, original snapshot size/hash, complete
draft/evidence joins, source IDs, unique IDs, usable segment status and exact
source spans. These are structural and provenance checks. They do not prove that
a price belongs to a dish or that OCR read an image correctly. The existing LLM
extracts candidates; grounding rejects unsupported names, clears unsupported
optional fields and can recover unique source-supported prices using existing
OCR geometry as described in [processing behavior](processing-v3.md#prices).
A human must inspect the menu and correct the remaining draft values.

## Versioned contract

The consumer schema is `ReviewCandidateResultSchema`, exported from
`@peekaplate/contracts`; Python uses `ReviewCandidateResult`. This is the local
RES-01.1 implementation for team review against ARC-01, not a claim of architecture
approval or a deployed API. `schema_version` versions this review payload:
version 1 carries pipeline 2 output, and version 2 carries pipeline 3 output.
Mixed version pairs and populated version-2 fields under version 1 are rejected.
Existing version-1 fixtures and IDs remain valid.

| Field | Meaning |
| --- | --- |
| `extraction_id` | Deterministic identity from source ID, original extraction start time and pipeline version. Re-exporting the same run keeps it; a new run start time changes it. |
| `status` | Original processing state: `complete`, `incomplete` or `failed`. This is never human approval. |
| `pipeline_version`, timestamps, `extraction_model` | Original processor provenance. |
| `source` | Source ID, SHA-256, kind, original location, retrieval time and byte size. |
| `segments` | Original page/text records, methods, ready/failed/skipped states, errors, warnings and geometry metadata. |
| `candidates[].candidate_id` | Existing `DraftEvidence.draft_id`, joined through `draft_index`. No new dish ID is generated from an edit. |
| `candidates[].original` | Processor-reported post-grounding `DishDraft` fields, source text, warnings and `needs_review` status; not an immutable raw model response. |
| `candidates[].original.subcategory` | Optional smaller grouping; absent/null is valid for a flat section. |
| `candidates[].original.category_page_number` | Reported source page of the main heading, including a preceding page for supported continuation. |
| `candidates[].original.price_text` | Printed price text, including multiple options. Option meanings still require review. |
| `candidates[].evidence` | Original segment IDs and source text spans. |
| `candidates[].missing_fields` | Unknown description, category, price, currency or ingredients. A null scalar amount is not listed as missing when printed price text is present. This list does not decide publication completeness. |
| `warnings`, `errors` | Original extraction warnings and errors, including failures on other pages. |

Use `(extraction_id, candidate_id)` to identify a candidate across sorting and
review. The ID is not a tenant authorization token or a database dish ID. The
backend must keep the original extraction identity and values immutable, store
reviewer corrections separately, and check actor/venue authority server-side.
Renaming a candidate or correcting its price must not regenerate its ID.

Prices serialize as decimal strings or null. `"0.00"` is a known zero price;
an amount can be null when `price_text` preserves multiple options. The new
optional fields are omitted when unknown; version-1 serialization stays intact.
Currency is an explicit three-letter code or null. Rejected
raw model suggestions were not retained as facts by the processor: when it clears
an unsupported optional field without a unique source-supported replacement,
the export preserves its null and warning. Source-price recoveries and duplicate
handling occur in the processor before the report is saved, never during export;
separate raw-suggestion retention still requires an agreed contract. Do not
infer a stable field error code by parsing warning prose. No numerical confidence
is available; no percentage is fabricated. Ingredients are not an allergen claim.

The source byte snapshot stays in the private full `extraction.json`; the export
does not duplicate its base64 bytes. Keep the original report/file available by
hash. A source `location` may be a local path, not a browser-accessible URL. Marwan's
authorized source/asset delivery must resolve it for the UI; do not expose a local
filesystem path as an unauthenticated file-serving endpoint.

## Evidence and invalid input

Teeyansh's VIS-01 adapter must explicitly accept schema 2 / pipeline 3 and preserve
the three new fields before integrated use. Marwan's review API must retain them
in originals and draft save/reload, with corrections stored separately. Coordinate
changes to the shared Python schema with the VIS-03 asset models; candidate IDs
are extraction references, not backend dish/revision UUIDs.

The image-only experiment produced raw dish JSON, not this evidence-linked report.
This exporter still requires source text and valid text spans. It does not invent
OCR text or adapt image-only results into text evidence. That modality requires an
agreed contract before integration.

Offsets count Python Unicode code points: zero-based start, exclusive end. The
source text is never normalized by the exporter. TypeScript validates slices via
`Array.from(text)`, not `text.slice(start, end)`. For multiple spans, slices in
their supplied order, joined with a newline, must equal `original.source_text`.

The exporter requires one evidence record per draft, without duplicate candidate
or segment IDs. Evidence must reference a ready, error-free segment. An explicit
`category_page_number` must also resolve to a present, ready, error-free page with
non-empty text; it can differ from the dish's own evidence page. This structural
check does not prove that the heading's wording or semantic role is correct. Missing,
reversed and out-of-range spans, mismatched text, failed/skipped evidence, invalid
schema/amounts and source snapshot mismatches fail the export. A partial extraction
keeps its valid candidates and all failed/skipped segments; a failed extraction
with no candidates remains an explicit failed result. Broken joins are not
silently dropped to manufacture a successful result.

References cannot be whitespace-only and provenance timestamps must include a
timezone, matching the TypeScript consumer's requirements.

Page-level evidence remains page-level. Available `ocr_regions`, upload dimensions,
`ocr_coordinate_space`, `native_words` and PDF point dimensions survive unchanged
in segment metadata. This does not assign a precise rectangle to each dish or
field. The UI must support showing the page/text when boxes are absent or ambiguous.

## Test it locally

From `processing`, run the synthetic input without credentials or provider calls:

```sh
uv run --frozen python -m peekaplate_processing.review_candidates \
  --input tests/fixtures/review-candidates/representative-extraction.json \
  --output work/res-01-manual/review-candidates.json
```

Expected: `Saved 3 candidates (incomplete)` and a reminder that human review is
required. Open the JSON and compare Garden Soup's `"8.50"`, Coffee's null price
and Bread's `"0.00"`. Pages 2 and 3 remain failed/skipped. These are clearly
[labelled synthetic examples](../processing/tests/fixtures/review-candidates/README.md).

To test the new fields, use `representative-extraction-v2.json` as the input and a
new output path. Its three candidates cover printed price options with hierarchy,
an unknown price and a known zero price. The same expected export is validated
by the Python and TypeScript tests.

For an existing real PDF test, use its full `extraction.json` as `--input`, rather
than `pages.json` or the earlier convenience `drafts-review.json`. Choose a fresh
`--output` path each time; existing files are preserved. Exit code 0 means the
export succeeded, even when its processing status is incomplete/failed. Invalid
input, bad evidence or an existing output path exits with code 1.

To check failure handling:

```sh
uv run --frozen python -m peekaplate_processing.review_candidates \
  --input tests/fixtures/review-candidates/invalid-extraction.json \
  --output work/res-01-manual/invalid.json
```

Expected: exit 1 and no `invalid.json` created. The existing input is never edited.

Run the focused tests from `processing`:

```sh
uv run --frozen python -m unittest discover -s tests -p test_review_candidates.py
```

From the repository root, run consumer tests and checks:

```sh
pnpm exec vitest run packages/contracts/src/review-candidates.test.ts
pnpm --filter @peekaplate/contracts typecheck
pnpm verify lint typecheck test context:check docs:check
```

The Python tests also exercise a synthetic native PDF through the actual pipeline
with a mocked extraction LLM and forbidden OCR calls, then export the saved report.
Complete and partial cases preserve three candidates, original IDs and evidence,
heading-page inheritance, all printed options and a known zero price.

These tests establish the offline handoff, not the review API/save/reload flow,
hosted source access, deployment, independent human acceptance or extraction
accuracy. No PR or public task update is needed to run them locally.
