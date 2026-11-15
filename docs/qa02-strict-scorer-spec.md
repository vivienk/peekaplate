# QA-02 strict menu scoring handoff specification

Status: implementation specification prepared 2026-11-14 in response to the source/scorer handoff request. This is **not** Vivien's threshold approval, a frozen real-menu reference or permission to make provider calls. Existing [QUAL-01](extraction-acceptance.md#qual-01--frozen-references-and-strict-held-out-evaluation), [QA-02](https://app.clickup.com/t/86bcng0d7) and [VIS-04](https://app.clickup.com/t/86bd1amm5) remain authoritative acceptance sources.

## Problem statement

The historical fuzzy scorer cannot establish strict menu accuracy. Real-menu references are not yet independently frozen. Reviewers need exact source/page/split choices, reproducible scoring code and explicit treatment of whole price text, null/zero, duplicate occurrences and failures before fresh predictions.

## Solution and public seam

Provide one offline CLI consuming PR169's unchanged frozen manifest/reference format and a private, hash-bound run/association ledger. It validates actual extraction reports and candidate exports through existing schemas/exporter, produces a private create-only expected-versus-actual receipt and never calls providers, edits references, approves a dish or publishes content. Tests cross this CLI/public evaluation interface, not implementation-private helpers.

The concrete command and scorer commit are published after implementation and verification, not invented in advance. Source/reference review precedes predictions; human occurrence associations necessarily follow predictions under the fixed procedure below. They are distinct approvals.

## User stories

1. As a reference reviewer, I can identify every selected source page, occurrence, split and immutable byte hash before predictions.
2. As an evaluator, I reuse the existing reviewed-reference gate without modifying Sai's v1 schema or Uneeza's event datasets.
3. As an independent output reviewer, I bind occurrence associations to actual report/export bytes without rewriting predictions or matching to maximize scores.
4. As a reviewer, I see every reference occurrence, emitted candidate, duplicate, unknown and missing/failed page in the denominator and ledger.
5. As a release owner, I distinguish computed field counts from unmeasured ingredient/geometry/safety lanes and separately approved acceptance thresholds.
6. As an integration owner, I reuse existing backend acceptance and verify fresh payload/evidence mapping in the real coordinated UI run, without a parallel approval system.

## Implementation decisions

- Reuse PR169's manifest, reference models, bounded verified-byte reader and `require_reviewed` validator. Do not alter its extra-forbidden reference or production candidate schemas.
- A run ledger binds the exact manifest SHA-256 and every case exactly once. Each case has either actual report/export paths and SHA-256 or an explicit unavailable disposition/reason. No absent case is silently dropped. Keep one ledger/receipt per experimental condition; report the condition as declared, alongside recorded model/configuration provenance rather than claiming it proves which path ran.
- A captured report must identify the manifest source hash and re-export to the supplied candidate export exactly after schema parsing. Hash and parse the same bounded snapshots. Preserve all candidate IDs/originals, report diagnostics, segments, configuration and review-only state. Arbitrary export injection, mismatched snapshots, malformed inputs and source/reference tampering fail closed, without a successful result.
- Associations cite actual candidate ID, reference entry ID or explicit unassociated state, and an actual evidence-span index for associated candidates. Record independent output-review identity and decision reference as declarations, not authenticated proof. Enumerate candidates independently of association rows; missing rows are unresolved extras. Reject unknown/duplicate candidate row IDs and nonexistent reference IDs. One candidate cannot satisfy multiple entries.
- The first association in original candidate order consumes an occurrence; later associations are duplicates/extras even if their field values would score better. Do not select a best duplicate. An associated evidence span must point to the reference page; wrong-page links score no success. Source/section/location semantic association remains the independent human reviewer's responsibility. A byte-valid span or vision box is not proof of correct reading.
- Names allow only `lower()` and whitespace folding. Do not use `casefold()` expansions, punctuation/accent/trademark removal, spelling/alias repair, semantic matching or score-maximizing assignment. Dish denominators exclude reference qualifier rows; qualifier links and unsupported dish assertions remain visible separately and do not satisfy a dish occurrence.
- For price coverage, compare the **entire reviewed literal `price_text`** with only the same case/whitespace equivalence; compare nullable scalar amounts by finite Decimal value and nullable currency exactly. All three must match for a known printed group's emitted fields to succeed. Option subsets, changed order, missing qualifiers, extra text, wrong currency or an invented scalar for a multi-price group fail the whole comparison. Distinguish absent/null, valid zero and asserted values explicitly. Zero scalar and null scalar are never equivalent. Unknown reference prices are not known-price denominators; report correct abstention versus unsupported assertions separately.
- The producer has no structured actual option array. Therefore this measures complete **emitted price fields/literal group preservation**, not independent semantic option parsing. Never fabricate actual `ordered_price_options` from the reference or silently claim that structured label/amount association was measured. Price labels in external headings and representational differences require a source-reviewed mapping decision before any group-accuracy acceptance.
- Every reference occurrence contributes regardless of missing/failed/skipped page or unavailable capture. Only valid page/association output can contribute a correct count. Enumerate every source page, including excluded pages; keep segment status/error and whole report status/errors. Exclusions are frozen source-review declarations, not permission to omit failed readable pages. Incomplete reports never become complete acceptance.
- Provide per-case/page/split/input-kind counts and micro-aggregates from summed counts, not averaged percentages. Names: correct/eligible reference occurrences and correct/all asserted candidates, with missing, wrong, duplicate, extra and unresolved counts. Known price fields: complete matches/all eligible printed groups, with missing/unknown and wrong counts. Zero denominators produce null/N/A and an explanation, never 100%.
- Record manifest/run/report/export hashes, source/reference versions, original expected values, actual values, association dispositions, page dispositions and declared producer/scorer/run identities. Scorer identity includes its implementation file hash; invocation pins the public commit externally so an unverified caller-supplied revision does not authenticate code.
- Create output once at mode0600; existing outputs are never overwritten. CLI failures are nonzero and sanitized: no raw annotation, credential, path or provider exception in stdout/stderr. Successful stdout contains only bounded counts/status, with quality/release acceptance explicitly not established.

## Lanes not represented by the unchanged v1 reference

Ingredient fact populations, source-verified geometry/transforms, confidence/illegibility judgments, unsupported allergen/food assertions and recovery/hosted corrections require separately frozen source annotations and independent expected-versus-actual receipts tied to the same case/entry/output hashes. Report these as **NOT MEASURED / separate evidence required**, not as passed or as a completed QUAL-01 scorer. Null actual ingredients remain a known coverage gap, not permission to infer recipes or remove printed ingredients from eligibility. Do not change ingestion, exports or review UI to conceal these limits.

## Acceptance tests defined before code

Synthetic-only public-interface tests must demonstrate:

1. Case/whitespace equivalence matches; trademark, punctuation, accent, spelling and casefold-expansion changes do not match.
2. A full two-option price literal with null scalar succeeds; subset, reordered options/qualifiers, currency mismatch and invented scalar fail; decimal-equivalent known-zero representations remain distinct from null.
3. Unknown/omitted price is abstention, not a correct known price; unsupported assertions remain counted. Empty denominators yield null/N/A.
4. Repeated names remain distinct page/occurrence identities. A wrong first prediction and a correct duplicate cannot improve recall/price success; missing/unassociated candidates remain in precision/extras.
5. Wrong-page association, missing/failed/skipped pages, empty/failed/unavailable captures and report errors stay visible; all eligible references remain in denominators. Qualifier rows do not become independent dishes.
6. Manifest/reference/source and report/export/association hash substitution, candidate mismatch, duplicate rows and unknown identities fail closed. Pending references or association review cannot produce an accepted score.
7. A real `python -m` CLI invocation writes a private create-only receipt and emits sanitized failures without leaking source content. No network/provider calls occur under the existing socket guard.
8. Summed case/page counters reproduce micro-counts; no averaging of per-page percentages, no synthetic-versus-real or development-versus-holdout pooling disguised as held-out quality.

## Delivery slices and blocking edges

1. **Source proposal and reference handoff:** publish exact originals/pages/hashes/history and proposed development/candidate-heldout split; independently verifiable source metadata, no fabricated answers. Ready now; human review/freeze remains external.
2. **Strict field scorer and reproducible handoff:** implement the interface above, test it offline, pin a public commit/command and request review. Ready now; reuses PR169, so merge depends on that reference contract being approved/landed.
3. **Fresh evaluated extraction:** blocked by both handoffs, source/reference/scoring approval, Vivien thresholds and an explicit bounded source/call/retry authorization. No calls in the preparation slices.
4. **Coordinated hosted mapping:** Sai owns deployed auth/workspace and authorized test venue; Ehab156, Nifemi171 and Jeffin172 own live connections. Mohammad verifies actual fresh producer/evidence mapping once their slot is ready. Existing backend acceptance is reused; UI integration has its own receipts.

## Out of scope

No fuzzy scorer replacement for historical experiments, inferred gold labels, model-assisted reference reading, automatic publication, new auth/frontend/review flows, production schema changes, deployment, queue activation, provider calls or self-approved acceptance. Public repository contains synthetic tests and metadata/protocol only; real originals, labels and outputs remain private.
