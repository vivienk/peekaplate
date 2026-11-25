# Extraction findings and recommendations

Scope: PeekaPlate extraction and review from PR #24 through PR #58 and the local ingredient-aware V4 changes atop `a4d4889`. This records the previous review, not implementation or release approval. See [contract impact](extraction-contract-impact.md) for compatibility decisions and collaborator evidence.

## Standards findings

| Priority | Finding |
|---|---|
| P1 | `backend/src/ingestion/adapter.ts:211–225`: loose evidence containment can accept spans that do not reconstruct `source_text` in order. Align with the review export rule. |
| P1 | `backend/src/ingestion/adapter.ts:129–137`: the name-substring fallback can reuse another draft's evidence. Use exact, unique joins. |
| P2 | `packages/contracts/src/review-candidates.ts:16–21`: UTF-16 length limits can reject a value accepted by the Python producer's code-point limits. Align the implementations. |
| P2 | `processing/src/peekaplate_processing/vision_extraction.py:198–203`: applying regex case insensitivity after explicit case folding can retain a different spelling such as `basıl` for `basil`. Match folded phrases literally. |

## Spec findings

| Priority | Finding |
|---|---|
| P1 | Hosted intake accepts up to ten PDF pages but V4 consumes one attempt per page under a two-attempt job budget. Offline reproduction: three pages, two successful responses, zero drafts persisted, status `failed`. Preserve completed pages and identify unprocessed pages without raising the budget. |
| P1 | Review labels model-transcribed excerpts “From the menu” without showing that provenance or consuming approximate V4 regions. Keep those distinct from original OCR and source images. |
| P1 | Ingredient proposals can be retained from `without cheese` when the provider proposes `cheese`. Abstain when support is explicitly negative, optional or uncertain. |
| P2 | Overlong price groups correctly leave the bounded scalar/literal fields unknown, but the full literal is lost from review evidence. Preserve it as review-only evidence, not as a truncated price. |

## Recommendations

1. Preserve completed pages at budget exhaustion, timeout and later-page failure; test strict ingestion through review bootstrap as well as the producer.
2. Use existing provenance and price fields where possible; verify consumers and existing artifacts before tightening validation or changing evidence text.
3. Measure successful page coverage, price/description/ingredient fidelity, provider attempts, tokens and latency before changing concurrency. Saved single-run timings (baseline → coverage-only): Panania 51 → 74 s; Twin City 39 → 41 s. These are not a latency benchmark.
4. Once partial persistence is safe, compare bounded page scheduling within the same budget. Profile Unicode span conversion before optimizing it. Keep coverage-only as the development candidate; no held-out or hosted release acceptance was established.

Partial-page retention restores the behavior already demonstrated for OCR in [PR #24’s page-isolation regression](https://github.com/vivienk/peekaplate/pull/24#discussion_r4358024865). It does not revoke the [PR #58 no-fallback-after-deadline agreement](https://github.com/vivienk/peekaplate/pull/58#issuecomment-6590309497): with no retained candidates the result stays failed; with valid earlier pages it may be incomplete, subject to the hosted consumer checks in the linked contract-impact report.
