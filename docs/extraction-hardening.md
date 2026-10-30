---
id: vis02-res01-hardening
type: module-design
status: draft
title: VIS-02 and RES-01.1 hardening acceptance contract
references: [vis02-release-acceptance]
---

# Extraction hardening: requirements and verification contract

Written before hardening production changes. This contract clarifies the user's approved
conservative behavior; it does not amend accepted ADRs or authorize release. Owners:
VIS-02/RES-01.1 producer (Mohammad); correctness review (Sai); VIS-01 orchestration
(Teeyansh); review persistence (Marwan); UI (Nifemi/Jeffin). See
[processing](processing-v3.md), [export](review-candidates.md),
[infrastructure](menu-ingestion-infrastructure.md), and [release acceptance](extraction-acceptance.md).
ADR0001/0003/0005/0007 are accepted; ADR0015 remains proposed.

## Snapshot and execution ordering

The active source is the canonical checkout, not the older backup or empty workspace
gitlink. Baseline HEAD is `7c961d83f031d7ea5b905ffa5843bb9eacc3888b` **plus dirty
producer/layout fixes and untracked regression files**. The private baseline manifest
records every relevant source hash, Git status and the original binary dirty patch;
its SHA-256 is `7c476e716a6266d2743f5dfc2f5009c7df5bcc1812982aedc5edd1a80f813222`.
Do not identify the snapshot by HEAD alone or reset existing work.

For each slice: contract readiness → executable positive/negative/boundary tests → run
unchanged implementation → diagnose real defect (not harness failure) → minimal fix →
unchanged tests and surrounding suites → independent pinned-snapshot review. If already
fixed, record NOT REPRODUCED with test evidence; do not manufacture red. Matrix results
start NOT WRITTEN/NOT RUN. Record exact commands, observed red assertions, source hashes
and final results in a separate evidence ledger, not by rewriting acceptance criteria.

## Common verification contract

All requirements below inherit these constraints. Tests use only committed synthetic
fixtures, temporary files and injected deterministic transports. Never load private env
files or make OCR/model requests. Python version is pinned by `processing/.python-version`
and dependencies by `uv.lock`; service extra is required for service tests. Node 24.x
and pnpm11.25.0 are required for pinned TypeScript acceptance. A substituted runtime is
reported separately, never called pinned acceptance. `uv --offline` is not a network guard.

Commands below run from `processing` with frozen dependencies installed:

- `P`: `uv run --frozen --offline --no-env-file python -m unittest discover -s tests`
- `F(file)`: `uv run --frozen --offline --no-env-file python -m unittest discover -s tests -p '<file>'`
- After HAR-08, the guarded full command is `uv run --frozen --offline --no-env-file python tests/run_offline.py`.
- `T`: from root, `pnpm exec vitest run packages/contracts/src/review-candidates.test.ts`.

No factual correction is allowed in export. Exact source text, Unicode code-point offsets,
saved OCR literals/indices/fractional coordinates, originals, IDs, historical failures and
private raw rejected/changed suggestions are immutable inputs. Every public candidate
remains `needs_review`; warnings/dispositions are not confidence or approval. Tests assert
input immutability, null vs zero and unrelated-entry controls alongside negative cases.
PASS means every listed observable assertion holds on the tested snapshot; FAIL means any
assertion differs, a limit is bypassed or an unexpected connection is attempted. Import,
fixture and toolchain errors establish neither defect reproduction nor correctness.

## HAR-01 — Entry-scoped literal support

**Owner/module:** VIS-02 `workflow.py`, `menu_context.py`, this spec. Existing approved
behavior: copy only supported fields, never another entry's facts. Current hypothesis:
optional description/ingredients/currency are page-wide; geometry may consult whole-page
support. Revalidate on this snapshot.

**Evidence/association:** name needs literal cited-page evidence; description/ingredients
need this entry's bounded canonical body. Price checks require the same entry. Category
and subcategory are distinct section roles: explicit page headings and established
contiguous continuation remain allowed under existing `apply_sections`; never force
category into a dish-only block. A page currency requires an explicit established scope,
not occurrence in another dish; no new implicit page-currency inheritance is approved.

**Preconditions/limits:** valid schema dishes/pages under existing40-page/100,000-text
limits; saved Engine3 geometry when supplied. No spelling aliases, ingredient inference
or synthesized rectangles. Unknown/ambiguous association abstains with field warning;
raw suggestion/disposition remains private. A valid name can survive optional-field rejection.

**Examples/assertions:** `Soup USD 8.50\nCoffee CAD 4.50\nContains milk`, with Coffee fields
assigned to Soup: Soup description, milk ingredients and CAD must be null, raw values
unchanged/private with cleared dispositions; no USD/milk replacement is inferred. Soup's
own literal fields and Coffee remain unchanged. Separate section/continuation controls
retain explicit `BREAKFAST` and prior heading page; ambiguous/gapped continuation clears.

**Tests/commands:** integration `tests/test_entry_field_support.py`,
`test_item_local_optional_fields`, `test_explicit_section_scope_is_preserved`,
`test_pipeline_optional_fields_keep_private_rejections`; `F(test_entry_field_support.py)`.
PASS iff scoped positives survive, cross-entry fields clear, source/private records remain
exact. FAIL iff same-page occurrence alone supports Soup or legitimate section controls
regress. No new public fields/version; consumer field-policy expansion is owner-gated.

## HAR-02 — Complete entry-scoped price decisions

**Owner/module:** VIS-02 `workflow.py`/`menu_layout.py`/`menu_context.py`. Existing approved
complete numeric-group rule; defect hypothesis: geometry `8.50` gets corroborated by Tea
while Soup canonical text is `8.50 / 12.50`, `8.50 kcal` or `-8.50`.

**Evidence/association:** literal existence, entry membership, numeric completeness,
coherence and ambiguity are separate checks. Same entry boundary applies to text,
ordinary geometry recovery and box-only fallback; other entries cannot corroborate it.
Canonical negative evidence outranks clipped geometry. Exact selected saved boxes only.

**Preconditions:** HAR-01 input limits, unique supported name/entry, bounded valid geometry.
Malformed/competing/exhausted geometry abstains, never falls back to broader page facts.

**Success/abstention/status:** unique complete single price survives including zero;
complete supported options retain literal text and null scalar. Unsupported scalar clears
with warning, raw suggestion retained privately. Incomplete group cannot become one option;
abstention does not delete source or a neighboring valid candidate. Status remains review.

**Examples/assertions:** Soup's geometry contains only `8.50`; Tea independently has valid
`8.50`: Soup must not acquire a scalar for any three canonical negatives. Full supported
`8.50 / 12.50` is literal/null, unique `8.50` and `0.00` survive, Tea unchanged. Both
ordinary recovery and missing-ParsedText fallback must obey this rule. Source bytes/text
and coordinates must not be rewritten to pass.

**Tests/commands:** unit+real graph+pipeline/save/export
`tests/test_price_decisions.py::test_cross_entry_corroboration`,
`test_pipeline_cross_entry_corroboration`, `test_complete_group_and_single_controls`;
`F(test_price_decisions.py)`. PASS iff all negative/positive paths agree through export
and private suggestions retain cleared originals; FAIL iff Tea rescues Soup, an option
is dropped, or private suggestions are promoted. No provider acceptance implied.

## HAR-03 — Text/amount/currency coherence

**Owner/module:** VIS-02 `workflow.py`, existing complete-price intent; explicit user
clarification covers non-slash alternatives. No public version change authorized.

**Evidence/scope:** one entry-scoped decision over literal numeric groups and explicit
currency. No inferred option meaning, printed separator or replacement currency. Currency
must not contradict the chosen literal, even if its code occurs elsewhere on the page.
`$` alone does not identify a unique currency. Conflicting raw values remain private.

**Inputs/limits:** HAR-01 bounds; decimal strings finite/nonnegative, existing schema
limits unchanged. Include `price_text=8.50, amount=12.50` in an entry with both numbers,
slash and `$8.50 or $12.50`, ambiguous inline clusters, malformed/signed/clipped groups,
explicit money plus separately labelled kcal/portion counts, zero and single controls.

**Assertions:** text/amount/currency never contradict; unresolved alternatives yield no
scalar. Full literal may remain when complete and supported, never fabricate a slash or
option labels. Conflicting amount clears rather than overwriting correct text. Explicit
money survives a separate labelled count. Null is distinguishable from zero. USD literal
cannot retain CAD copied from Coffee. Pipeline and exported originals are equal. Warnings
identify withheld fields; private raw fields/dispositions unchanged. Neighbor controls survive.

**Tests/commands:** `tests/test_price_decisions.py::test_price_field_coherence`,
`test_non_slash_alternatives_and_numeric_clusters`, `test_money_unit_and_zero_controls`,
`test_pipeline_price_coherence`; `F(test_price_decisions.py)`. Level unit/integration.
PASS iff all assertions hold with unchanged source and no invented labels/currency;
FAIL on any contradictory scalar/currency, subset promotion or money/count false rejection.

## HAR-04 — Deterministic grounding work bounds

**Owner/module:** VIS-02 `menu_context.py` and real `grounded_draft` caller. Existing
bounded-processing requirement; hypothesis: repeated-alternation heading regex has
exponential backtracking on `addon` repetitions plus nonmatching suffix.

**Evidence/scope:** label grammar must preserve current valid section boundaries while
rejecting nonlabels. Use disjoint numeric/label scanning or bounded deterministic work,
not an enlarged timeout or repeated ambiguous alternatives. No new framework.

**Limits before implementation:** page text ≤100,000 code points, names bounded by current
schema; per-label parsing scans at most a constant number of passes across its characters
and must not build overlapping repeated alternatives. Existing title paths remain ≤8
regions/10,000 checks, geometry ≤1,000 regions. Exhaustion must abstain, not widen scope.
Tests instrument actual classification work where practical, assert ≤linear budget, and
use a5s subprocess timeout solely as hang protection. Boundary sizes0/1/128/10,000 and
near100,000 plus long `addon` repetitions and a final nonmatching `!` are required.

**Assertions:** real grounding completes under bounded subprocess protection; classifier
operation/input counter never exceeds documented linear budget; >limit input safely
abstains/rejects before expensive matching. Valid `Desserts`, uppercase headings, wrapped
names and currency labels retain current decisions. No source truncation/evidence rewrite.

**Tests/commands:** unit+integration `tests/test_grounding_budget.py::test_addon_grounding_is_bounded`,
`test_label_work_budget_and_boundaries`, `test_exhausted_search_abstains`,
`test_valid_section_labels_unchanged`; `F(test_grounding_budget.py)`.
PASS iff deterministic bound and semantic controls hold; FAIL on timeout or budget excess.
This is local complexity evidence, not a universal hosted CPU/latency guarantee.

## HAR-05 — Truthful acquisition/model/coverage status

**Owner/module:** VIS-02 `run_pipeline.py::saved_page_text` and save/export callers.
Existing complete/partial/failed distinction; hypothesis: ready-with-error/skipped saved
segments lose errors and allow complete extraction after other pages succeed.

**Evidence/scope:** saved source snapshot must match exact bytes and every page; segment
state/error is acquisition evidence independent of model success. Historical model errors
being explicitly rerun are history, not necessarily current failures. Never erase failed/
not-attempted recovery histories or copy old drafts into a new attempt.

**Preconditions:** saved reports ≤32MB, source≤existing input cap, ≤40 unique pages and
≤100,000 text, new create-only run directory. Valid saved failed/skipped/ready-with-error
reports; selected model recovery1–4 pages/requests under existing cap.

**Assertions/examples:** ready Soup plus failed/skipped/error-bearing page remains
`incomplete` after successful model extraction. Every current acquisition error and segment
status survives pages.json/extraction.json/export; zero valid drafts plus current errors
is failed. All-ready/error-free input is complete. Historical failed model batches/errors
are retained separately as superseded history, not falsely made current acquisition errors.
Explicit targeted rerun retains prior status/errors/batches and failed/not-attempted metadata;
unselected pages remain incomplete. No source/draft/ID rewriting in export.

**Tests/commands:** integration `tests/test_coverage_status.py::test_saved_coverage_through_save_and_export`,
`test_rerun_keeps_superseded_model_history`, `test_complete_saved_input_control`;
`F(test_coverage_status.py)`, surrounding `F(test_targeted_model_recovery.py)` and
`F(test_recover_pages.py)`. PASS iff status/errors/history agree at every saved boundary;
FAIL if successful unrelated extraction erases coverage or historical/current errors conflate.

## HAR-06 — Exact evidence provenance and compatible deterministic export

**Owner/module:** RES-01.1 `schemas.py`/`review_candidates.py`, shared contracts TS.
Approved existing versions1/2 and2/3; exporter is not factual repair. Python validates
box provenance; TypeScript only preserves opaque metadata, not box correctness.

**Evidence/scope/limits:** exact ordered Unicode code-point spans join ready/error-free
segments; source snapshot hash/size match; complete unique draft-index/ID joins. Box records
must join exact saved Engine3 index/literal/typed fractional coordinates/page/dimensions
and candidate mapping. Existing report/IDs never reordered, mutated or regenerated by export.

**Assertions:** valid legacy/current fixtures round-trip without meaning changes, decimal
strings/zero/null and non-BMP spans exact; mixed versions fail; candidate reordering retains
identity by ID. Missing/duplicate/orphan joins, reversed/out-of-range/mismatching spans and
failed/skipped refs reject before output. Tampered box literal/coordinate/index/mapping
reject in Python save/export/reload. TS preserves valid box metadata but does not claim to
validate tampering there. Inputs unchanged; output create-only (second write fails/no overwrite).

**Tests/commands:** shared/differential `tests/test_export_contract.py::test_version_unicode_identity_roundtrip`,
`test_invalid_evidence_matrix`, `test_box_provenance_validating_boundary`,
`test_immutability_and_create_only`; `F(test_export_contract.py)`; TS
`packages/contracts/src/review-candidates.test.ts` differential additions, command `T`.
Surrounding `F(test_box_evidence.py)`/`F(test_review_candidates.py)`.
PASS iff languages agree at shared structural boundary and Python rejects exact box
provenance mutations. FAIL on silent drop/repair, input mutation or opaque preservation
labelled validation. Actual consumer persistence/source delivery is CONS-01, BLOCKED.

## HAR-07 — Operational/quality acceptance separation

**Owner/module:** producer offline behavior, external orchestration/review owners per
[release contract](extraction-acceptance.md), stable IDs OPS-01/02/03, HOST-01, CONS-01,
QUAL-01. No policy/default change in this hardening slice.

**Assertions:** failures never become success ACKs, persistence failure cannot return
success, recovery request caps/not-attempted selections remain enforced. Frozen replay
references unchanged and every changed asserted field source-justified. Unsafe synthetic
cases: zero incorrect assertions; all positive controls unchanged. Report correct entries,
complete groups/cells, incorrect/unknown/missing fields, evidence validity, acquisition/model
failures, runtime and actual calls separately. Synthetic/replay/provider/hosted/human
results are distinct. No whole-menu threshold invented. Acceptance commands, limits,
examples and owner-gated procedures are defined in that linked contract before tests.

**Verification:** offline service/recovery/host regression commands there; actual consumer,
hosted resources/upload-to-ACK and independent held-out provider quality remain BLOCKED/
NOT RUN pending owner approval/budget. PASS is scoped offline assertions only, never release.

## HAR-08 — Self-contained network-safe harness

**Owner/module:** processing test tooling only. Existing suite has an external printed
guard-marker assertion; no external guard/private file may be required. No instrumentation
inside production behavior. Frozen dependencies still required; no secrets/provider env.

**Evidence/scope:** repo-owned runner installs socket audit before tests; subprocess Python
inherits guard via explicit test environment/PYTHONPATH. Deliberate connect to synthetic
external address is blocked before connection; audit attempt count is observable. Parent
must fail on an unexpected attempted connection even if a test catches the exception.
Dedicated negative controls account for their deliberate probes separately.

**Assertions:** documented full command works with no private external files. CLI subprocess
asserts its functional output without relying on an unrelated printed guard marker. Fresh
Python subprocess deliberately attempts connect and reports blocked; guard works inherited,
not just monkeypatched in parent. Ordinary suite attempts=0. No actual provider/network
connection; no test weakening/removal. Boundary: child can import production normally and
network-using fake transports retain same behavior except blocked external I/O.

**Tests/commands:** `tests/test_offline_harness.py::test_child_connection_is_blocked`,
`test_suite_runner_is_self_contained`, existing overlay CLI control;
`F(test_offline_harness.py)` then guarded full command. Level integration/harness.
PASS iff subprocess protection and zero-unexpected-attempt audit hold; FAIL if private
paths/marker needed, child connects, guard absent or production behavior instrumented.

## Initial requirement-to-test matrix (before code)

| Requirement | Planned primary tests | Initial result |
|---|---|---|
| HAR-01 | test_entry_field_support.py (3 named controls above) | NOT WRITTEN / NOT RUN |
| HAR-02 | test_price_decisions.py cross-entry graph/pipeline/positive controls | NOT WRITTEN / NOT RUN |
| HAR-03 | test_price_decisions.py coherence/alternatives/money/zero/pipeline | NOT WRITTEN / NOT RUN |
| HAR-04 | test_grounding_budget.py real path/work counts/exhaustion/labels | NOT WRITTEN / NOT RUN |
| HAR-05 | test_coverage_status.py saved report/save/export/history | NOT WRITTEN / NOT RUN |
| HAR-06 | test_export_contract.py + shared TS differential controls | NOT WRITTEN / NOT RUN |
| HAR-07 | OPS/QUAL/HOST/CONS acceptance contract | NOT RUN / external gates BLOCKED |
| HAR-08 | test_offline_harness.py + guarded runner | NOT WRITTEN / NOT RUN |

Existing approved invariants above are distinct from new implementation proposals
(entry decision reuse, linear label scanner, repo-local guard). Unresolved owner decisions:
new page-currency semantics, consumer box rendering/delivery, retention policy, total
end-to-end deadline/lease policy, held-out dataset approval/provider budget/quality thresholds.
None is silently adopted. Implementation verification is not release acceptance.
