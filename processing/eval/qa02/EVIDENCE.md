# QA-02 reference preparation: expected versus actual

Prepared by Sai, November 13, 2026. This is an **offline integrity record**, not
an accuracy or release acceptance report. The example source is fictional and
already used in development. No untouched holdout or paid model run was added.

## Observed source readings awaiting independent confirmation

| Entry | Reference answer | Application actual | Disposition |
| --- | --- | --- | --- |
| Garden Soup, page 1 / SOUPS | `vegetables`; ordered `8.50 / 12.50 CAD`; scalar null; no invented option labels | NOT RUN against this frozen reference | Await Uneeza's source check, then an approved pinned producer run. |
| Coffee, page 1 / HOT DRINKS | No price, currency or description printed | NOT RUN | Keep missing facts unknown. |
| Bread, page 1 / BAKERY | `0.00 CAD`, one printed option and scalar 0.00 | NOT RUN | Do not collapse known zero into null. |
| Pages 2 and 3 | Visually blank | Rendered both pages and observed no entries | Explicit source exclusions, not failed/unprocessed pages omitted after scoring. |

The source and reference hashes are in `development.manifest.json`. The source
reading used the original rendered PDF, not a model prediction. A second reviewer
must still confirm it; no human-review decision has been fabricated.

## Executed controls

| Check | Expected | Actual | Result / boundary |
| --- | --- | --- | --- |
| Verify committed manifest | One development case, 3 entries, all source/reference bytes unchanged | Matched; 3 source pages accounted for, 0 holdouts, review pending | Integrity PASS only. |
| Require independent review | Reject pending review; no false ready/accepted result | Nonzero exit; `independent reference review is still pending` | Expected block observed. |
| Price representation | Multi-price scalar null; unknown separate from zero | Focused regressions exercise valid/invalid shapes | Protocol coverage; not menu accuracy. |
| Hash/split/page controls | Reject source/reference mutation, leaked source families, duplicate occurrences/cases, invalid page counts and missing page dispositions | Focused regressions cover each boundary | Local checks; no model/network traffic. |
| Private error handling | Explain safe controlled failures without printing raw annotations/paths | Regression reproduced generic pending-review error, then verified useful sanitized reason | CLI regression, not authenticated reviewer identity. |

Reproduce:

Fresh local verification on November 13:

- `uv run --project processing --extra service --frozen python processing/tests/run_offline.py`:
  **536 PASS**, 41.500 s test time / 45.672 s command time; network blocked.
- Focused `test_qa02_reference.py`: **18 PASS**, 0.745 s test time.
- `pnpm check`: **1,419 unit + 74 script tests PASS**, lint/types/context/docs PASS;
  Vitest 9.16 s, script tests 1.91 s. A later context/docs check refreshes this handoff.
- `pnpm verify build`: PASS, both frontends and Worker dry-run.
- `uv build --project processing`: PASS, source archive and wheel.
- Committed manifest integrity: PASS; `--require-reviewed`: expected exit 1.

Independent checks reproduced a hash/read race (four replacement entries consumed
after verifying the original three) and a rejected qualified null scalar. The
corrections parse the same bounded byte snapshots that were hashed and require an
explicit reason for a qualified single-option null. The focused regressions pass.

```sh
uv run --project processing --extra service --frozen python -m unittest discover -s processing/tests -p test_qa02_reference.py
uv run --project processing --extra service --frozen python -m peekaplate_processing.qa02_reference verify processing/eval/qa02/development.manifest.json
```

The pending-review negative check is:

```sh
uv run --project processing --extra service --frozen python -m peekaplate_processing.qa02_reference verify processing/eval/qa02/development.manifest.json --require-reviewed
```

Its exit code must be 1 until a real independent review is recorded. Do not list
that expected failure as an application failure or claim the reference is approved.

## Final-run ledger to fill using actual evidence

| Run ID / set | Source + frozen reference hashes | Producer/scorer commit; model/config/cache | Expected | Actual + raw-output hash/link | Result / owner |
| --- | --- | --- | --- | --- | --- |
| NOT RUN | Pin before execution | Mohammad to provide | Reference occurrence and complete field/group expectation | Not available | BLOCKED: private source/reference review and pinned scorer/run required. |

For each real run, include date/environment/input mode, page/entry identity,
counts and denominators, missing/extra/duplicate entries, unknown/partial prices,
wrong assertions, timeouts/acquisition failures and retry history. Keep development,
supplemental and holdout results separate. Do not revise references after seeing
predictions without retaining the prior version and recording adjudication.

## Remaining evidence

- Patis/Virginia original image bytes and page/occurrence-based independent labels
  are missing from this checkout. Their 83/23 legacy key entries remain unreviewed
  development data; `development-inventory.json` records this without altering history.
- No untouched holdout population is registered or approved here.
- Strict QUAL-01 scoring, real OCR/vision/model accuracy and rubric release
  acceptance are **NOT RUN** by this PR. The historical fuzzy scorer is unchanged.
- DATA-12/metric validation (#155/#167), DATA-06 (#144) and hosted tracking/report
  reconciliation retain their own evidence; they are not duplicated or closed here.
