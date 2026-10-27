# Synthetic review candidate fixtures

These are integration examples, not live OCR/model results or accuracy evidence.
The input includes a generated three-page PDF snapshot. Page 1 has synthetic
menu text; page 2 has an injected OCR failure; page 3 is explicitly skipped.
No OCR or model request was made to create these fixtures.

| Fixture | Meaning |
| --- | --- |
| `priced-candidate.json` | Garden Soup, explicit `8.50 CAD`; other unknown fields remain null. |
| `missing-price-candidate.json` | Coffee, unknown price and currency; both appear in `missing_fields`. |
| `zero-price-candidate.json` | Bread, explicit `0.00 CAD`; zero is preserved and is not missing. |
| `representative-extraction.json` | Full processor-shaped input containing the three candidates, failed and skipped pages. |
| `representative-candidates.json` | Expected version 1 review export; consumed by Python and TypeScript tests. |
| `representative-extraction-v2.json` | Schema 2 / pipeline 3 synthetic input: grouped price options, unknown price and zero price, plus failed/skipped pages. |
| `representative-candidates-v2.json` | Expected version 2 export; both languages preserve subcategory, heading page and printed prices without treating a known price pair as missing. |
| `field-limits.json` | Shared Unicode boundary cases for name, description and printed price text; both languages count code points. |
| `invalid-extraction.json` | A source span extends beyond its page text; export must fail without creating output. |

All three candidates remain `needs_review` and carry page-level evidence.
Contract tests additionally cover Unicode offsets, absent/duplicate evidence,
failed/skipped evidence, wrong source identity, malformed amounts and forbidden
confidence/publication fields. See the [handoff guide](../../../../docs/review-candidates.md).
