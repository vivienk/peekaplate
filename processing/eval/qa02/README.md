# QA-02: source references and evidence handoff

Hi Uneeza and Mohammad, I’ve prepared the reference format and integrity checks
here so we can reuse the work already done. This does not ask Uneeza to regenerate
the synthetic event dataset. It also does not turn the earlier menu trials into
untouched holdouts or a completed accuracy evaluation.

Task: [QA-02](https://app.clickup.com/t/86bcng0d7).
Requirements: [QUAL-01](../../../docs/extraction-acceptance.md#qual-01--frozen-references-and-strict-held-out-evaluation)
and the [rubric task, review v0.4](https://app.clickup.com/t/86bcex5vm).
The v0.4 review records accepted numerical targets/planning minimums; frozen-gold
approval, the independent run and final acceptance are still separate. This
validator sets no new quality thresholds and does not score predictions.

## What is ready

- `development.manifest.json` freezes the existing fictional
  [three-page PDF](../../../tests/fixtures/menu-ingestion/synthetic-review-options.pdf)
  and `synthetic-menu.reference.json` by SHA-256. Page 1 was rendered/read for the
  annotations below; pages 2 and 3 are visibly blank and explicitly excluded.
- Three source-based entries demonstrate an ordered two-price group, an unknown
  price/currency, and a known zero. They remain **pending a second source reading**.
- `development-inventory.json` identifies the existing Patis (83 entries) and
  Virginia (23 entries) keys as development material. Their original keys/scorer
  are unchanged. They still say agent-drafted/unreviewed. The original image bytes
  are not present in this checkout, so neither key is frozen or approved here.
- Untouched holdouts: **none registered**. A crop/rotation of an inspected source
  stays in the same source family; it is not a fresh holdout.
- [Evidence and next actions](EVIDENCE.md) distinguish executed integrity checks
  from reference approval, model evaluation and hosted integration.

## Reference answers: actual synthetic source example

| Identity / location | Literal expectation | Price truth |
| --- | --- | --- |
| `p1-soups-1`, page 1, SOUPS | Garden Soup; description `vegetables` | Printed `8.50 / 12.50 CAD`; ordered amounts 8.50 and 12.50, labels not printed, scalar null. |
| `p1-hot-drinks-1`, page 1, HOT DRINKS | Coffee; no printed description | Price, options and currency unknown. Don’t inherit CAD from another dish line. |
| `p1-bakery-1`, page 1, BAKERY | Bread; no printed description | Printed `0.00 CAD`; scalar 0.00, one option, currency CAD. Zero is not unknown. |

Use one stable occurrence ID per printed entry, including repeated names. Record
the page, literal section, location and dish/qualifier role. Keep complete printed
option labels/order and source text; don’t repair spelling, infer a default option
or invent ingredient/allergen facts. A qualified single option can retain a null
scalar with an explicit `scalar_null_reason`; one option alone does not prove an
unambiguous dish price. The reference format is an evaluation
worksheet, not a production API request. The validator checks its structure and
bytes, not whether every transcription is correct or complete.

## Reuse it for private menu references

Keep real sources, annotations, predictions and outputs outside Git, for example
under ignored `work/qa02/<version>/`. Don’t commit restaurant source files or raw
provider reports to this public repository.

1. Copy the example reference and manifest into that private folder. Replace the
   case/occurrence IDs, source path, actual page count, source permission and literal
   annotations. Explicitly account for every page; illegible/unprocessed pages
   must not disappear from a later quality denominator.
2. Set `split` to `development`, `supplemental` or `holdout` honestly. Set
   `previously_inspected` from actual development history. For a changed image,
   record the original source SHA-256 as `original_source_sha256` so variants
   cannot leak across splits. These history/permission fields are operator
   declarations, not something a hash can prove.
3. Use null source/reference hashes only in the initial draft template. Keep
   reviewer status pending until a different reviewer has checked the actual
   source. Freeze the reference before the new predictions are produced:

   ```sh
   uv run --project processing --extra service --frozen python -m peekaplate_processing.qa02_reference freeze work/qa02/v1/template.json --output work/qa02/v1/frozen.manifest.json
   ```

   The command computes hashes, checks actual PDF/image page count and creates
   the output once. It refuses to replace a previously recorded mismatching hash
   or overwrite an old manifest. Private frozen paths are absolute; keep that
   artifact private. Retain older versions when correcting annotations.
4. Verify source/reference bytes before execution and again when reviewing results:

   ```sh
   uv run --project processing --extra service --frozen python -m peekaplate_processing.qa02_reference verify work/qa02/v1/frozen.manifest.json --require-reviewed
   ```

   A pending review fails with a nonzero exit. A recorded review requires a
   different reviewer and a decision reference; the CLI does not authenticate
   their identity or replace actual review. Changes to a reference require a new
   version/hash/freeze, with the reason recorded rather than a silent rewrite.
5. Mohammad pins the producer commit, exact command, source/manifest hashes,
   input mode, model/config, cache state and saved output hashes. Keep the model
   outputs separate until the reference reading is settled. Any new paid run
   needs its own explicit budget/approval; this PR launches no provider calls.
6. Compare expected and actual by source/page/section/occurrence. Record complete
   price groups, unknowns, missing/extra/duplicate entries and failures separately.
   Use only agreed normalization/denominators. The historical
   `processing/eval/evaluate.py` is fuzzy matching and **not the QUAL-01 scorer**.

To check the committed example now:

```sh
uv run --project processing --extra service --frozen python -m peekaplate_processing.qa02_reference verify processing/eval/qa02/development.manifest.json
```

Its expected result is integrity PASS, one development case, three entries,
zero holdouts, pending independent review, and model quality NOT RUN.
Adding `--require-reviewed` must currently fail. Neither command approves a dish,
publishes a menu or certifies the application journey.

## Who does what next

- **Uneeza:** check the three example readings against the PDF; link existing
  references/evidence rather than recreating them. Flag every disagreement.
- **Mohammad:** provide the permitted original menu files/private access and exact
  saved-run/scorer identities for the real development cases. Confirm the rubric
  mapping for the intended OCR/vision cases. Don’t use predictions as reference answers.
- **Sai:** review the reconciled source readings and final expected/actual ledger.
  Record all critical failures and unresolved disagreements before sign-off.
- **Vivien / rubric owners:** retain the approved criteria and make any missing
  extraction-specific population/threshold decision explicit before scoring.

This preparation can be reviewed now. Real menu accuracy, untouched-holdout
quality, application AI and hosted owner-to-diner/report acceptance remain open.
