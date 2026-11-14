# Strict menu field scoring: QA-02 / VIS-04

This offline scorer measures saved **original** extraction fields against reviewed
references. It does not generate predictions, replace the historical fuzzy scorer,
change production contracts, approve a dish or establish release acceptance.
The [specification](../../../docs/qa02-strict-scorer-spec.md) was
[published before implementation](https://app.clickup.com/90141746115/docs/2kydvry3-3554/2kydvry3-2114).
See [PR181](https://github.com/vivienk/peekaplate/pull/181) for the exact code pin and verification.

## Before predictions

1. Agree the [exact source/page/split proposal](../../../docs/qa02-real-menu-source-plan-v1.md),
   source use/access and exposure history. Candidate holdouts are not certified holdouts.
2. Author source-only answers using [PR169's existing format](README.md), with every
   selected page and entry accounted for. A different human independently checks them.
3. Record the real decision and freeze/verify the private reference bytes. Recorded
   names/decisions are declarations; the CLI does not authenticate human identity.
4. Agree normalization, matching, denominators and missing/failure rules before outputs.
   Vivien's menu-specific threshold approval and explicit call/retry authorization remain
   separate requirements; existing broader rubric criteria are not replaced.

Uneeza confirmed the three fictional example readings in
[PR169](https://github.com/vivienk/peekaplate/pull/169#issuecomment-6875165425).
Its committed example manifest still has a pending review record. This guide does
not edit that record or turn synthetic review into real-menu approval.

```sh
PRIVATE_QA02_DIR="${PRIVATE_QA02_DIR:?set the approved private QA-02 directory}"
PRIVATE_MANIFEST="$PRIVATE_QA02_DIR/frozen.manifest.json"
PRIVATE_RUNS="$PRIVATE_QA02_DIR/runs.json"
PRIVATE_OUTPUT="$PRIVATE_QA02_DIR/receipts/$(date -u +%Y%m%dT%H%M%SZ).json"

uv run --project processing --extra service --frozen \
  python -m peekaplate_processing.qa02_reference freeze \
  "$PRIVATE_QA02_DIR/reference-template.json" --output "$PRIVATE_MANIFEST"
uv run --project processing --extra service --frozen \
  python -m peekaplate_processing.qa02_reference verify \
  "$PRIVATE_MANIFEST" --require-reviewed
```

These are operator commands, not evidence that a real-menu freeze has happened.
Keep originals, labels, ledgers and receipts outside Git. Never change truth after
seeing outputs to improve the result; corrections require retained prior versions
and explicit adjudication.

## After authorized predictions: the run ledger

Retain the exact producer commit/command, model/configuration, cache, source bytes,
original report, candidate export and failures. Prepare a private `qa02.runs.v1`
ledger. Human occurrence association happens **after** outputs exist, under the
procedure fixed before predictions; it is not the earlier source-reference approval.
Do not add predicted fields to the ledger or rewrite actual candidate originals.

The models reject extra keys. Paths in the ledger resolve relative to its directory;
source/reference paths use the existing manifest's directory.

| Root field | Required value |
| --- | --- |
| `schema_version` | `"qa02.runs.v1"` |
| `manifest_sha256` | SHA-256 of the exact frozen manifest bytes; 64 lowercase hex characters |
| `condition` | Nonempty declared experimental condition, not proof of the executed path |
| `producer_commit` | Declared producer revision, 40 lowercase hex characters; not authenticated by the CLI |
| `prepared_by` | Nonempty ledger-preparer identity declaration |
| `association_review` | Existing `{status, reviewer, decision_reference}` shape; `status: "recorded"`, nonempty reviewer different from `prepared_by`, nonempty decision reference |
| `cases` | Every manifest case exactly once, no extra or silently absent cases |

| Case field | Required value |
| --- | --- |
| `case_id` | Existing manifest case identity |
| `input_route` | `"image"`, `"pdf"` or `"url"`; declared intake route |
| `state` | `"captured"` or `"unavailable"` |
| `unavailable_reason` | Null when captured; otherwise `not_attempted`, `acquisition_failed`, `provider_failed`, `timeout` or `invalid_artifact` |
| `report` | Captured: `{path, sha256}` for the actual saved report; unavailable: null |
| `candidates` | Captured: `{path, sha256}` for the actual saved export; unavailable: null |
| `producer_command` | Captured: actual nonempty command; unavailable: nullable declaration |
| `associations` | List of links below; unavailable cases require an empty list |

Each association contains exactly `candidate_id`, `entry_id`, `evidence_index`.
An associated candidate names an existing reference entry and an integer index into
its actual evidence spans. An explicitly unassociated candidate uses null for both
`entry_id` and `evidence_index`. Duplicate/unknown candidate rows, nonexistent entries
and invalid spans fail closed. Omitted candidates remain unresolved extras, not ignored.

Unavailable cases retain all reference denominators. Keep their original diagnostic
artifacts separately; do not manufacture an empty successful export to score them.

## Run the scorer

Use a checkout containing the pinned scorer and its PR169 dependency:

```sh
mkdir -p "$PRIVATE_QA02_DIR/receipts"
uv run --project processing --extra service --frozen \
  python -m peekaplate_processing.qa02_strict_score \
  --manifest "$PRIVATE_MANIFEST" \
  --runs "$PRIVATE_RUNS" \
  --output "$PRIVATE_OUTPUT"
```

The public programmatic seam is `score(manifest_path: Path, runs_path: Path) -> dict`;
`main(argv=None)` returns the process exit code. No providers or network are used.

The scorer checks reviewed-reference integrity and hashes bounded input snapshots.
Each captured report must identify the frozen source and regenerate exactly the
supplied candidate export through the existing exporter. Source snapshot bytes,
IDs, evidence, original values and export consistency are not trusted from filenames
or a caller-supplied extraction ID. Invalid input returns nonzero sanitized JSON;
no private names, source paths or raw validation/provider errors are printed.

Output is a create-only JSON receipt at mode0600. Existing files are not overwritten.
Successful stdout contains bounded counts/status, with acceptance explicitly **NOT
ESTABLISHED**. Exit0 means a receipt was computed, not that extraction passed.

## Fixed scoring rules and interpretation

- **Occurrence association:** the first candidate in original export order consumes
  a reference entry. A later duplicate cannot rescue an earlier wrong reading.
  Repeated names remain distinct occurrences; no best-score or name-only matching.
- **Page/role:** the selected actual span must cite the reference page. Wrong-page
  links score no success and remain visible on the actual page, with the reference
  missing on its expected page. A qualifier is not a dish denominator or dish success.
  Semantic section/location association remains the independent human's judgment.
- **Names:** only `lower()` and whitespace folding (`split()`/single-space join).
  No casefold expansions, accent/trademark/punctuation removal, spelling/alias repair
  or fuzzy/semantic equivalence.
- **Price fields:** all of complete literal `price_text`, nullable finite Decimal
  scalar and nullable currency must match. Numeric formatting may be Decimal-equivalent;
  literal text still follows the strict text rule. Partial/reordered/extra options or
  qualifiers, wrong currency and an invented scalar for multiple prices fail the
  complete emitted-field comparison.
- **Representation limit:** there is no actual structured option array. The measure
  is whole-literal/scalar/currency preservation, **not independent semantic option
  parsing**. Never create actual options by copying reference options. Labels outside
  the emitted literal require an agreed source-reviewed decision before group acceptance.
- **Unknown versus zero:** null is not0. A dish reference with printed options or
  non-null price text is a known literal group; nonnumeric ambiguous text remains
  explicitly labeled. A reference with no price text/options/scalar is unknown.
  Correct abstention needs a real correctly associated candidate with all three actual
  price fields null. Missing output is not a successful abstention; unsupported
  price/currency assertions are reported separately.
- **Denominators:** recall includes every eligible reference dish; precision includes
  every emitted candidate, including duplicates/extras/unresolved/role errors. Price
  coverage includes all eligible reference groups, even on failed/missing/unavailable
  pages. Every source page is enumerated; frozen exclusions are not permission to
  hide a failed readable page. Whole-report errors remain visible even if segments are ready.
- **Aggregates:** sum counts before computing rates; never average page percentages.
  Receipts separate case/page/split/input-route/reported-mode results. Pooled counts
  are not held-out quality. Zero denominators give null/N/A with a reason, never100%.

The receipt binds manifest/run/report/export/source/reference hashes and scorer
implementation-file SHA-256, expected/actual rows and dispositions. Producer commit,
condition, model/configuration/mode and reviewer identity remain recorded assertions;
reviewers verify actual execution against the external pinned commit and run receipts.

## Unmeasured acceptance lanes

The unchanged v1 reference has no ingredient/geometry truth. Ingredients, source-verified
boxes/transforms, confidence/illegibility, unsupported food/allergen assertions, recovery
and actual hosted correction/reload require separately frozen annotations and independent
receipts using the same case/entry/output hashes. They are labeled **NOT MEASURED**, not
passed. Null ingredients remain missing coverage where ingredients are printed; never
infer a recipe to conceal that gap. Reuse existing verification/review flows rather
than introduce a second approval UI. No threshold or release gate is applied here.

## Focused regression verification

```sh
uv run --project processing --extra service --frozen --offline \
  python processing/tests/run_offline.py -p 'test_qa02*.py'
```

The guarded runner rejects parent/child network attempts and zero discovered tests.
On 2026-11-14 the initial combined reference/scorer run passed **38 tests in4.193s**,
including actual module-CLI, create-only/private output, tampering, duplicates,
missing/failed/unavailable pages, whole price fields and null/zero controls.
An additional CLI-argument privacy regression exposed argument parsing outside the sanitized
error handler. After correction, the focused actual-module CLI test passed in5.334s, including
both invalid-argument cases. The exact current revision and CI evidence are recorded on PR181.
These synthetic/offline controls are not real-menu accuracy or hosted acceptance.
