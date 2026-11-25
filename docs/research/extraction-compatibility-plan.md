# Compatibility-first extraction fixes

Basis: [review findings](findings%20and%20reco.md) and [collaborator contract audit](extraction-contract-impact.md). This plan applies to the local ingredient-aware V4 producer. It does not authorize a push, deployment, schema migration, provider call, or rewrite of stored artifacts.

## Invariants

- Leave shared extraction/review schema pairs `1/2` and `2/3`, nullable field shapes, Unicode code-point offsets, exact span reconstruction, and current limits unchanged. Leave the Google request schema and coverage-only prompt as they are in the donor.
- Preserve the four-key hosted V1 envelope, compatibility `input_mode: ocr_image`, actual `extraction_mode: vision_v4`, empty direct-vision OCR suggestions, and separation of approximate vision boxes from OCR evidence.
- Do not rewrite old attempts, candidate IDs, originals or review corrections. Keep public Bundle v1, approval, publication, database and HTTP contracts unchanged. Successful supported content is not intentionally modified; bug fixes change only the affected values on new runs.

## Implement now

1. **Preserve completed pages.** Carry already parsed dishes out of a later-page failure without parsing private capture logs. Keep successfully processed pages usable, record the failed/unattempted page dispositions using existing fields, and export the result as `incomplete` when valid drafts survive. Without valid drafts keep existing failed/fallback behavior as applicable. Budget denial and deadline remain terminal, with no new provider/OCR call or cap increase. A request failure after a successful page must not replay already consumed pages.
2. **Reject unsupported ingredient proposals.** Match normalized phrases literally rather than applying a second regex case conversion. Keep a proposal only when a same-description occurrence independently supports it; reject explicit exclusions and optional/choice/substitute clauses, without allowing negated evidence to override a separate positive occurrence. Keep unsupported lists null, preserve printed descriptions, and never infer allergens or certainty.
3. **Exercise the existing consumer boundary.** Audit exact evidence, Unicode and partial-status behavior with existing version fixtures and the draft-to-review path. Do not tighten the shared adapter/validator in this slice without evidence that legacy artifacts still work. Test positive compatibility alongside the failure cases.

## Acceptance and coordination gates

- Use offline pipeline and export checks for later-page budget denial, timeout and provider/parse failure, including no calls after terminal events and unchanged normal-case output. Verify literal vs. near-match, negated, optional and positive ingredient occurrences. Confirm output remains review-only; do not substitute raw provider guesses for trusted OCR.
- Preserve the two-attempt hosted job cap. Support for all pages of accepted 3–10-page PDFs requires an agreed policy with Teeyansh; partial persistence alone does not deliver full coverage.
- Obtain agreement before changing legacy adapter acceptance rules, review image delivery/provenance UI, or an over-limit price evidence representation. Do not add metadata keys or expand existing payload caps as a workaround. Validate both schema/pipeline pairs and original/correction save and reload before shipping those changes.
- Record exact local test results separately from hosted upload/review/save/reload and independent accuracy, which require their own authorization and evidence. Re-run the compatibility fixtures whenever the producer or review contract changes.

## Local verification

- Python offline runner: `-p 'test_input_modes.py'` (36 passed), `-p 'test_vision*.py'` (17 passed), `-p 'test_export_contract.py'` (4 passed). New regressions went red before the fixes.
- Vitest: `review-candidates.test.ts`, `adapter.test.ts`, `workflow.integration.test.ts`, `contract.test.ts`, and `review-artifact.test.ts` (91 passed). Existing parsed-JSON goldens were not changed.
- A fresh synthetic three-page PDF yielded two saved candidates and one skipped page after budget denial. The TypeScript adapter accepted the result as incomplete; the review projection equaled the Python export and passed the producer-artifact verifier with a local artifact reader. This was not authenticated hosted bootstrap or correction/save/reload.
- The existing v2/v3 ingestion fixture for `Special Ribs` reconstructs two spans with a space, not a newline. Do not impose a newline-only restriction across historical ingestion artifacts without an explicit compatibility decision.
- Final offline Python suite: 674 passed. The resumed-429 regression proves a parsed empty page is not requested again, and the ingredient export fixture covers “instead of” and a separate affirmative clause. First-page terminal failures without retained drafts keep the historical failed-report shape.
- Final TypeScript checks: workspace and data06 typechecks passed with the installed `pnpm`; `pnpm test` passed 1,953 Vitest checks and 117 Node script checks, with 5 Vitest checks skipped. The composite `pnpm check` could not find `corepack`; its typecheck commands ran directly. Biome, context freshness, and local documentation links passed.
