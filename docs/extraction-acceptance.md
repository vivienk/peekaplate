---
id: vis02-release-acceptance
type: module-design
status: draft
references: [vis02-res01-hardening]
---

# Extraction operational, quality and consumer acceptance

## Authority, scope and evidence states

This is the **pre-implementation acceptance contract**, not a release approval.
It covers VIS-02/RES-01 producer operations and the external VIS-01/RES consumers.
Only this new document is authorized in this task: no providers, tests, production
code, credentials, deployments, migrations, Queue activation or existing documents
are changed. Proposed tests below are work for a later assignment.

Read with [processing-v3](processing-v3.md), [review candidates](review-candidates.md),
[menu infrastructure](menu-ingestion-infrastructure.md), [context](CONTEXT.md), and
accepted [ADR 0005](adr/0005-tenancy-and-privacy.md). ADR 0015 is **proposed**, not
an accepted override. The referenced `vis02-res01-hardening` spec ID is supplied by
the task; it was not resolvable in the worker's spec index. Do not invent its text.

Implementation observations are from the canonical working tree on October 29,
2026, HEAD `7c961d83f031d7ea5b905ffa5843bb9eacc3888b`, **with existing uncommitted
producer/host follow-up work**. HEAD alone does not identify those bytes. Release
owners must pin the final diff and fixture hashes before using this contract.
The live main/PR45 observations in the infrastructure document are historical,
not proof that this working tree is deployed. In particular its later PR45
720-second transport/15-minute lease observation supersedes its older 600-second
observation; neither is a current consumer-code assertion here.

For every requirement below:

- **Current** describes inspected code/test assertions, not an executed acceptance.
- **Proposed** is a release obligation pending owner agreement/implementation.
- **Unresolved** is a blocking decision/evidence dependency, not permission to pick
  a convenient default. Named owners follow existing handoffs; they have not signed
  this draft by being named.
- **PASS** requires the specified assertions and retained, sanitized exact-revision
  evidence. **FAIL** means a violated assertion. **NOT RUN** means no execution;
  **BLOCKED** means a prerequisite is absent. Skips, cached replays, mocks and
  schema parsing never count as external acceptance.

All six gates remain open. External quality, consumer and hosted gates are
**BLOCKED / NOT RUN**. No overall duration SLA, whole-menu accuracy threshold,
retention period or tolerated production error rate is invented here.

## Inspected budgets and their limits

All sizes below are decimal bytes, not MiB. These are code limits, not a claim
that every maximum-size input completes or fits host memory/disk.

| Boundary and source | Current value | Interpretation / unresolved boundary |
| --- | --- | --- |
| `service.py` request / `sources.py` source | 8,192 / 12,000,000 bytes | Streamed request/source guards; nonempty source and exact advertised length required. |
| `service.read_source` | `httpx.stream(timeout=20, follow_redirects=False)` | HTTPX phase/inactivity timeout, **not a 20-second whole-transfer elapsed deadline**. No explicit monotonic total or disconnect cancellation contract. |
| `service.JOB_TIMEOUT_SECONDS` | 700 seconds | `subprocess.run(timeout=...)` around the child only, after source download. Does not cover host readiness, source transfer or parent serialization/archive. |
| `service.py` report / bundle | 24,000,000 / 32,000,000 bytes | Service checks `json.dumps(...).encode('utf-8')`; actual JSONResponse encoding can differ. Host also checks wire/stored bytes. |
| `run_extraction` sidecar reads | suggestions 8,000,000; timings 1,000,000; report 24,000,000 | `read_result` reads limit+1. Individual file limits are enforced on the real child-file path; injected test runners do not establish these file limits. All individual maxima together do not imply a valid 32 MB bundle. |
| `backend/src/extraction-host.ts` | upstream bundle 32,000,000; stored bundle including scope 32,000,000; returned report including reference 24,000,000 | Added scope/reference consumes headroom. Size checks precede `put`; an upstream bundle at its limit may fail after scope is added. |
| Host readiness | 30,000 ms loop; probe abort 1,000 ms; delay 500 ms | Loop deadline is not proof of a strict 30,000 ms end-to-end cutoff: final probe/delay and scheduling can extend it. POST forwarded once; readiness alone may retry. |
| Host inactivity | 60,000 ms | Container inactivity control, not extraction timeout or lease renewal. Fixed instance name, one service-process lock; not distributed deduplication. |
| `extraction-capability.ts` | 15-minute grant | Mint at durable claim/attempt, bound to tenant/job/hash. Not a browser token; source-signing secret never enters Python. |
| `run_pipeline.py` / `workflow.py` | LLM deadline default 90 s, valid >0 through 300 s; batch pages 1–10; concurrency 1 or 2 | Service explicitly uses one-page batches, concurrency 2, `ocr_image`, `--no-llm-cache`. CLI defaults are 10 pages/concurrency 1. SDK timeout 120 s, `max_retries=0`; graph cancellation is separate. |
| `ocr_space.py` | timeout default 90 s, valid >0 through 120 s; ordinary `max_attempts=2` | Ordinary acquisition can retry; this must not be described as recovery's single-attempt policy. |
| `recover_pages.py`, `run_pipeline.py` selection | explicit integer request cap 1–4 and 1–4 selected pages | OCR recovery one transport attempt/page, uncached, first failure stops; model cap checks actual planned batches before invocation. A model cap is not an overall elapsed or billing guarantee. |
| `vision.py`, `workflow.py`, `pdf.py` | 8,000,000/image; 16,000,000/model request; 40 PDF pages; 6,000,000 render pixels | Actual context-image bytes count; no silent downsampling/retry to rescue a failed batch. |
| Temporary infrastructure pull consumer (infrastructure doc only) | source retries 3 after initial; retry delay 10 s; visibility 30 s; retention 86,400 s; DLQ retries 100 | Verification settings, **not approved feature-consumer settings**. Paused messages still expire. No 700-second extraction fit follows from 30-second visibility. |
| PR45 read-only observation (infrastructure doc only) | transport 720 s; lease 15 minutes | Not inspected consumer implementation in this task; must be reverified and reconciled with full HOST-01 budget. |

## OPS-01 — Transfer elapsed deadline, cancellation and cleanup

**Owner:** Mohammad (Python); Jeffin (host/cancellation boundary); Teeyansh
(caller/claim). **Current:** fixed authenticated HTTPS source, no redirects,
length/hash/signature checks, HTTPX timeout 20, one local slot, private temporary
source and killable 700-second child. `process` maps source-reader exceptions to
sanitized 502; child `TimeoutExpired` maps to 504. A valid failed report can return
HTTP 200: transport success is not extraction success. `finally` releases the slot
when processing unwinds. There is no explicit whole-transfer elapsed deadline or
client-disconnect-to-worker/child termination path in `service.py`.

**Proposed:** enforce an approved monotonic elapsed source-transfer budget
`B_transfer`, encompassing opening/headers/all chunks; do not reset it per chunk.
Define caller cancellation propagation across host, Python thread and child. On
expiry/cancellation close response resources, terminate/reap any owned child,
remove temporary source/results and release capacity only once that owned work
has ended. No retry or successful report/archive may be manufactured. Never
release capacity while detached work still consumes the single extraction slot.

**Unresolved:** `B_transfer`, cancellation grace/kill escalation, HTTP status for
new elapsed-transfer expiry and disconnect audit representation need joint owner
approval. Existing 20-second phase timeout and 700-second child timeout stay as-is
until then. Do not silently recast every 502 as 504. Client disconnect may have no
response channel; record a bounded disposition, not a fictional delivered status.

**Evidence/scope and preconditions:** authenticated matching job/tenant/hash/key,
synthetic bounded PDF/photo; stream fake and child stub offline. Existing evidence:
`test_service.py:ServiceTests.test_source_reader_uses_only_fixed_https_origin_without_redirects`,
`test_source_reader_rejects_redirect_and_inconsistent_or_excessive_bytes`,
`test_timeout_is_distinct_and_slot_reusable`,
`test_temporary_source_is_removed_after_child_timeout`. These cover phase options,
resource exit and child timeout, not slow-drip elapsed enforcement or disconnects.

**Success/failure/history/compatibility:** exact source bytes only reach the
runner after verification; 401/403/409/413/422 retain their meanings, 429 retains
`Retry-After: 10`, and existing 502/504 remain distinct. No exception/path/secret
leaks. Preserve existing failed/incomplete reports if actually finalized, but do
not synthesize final artifacts on cancellation. Missing final artifacts stay an
explicit failure. No request/review schema or automatic retry change is authorized.
A durable attempt/disposition history belongs to the caller, not a new Python DB.

**Positive / negative / boundary assertions (planned O1–O4):**

- Successful bounded stream returns exactly its declared bytes and closes once.
  On injected `httpx.ReadTimeout` after a chunk, assert HTTP 502 with exactly
  `{"error":"extraction_unavailable"}`, `Cache-Control: no-store`, reader exit,
  runner call count zero, and a subsequent healthy request succeeds.
- A fake drip with individually timely reads but aggregate simulated duration
  greater than 20 s currently returns bytes. Explicitly assert this **gap
  characterization**, not a passing deadline guarantee. Later enforcement needs
  new just-before/at/after `B_transfer` cases once its value/status are agreed.
- Stub child success, nonzero invalid exit and timeout; record `cwd` and input
  path, assert both absent afterward; timeout is passed through at 700, child
  output suppressed, secret-prefixed environment excluded. A stub does not prove
  OS reaping. A tiny real local sleeping Python child with a short **test-only**
  timeout may prove `subprocess.run` reaps; that timeout is not a release budget.
- For malformed source length, zero/exact 12,000,000/12,000,001 and chunk overflow,
  assert reject without runner, with stream context exited. For 700-second child
  expiry use an injected exception, not a real 700-second wait.

**Verification:** Python unit/in-process ASGI, `processing/tests/test_service.py`
and planned `processing/tests/test_operational_contract.py`, O1–O4 below; run C1
and C2. Offline PASS is only these assertions. Gate remains **BLOCKED** until
elapsed/cancel decisions, enforcing implementation and disconnect/child-lifecycle
acceptance exist; those latter cases are **NOT RUN**, not covered by timeout mocks.

## OPS-02 — Create-only archive, payload and error budget

**Owner:** Jeffin (host archive), Mohammad (service artifacts), Teeyansh (job report
and ACK). **Current:** Python negotiates internal bundle version 1; validates
report/source snapshot and sidecar scope, reads final files before temp cleanup.
Host validates transport/scope, adds server-generated attempt scope, hashes exact
stored UTF-8 bytes, conditionally writes a new private key, then returns only the
existing report plus `configuration.private_review_artifact`. R2 `null` collision
or thrown failure gives sanitized 502, never success. Host does not perform the
consumer's database completion or ACK.

**Proposed:** retain this fail-closed ordering in the real deployment. Per-attempt
correctness error budget is **zero false successes**: no missing/corrupt/wrong-scope
artifact, failed conditional write or exceeded payload limit may be reported as
retained success. This is not a numerical provider availability/error-rate SLO.
Archive failure may retry only through the caller's explicitly approved recovery
policy; never bypass retention to make a job appear successful.

**Unresolved:** archive elapsed/write timeout, process memory/disk headroom,
production error-rate/availability target, evidence retention/deletion and access
policy. Do not infer these from byte caps or the local Docker example. The paired
host/container retention extension is not established as deployed by baseline
hosted infrastructure probes.

**Evidence/scope and preconditions:** matched service/signing credentials,
authorized tenant/job/hash, internal header `X-Extraction-Artifact-Bundle: 1`,
real CLI finalized report and both sidecars; private bucket adapter capable of
create-only writes. Existing tests:

- `test_service_artifacts.py:ServiceArtifactTests.test_shared_bundle_survives_actual_service_serialization`,
  `test_negotiation_rejects_missing_or_cross_source_artifacts`,
  `test_failed_result_exit_one_still_retains_the_valid_diagnostics`,
  `test_missing_sidecar_is_not_silently_replaced`.
- `backend/src/extraction-host.test.ts`, exact Vitest names:
  `retains the private bundle before returning only the existing report shape`;
  `uses a new create-only attempt key for each repeat without overwriting history`;
  `does not return success if private R2 retention fails`;
  `refuses conditional-write collisions instead of claiming retention succeeded`;
  `rejects oversized or malformed upstream bundles before private writes`;
  `passes upstream errors through without pretending an artifact was stored`.

**Success/failure/history/compatibility:** key is
`menu-ingestion/review-artifacts/<tenant>/<job>/<server-attempt-UUID>/bundle.json`;
`onlyIf.etagDoesNotMatch='*'`; report ref hash equals SHA-256 of exact stored bytes,
including scope. Repeat attempts have separate keys and do not mutate prior
snapshots. Job-owned `reports/<tenant>/<job>/extraction.json` is separate and not
an immutable review-original store. Suggestions stay private/unvalidated; all
public drafts stay `needs_review`. Preserve `complete`/`incomplete`/`failed`, final
`timings.json`, report source bytes and failed-page history. CLI 0/2 can preserve
reports; exit 1 only with a valid actually failed report; timeout without final
files remains 504. Old unbundled upstream 200 fails host negotiation. No new public
request or RES schema fields, no unauthenticated archive route or new database.

**Positive / negative / boundary assertions (O5–O7 plus existing host tests):**

- Use `read_result` with valid JSON padded to exactly limit and limit+1 bytes,
  parameterized for 24,000,000, 8,000,000 and 1,000,000. Exact limit accepted;
  +1 raises ValueError. Use sequential allocations/temporary files, not paid calls.
- Construct matching synthetic bundles and pad a permitted diagnostic field to
  service's measured `len(json.dumps(bundle).encode('utf-8'))` exactly 32,000,000
  and +1. Assert negotiated 200 then 502 `bundle_too_large`; likewise isolate
  report 24,000,000/+1 => 200/502 `report_too_large` with bundle negotiation off.
  Test multibyte/escaped Unicode to count bytes, not characters. These service
  cases do not imply host acceptance after scope/reference growth.
- Missing/invalid JSON sidecar, wrong source/mode/status, non-`unvalidated`
  suggestion and unsupported internal version fail closed. Request/body with
  added public authority/mode fields rejects; private contents do not appear in
  public response. Host positive assertions check exact stored-byte digest and
  put-before-response. Negative assertions check zero writes on preflight errors,
  one failed put/no success on collision/outage, and no put on upstream 429.
- Host existing oversize test checks advertised length 32,000,001 and malformed
  JSON; it does **not** test streamed +1 with absent/misleading length or exact
  post-scope limit. Those host boundary cases and archive hang/cancel behavior
  remain external owner work, not promised by Python-only tests.

**Verification:** unit/file/ASGI C1–C3; O5–O7 are Python-only and need no backend
changes. Existing host tests run unchanged in C3. Local PASS is not live R2
acceptance. Hosted create-only collision, storage outage and archive-before-durable
completion/ACK remain **BLOCKED / NOT RUN** under HOST-01.

## OPS-03 — Explicit recovery budgets and retained failures

**Owner:** Mohammad; Sai approves recovery evidence/budget; Teeyansh owns any
separate Queue retry policy. **Current:** explicit failed-OCR recovery and selected
ready-page model recovery exist locally. Neither is an automatic service fallback.
OCR validates source snapshot/hash/size/kind, complete page coverage, selected
failed Engine3 pages and output collision before constructing the client. It
bypasses cache, uses one HTTP attempt/page, stops on first failure including 429
and records `not_attempted`. Ordinary OCR's two-attempt default is unchanged.
Model recovery requires saved ready text, caps actual image-aware planned batches
before model invocation, does not merge old drafts/IDs, and retains full coverage.

**Proposed:** preserve explicit 1–4 request/page controls and fail-before-spend
preflight. Count OCR **transport attempts**, not just selected pages; distinguish
model planned batches, actual calls and cache hits. No quota polling, cap reset,
model fallback or automatic recovery of the remaining pages. A later operator
attempt requires a new approved budget and a fresh create-only output.

**Unresolved:** authorized real recovery budget/selected cases, any Queue recovery
policy, and elapsed hosted reliability. No dollar budget or provider reset time is
inferred. `uv --offline` alone does not prevent paid requests.

**Evidence/scope/preconditions:** exact saved source/report and fresh private output;
OCR pages genuinely failed/non-native, or model selection all ready/error-free;
explicit nonboolean integer cap, original page indices, unchanged selected input
mode. Existing `RecoveryTests` in `test_recover_pages.py`:
`test_success_merges_and_preserves_hash_failure_history_and_permissions`,
`test_first_failure_stops_without_retry_and_preserves_unattempted`,
`test_invalid_selection_and_existing_output_precede_client_and_output`,
`test_missing_key_counts_zero_requests_and_stops`. Existing
`TargetedModelRecoveryTests` in `test_targeted_model_recovery.py`:
`test_budget_overflow_rejects_before_model_or_ocr_calls`,
`test_only_selected_pages_are_sent_without_mutating_or_merging_prior_results`,
`test_model_failure_is_one_attempt_and_output_remains_explicitly_failed`.

**Success/abstention/failure/history/compatibility:** usable fresh OCR success alone
repairs current selected errors; manifest keeps previous failures, input hash,
request count, failed/not-attempted outcomes. Other failed/skipped pages remain,
so partial coverage cannot become `complete`. No copied old candidates/capture
requests or stale `candidate_box_evidence`. Model selection success remains
incomplete when pages were omitted; failure stays failed with no invented drafts.
Directory/files stay 0700/0600 and create-only. No shared request/review schema,
service default, legacy OCR cache/default retry, database or publication changes.

**Positive / negative / boundary assertions (O8–O9):**

- Generate four blank synthetic PDF pages; derive a saved failed Engine3 report
  using a forbidden/mock acquisition provider. For caps/selections 1 and 4, mock
  OCR transport success and assert exactly 1/4 opens, `requests_attempted` 1/4,
  all original coverage retained, source/report input bytes unchanged. With cap
  0/5/True or five selected pages assert error before client/transport and no new
  output. With first 429 assert one open, zero sleeps, later `not_attempted`.
- Generate four ready synthetic native pages; inject recording LLM, no OCR/cache.
  Select four pages, `batch_pages=1`, cap 4 => four model calls, four planned
  batches; cap 3 => zero calls and ExtractionError. Cap 5/True rejects. Repeat
  selected subset with first model failure: no retry/old-candidate merge, previous
  errors/batches retained and remaining source coverage explicit. Do not claim
  model recovery stops all other dispatched batches on first failure: that
  stop-on-first rule is OCR-specific.

**Verification:** Python unit/integration with fake transport/LLM, C1/C2 and O8–O9;
PASS requires counts, dispositions, original-byte immutability and permissions,
not merely exit 0. Fresh-provider recovery acceptance **BLOCKED / NOT RUN**.

## QUAL-01 — Frozen references and strict held-out evaluation

**Owner:** Mohammad (replay/scoring); Sai (independent reference validation);
Vivien (PM acceptance and thresholds). **Current:** saved-response/synthetic
replays establish selected provenance/serialization behavior, not held-out quality.
The 14-row reference includes qualifier rows; the 31-group reference and eight
later additions (39 selected groups total) are development-selected evidence.
The reported 8→9, 4→7 and 5→8 correct complete-group counts are separate
populations, not whole-menu accuracy. Two image-only exports intentionally contain
no grounded candidates. OCR/model agreement can share a wrong name/reading.

**Proposed:** before another evaluation, freeze private source-image/page hashes,
reference bytes/hash/version, literal entry occurrence/page/section, complete
printed price groups, scalar/null/known-zero truth, semantic roles/qualifiers,
annotation rules, split membership and exclusions. Independent reviewer confirms
source readings **before** seeing evaluated predictions. Keep development,
selected supplemental and genuinely untouched held-out sources separate. A
previously inspected source cannot be relabelled held-out; a leaked holdout is
retired/versioned, not silently rewritten. Pin producer head/diff, saved-response
hashes or approved acquisition configuration, cache state and scorer version.

**Unresolved:** representative held-out population, source rights/access,
independent labels, scalar/name/role/whole-menu thresholds, runtime/error ceilings
and Sai/Vivien sign-off. **No overall accuracy threshold is set.** Until agreed
before scoring, a score cannot close this gate. Fresh provider evidence needs
separate authorization; frozen-response evaluation adds no new provider evidence.

**Evidence/scope/preconditions:** references and raw inputs remain private/out of
Git. Freeze exact bytes; never normalize stored evidence. For strict scoring only,
case and whitespace equivalence is allowed; aliases, punctuation/trademark edits,
spelling repair and semantic substitutions are not. Match one reference occurrence
at most once using page/section/entry identity, not name alone. Duplicate
predictions cannot improve recall. A complete price group must retain every
ordered amount/option; a correct subset/scalar is not group success. Unknown,
missing-name, partial group and wrong assertion remain separate outcomes.
Known zero is not unknown; qualifier/role rows are not independent dishes.
Report counts/denominators for correct complete groups, wrong assertions, unknown
prices, missing names, extra/duplicate predictions and source/acquisition failures,
by split/mode/page; semantic-role errors separately. Never count abstentions or
failed/unprocessed pages as correct, or remove them from the reference denominator.
Historical alias/punctuation scores may be reported separately, not substituted.

**Success/abstention/failure/history/compatibility:** a reproducible strict ledger
with immutable reference/input hashes and all exclusions/failures is necessary;
owner-approved thresholds and independent/PM acceptance are additionally required.
False claims fail even if boxes/spans join correctly. Retain prior reference
versions, raw predictions, nulls, warnings and failure counts. Do not fix labels
post hoc to favor the new implementation, mutate original fields/IDs, turn image
suggestions into facts or approve/publish any dish by passing evaluation.

**Positive / negative / boundary assertions (O10–O11):** a small **test-local**
scorer/manifest validator in the planned test file can exercise this protocol
without claiming a production evaluator exists. Assert case/whitespace equality;
`Soup™` versus `Soup`, spelling alias and punctuation changes do not match;
`8.50 / 12.50` versus `8.50` is partial/not correct; zero versus null differs;
duplicate predictions consume a reference once; failed/omitted pages stay in the
denominator. Manifest accepts synthetic/development labels, rejects overlapping
held-out source hashes, rejects one-byte reference tampering and rejects promoting
inspected/supplemental cases to held-out. Use invented synthetic rows, never private
menus. Passing these tests validates **protocol controls only**, not model quality.

Existing `ReviewCandidateTests.test_v2_fields`,
`test_shared_examples_match_export_and_keep_three_distinct_cases` and
`PipelineTimingTests.test_partial_price_groups_abstain_through_export` support
representation/abstention, not quality scoring or held-out evaluation.

**Verification:** offline unit/protocol C1/C2/C4; actual private held-out evaluation
and independent review **BLOCKED / NOT RUN**. No accepted evaluator file/test name
or command exists in the inspected repository for that external gate. Sai and
Mohammad must supply the exact private evaluator command, versioned manifest,
scorer tests and sanitized result ledger; Vivien must approve thresholds before
execution. Inventing an executable command or declaring synthetic PASS would be
false evidence.

## CONS-01 — Actual consumer save/reload and source authorization

**Owner:** Teeyansh (VIS-01 adaptation/job identity), Marwan (RES-01.2 API/store and
source authority), Nifemi (RES-01.3 rendering), Jeffin (integration); Sai reviews.
**Current:** Python export/reload and shared TypeScript schema tests preserve
producer shape. TypeScript accepts the metadata envelope but does not independently
validate OCR-box joins. This checkout has no accepted actual review consumer
save/reload/source-delivery evidence. PR45 adapted-draft fixtures are not proof of
consuming the actual producer review envelope.

**Proposed:** feed the actual `ReviewCandidateResult` export through the consumer's
real API/storage and UI, save a correction, reload in a new request/session and
render original evidence plus correction separately. Map immutable
`(extraction_id,candidate_id)` to tenant-authorized job/report/attempt server-side;
never equate extraction ID with job ID or candidate ID with draft index/dish UUID.
Authorization must be checked on every report, source/page and correction request,
including retries and changed/revoked membership. A private key/hash/location is
not an access grant or browser URL.

**Unresolved:** exact consumer revision, endpoints, migrations, test file/case
names and executable integration command; authorized source/page asset resolution
and reviewer retention/deletion policy. Rendering local `path` values or exposing
a general file/bucket endpoint is not an acceptable implementation shortcut.

**Evidence/scope/preconditions:** paired schema1/pipeline2 and schema2/pipeline3
fixtures, actual producer box fixture, source snapshot held privately by hash,
ready/failed/skipped pages, two real synthetic tenants and authorized actors,
restricted runtime roles, consumer migrations and isolated store. Consumer owns
server authorization; Python HTTP service secret/grants are not reviewer login.

**Success/abstention/failure/history/compatibility — exact assertions:**

- Save/reload preserves IDs across sorting/renaming and preserves original fields,
  hierarchy/heading page, ordered `price_text`, scalar null for options, known
  `"0.00"`, currency null, warnings, errors and `needs_review`. Unknown remains
  unknown. Corrections have separate actor/revision history and do not overwrite
  the source original, private raw suggestion or prior attempt.
- Retain fractional `candidate_box_evidence` coordinates, original saved-region
  indices/literals, source/page/hash and Unicode code-point spans. Resolve the
  exact cited ready source region, not a recomputed index after sorting.
  Ambiguous/absent boxes render page/text fallback; never invent dish rectangles.
  A preceding category heading page remains viewable and distinguishable.
- Positive: same authorized tenant may view original/page and its own persisted
  correction after reload, with zero source/original-byte change. Negative:
  outsider/cross-tenant/forged job-attempt/hash/missing or expired identity cannot
  read source/report or save corrections; assert no unauthorized row or bytes
  returned and no write. Use the consumer's agreed 401/403/404 disclosure policy;
  its exact denial status is unresolved, not inferred from Python's 403.
- Boundary: duplicate/reordered names on different pages/sections never share
  identity/corrections; failed/skipped segments cannot supply facts. Mixed schema
  pairs, orphan box links, tampered literals/coordinates and invalid spans reject
  without a partial successful save. Empty/failed/image-only exports do not turn
  into invented candidates. Retain legacy no-box payload/empty-field omission.
- Save draft, accept review and publish remain separate. A successful save/reload
  is not human approval or a published menu. No public confidence, image-backed
  RES fields or variant relationships are introduced by metadata preservation.

**Offline scope (O12):** reload actual producer fixtures via Python
`ReviewCandidateResult.model_validate_json`, not a fake consumer store. Assert
pair-key/original/segment equality, fractional box 10.25 retained, span slices,
legacy omission; tampered box joins reject. Existing
`BoxEvidenceTests.test_fractional_exact_roundtrip_links_and_immutability`,
`test_valid_existing_links_preserved_and_invalid_review_links_rejected` and
`ReviewCandidateTests.test_identity_and_originals_survive_reordering_and_serialization`
are reusable; none tests database or reviewer authority.

**Verification:** offline unit/contract C1–C4 and O12 can PASS only producer
compatibility. External API/database/browser integration **BLOCKED / NOT RUN**;
Marwan/Nifemi/Jeffin must provide actual test file/name/command, environment,
consumer SHA, before/after originals/correction evidence and authorized/denied
source readbacks. There is intentionally no fabricated external test command.
A JSON roundtrip or mock store cannot close CONS-01.

## HOST-01 — End-to-end cold-start through durable ACK budget

**Owner:** Jeffin (host/runtime), Teeyansh (Queue/lease/report/DB/ACK), Mohammad
(measured pipeline stages); Sai release review, Vivien PM acceptance.
**Current:** a 700-second child processing cap, phase timeout 20 and readiness loop
30 s are different boundaries. Historical PR45 transport 720 s/lease 15 min does
not prove fit. Even the nominal 30+700 seconds exceeds 720 before adding transfer,
serialization or archives; **730 is arithmetic, not a new SLA**. A warm health
probe, dry-run build, final pipeline timings or synthetic source relay is not a
cold upload-to-ACK measurement. Existing private attempts exceeded the child cap
at different local batch settings; do not drop them from evidence.

**Proposed:** agree and measure one end-to-end budget before enabling submissions.
Start measurement at actual authenticated consumer claim/dispatch (also record
upload/enqueue/wait separately); end only at durable report retention, fenced DB
completion and individual Queue ACK. Record a monotonic span/trace for:

1. Cold container startup/readiness (and any overlapping work).
2. Request and private source transfer, authorization/hash verification.
3. Acquisition/native text/render/OCR and actual attempts/cache state.
4. Model request/wait/parse with actual concurrency and failures.
5. Local grounding/assembly and private suggestion preparation.
6. Report/bundle serialization and response transfer.
7. Private attempt archive and job report archive, with stored-byte hashes.
8. Fenced durable database completion and Queue ACK confirmation.

Pipeline `timings.json` is authoritative for final **pipeline-local** times, not
steps 1/2/7/8. Its total excludes saving that final small summary. Acquisition
reuse is `reused: true` with null current page timings; cache-only model latency
is not fresh latency. Concurrent batch durations overlap: use wall/critical-path
spans, not summed batch durations. Archive writes/DB/ACK failures must remain in
counts and history, not be discarded as outliers.

**Unresolved:** no approved overall value `B_e2e`, component transfer/archive/ACK
budgets, reserve, workload/percentile target or worst-case guarantee. Owners must
reconcile transport/proxy/runtime maximums, cancellation/cleanup, Queue visibility
or renewal, fenced lease/renewal and 15-minute capability freshness with measured
critical-path and retry limits. Document actual runtime limits before raising a
setting. Do not infer an ingestion budget from the temporary pull consumer's
visibility or from a grant's expiry. If no feasible fit exists, abstain/reject or
scope input work explicitly; do not silently lengthen timeouts or add retries.

**Evidence/scope/preconditions:** paired reviewed host/container release, valid
private source and approved configured providers for genuine acquisition, agreed
workload envelope, active reviewed consumer and migrations, storage adapters,
isolated synthetic tenants, owner-approved credentials and recovery policy.
No such provider/deployment/consumer actions are authorized by this document.

**Success/failure/history/compatibility — exact assertions:**

- All required spans/statuses present, nonnegative, ordered by causal dependency,
  elapsed end-start within approved `B_e2e`, and transport/runtime/lease/visibility
  constraints leave the approved reserve; no arbitrary sum of overlapping spans.
  Missing budget/span/ACK confirmation is BLOCKED/unknown, never PASS.
- Archive returns confirmed retained objects before durable completion; completion
  uses current fencing claim; ACK follows commit, never a health/model/schema
  success. Recheck private attempt and job-report hashes/source/tenant identity.
- Inject archive failure after extraction, DB failure after archive, claim expiry,
  timeout and lost ACK; no early ACK or double draft/correction write. Duplicate
  delivery preserves immutable attempt history and idempotent job completion;
  conflicting source hash does not overwrite history. Bounded retry exhaustion
  reaches the configured DLQ; controlled recovery gets a fresh claim/grant.
- Positive: cold and warm authorized synthetic upload-to-draft-to-ACK traces
  independently read back report and DB state. Negative: cross-tenant or stale
  grant denied before source access; timed-out/partial/failed extraction cannot be
  relabelled complete. An incomplete report may be archived for review but its
  failed/unprocessed pages and source remain visible under the agreed caller policy.
- Boundary: largest agreed source/page/bundle workload and startup-near-deadline
  case; before/at/after approved deadlines, lease renewal/fencing, simultaneous
  delivery versus one-process capacity, storage collision and retry-to-DLQ. No
  unbounded resubmission or parallel pilot consumer is inferred.

**Verification:** existing `PipelineTimingTests.test_run_timings`,
`test_saved_page_timings`, `test_failure_timings` and
`test_model_failure_timings` verify local timing truthfulness. Existing host tests
`retries readiness, never the extraction POST` and
`bounds readiness failure and permits a later request to recover` verify mocked
readiness only. Planned O13 reads Python constants and host source literals
read-only to flag drift, not prove runtime. C1–C3 can verify those limited claims.
Actual cold/warm + fault-injected upload→Queue→service→both archives→DB→ACK is an
external integration gate, **BLOCKED / NOT RUN**. Teeyansh/Jeffin must pin its real
test file/name/command and supply actual runtime/env/Queue settings, traces,
object/DB readback, retry/DLQ and cleanup evidence. No accepted full-flow command
exists here; a local budget arithmetic test cannot replace it.

## Offline implementation handoff (new test file only)

All names below are **proposed**, not existing tests or PASS claims. Implement in
`processing/tests/test_operational_contract.py`, class `OperationalContractTests`.
Reuse existing fixture builders, injected `source_reader`/`runner`, `TestClient`,
`TemporaryDirectory`, mocked HTTPX stream context and fake OCR/LLM patterns.
Never edit backend code to make these tests work. O10–O11 test-local protocol
helpers must be labelled controls, not external quality results. O2 intentionally
captures an unresolved gap; passing it must not mark OPS-01 accepted.

| Key | Exact proposed method | Concrete offline technique / expected assertion |
| --- | --- | --- |
| O1 | `test_transfer_read_timeout_closes_stream_skips_runner_and_releases_slot` | HTTPX context raises `ReadTimeout` during iteration; real `read_source` through ASGI; 502/no-store, context exit, no runner; healthy second request 200. |
| O2 | `test_transfer_phase_timeout_does_not_establish_elapsed_deadline` | Fake context advances its own elapsed counter 11 s for each of two chunks; both individually <20; source returns full bytes at simulated 22 s; assert passed timeout=20 and record gap, no sleep/network. |
| O3 | `test_child_cleanup_on_success_invalid_exit_and_timeout` | Stub `subprocess.run`, write real minimal output for success, inject invalid exit/TimeoutExpired; inspect timeout/argv/env, assert recorded temp paths gone on every path. |
| O4 | `test_source_stream_length_and_byte_limit_boundaries` | Fake chunks/headers at zero, exact source limit, +1, truncated and overflow; direct reader assertions and ASGI rejection/no runner where applicable. |
| O5 | `test_artifact_file_read_limits_accept_exact_and_reject_plus_one` | Valid whitespace-padded JSON temporary files at each real individual read cap; assert equality/ValueError. |
| O6 | `test_report_and_negotiated_bundle_serialized_byte_boundaries` | Pad schema-valid report/bundle diagnostic field using service's exact encoding; limits/+1, Unicode; expected 200 versus precise report_too_large/bundle_too_large 502. |
| O7 | `test_artifact_status_matrix_and_public_private_separation` | Real ASGI fixture with complete/incomplete/failed report and matching timings, private unvalidated rows; preserve statuses, no private public fields; mutate scope/mode/status/negotiation => fail closed. |
| O8 | `test_ocr_recovery_caps_one_and_four_count_transport_attempts` | Four-page synthetic saved failures, mock transport; exact calls/manifest cap edges, first 429 stop, invalid cap preflight and unchanged inputs. |
| O9 | `test_model_recovery_budget_uses_planned_batches_not_page_count_only` | Four-page ready saved PDF; fake LLM, `batch_pages=1` cap 4/3 plus `batch_pages=4` cap 1; exact planned/call counts and preflight no-call overflow, no OCR. |
| O10 | `test_strict_quality_scoring_rejects_aliases_partial_prices_and_duplicate_credit` | Test-local strict occurrence/group scorer with synthetic rows and explicit zero/unknown/failure outcomes per QUAL-01; no pipeline accuracy claim. |
| O11 | `test_reference_manifest_rejects_tampering_and_heldout_leakage` | Test-local manifest validator, fixed synthetic reference bytes/hash and split labels; one-byte mutation and shared source across development/holdout reject. |
| O12 | `test_producer_reload_preserves_candidate_identity_boxes_and_legacy_omission` | Actual Python review loader on shared fixtures; exact pair-key/original/metadata/spans/legacy equality; orphan/tampered records reject. Not a consumer persistence/auth test. |
| O13 | `test_budget_baseline_pins_component_limits_without_claiming_end_to_end_fit` | Import Python limits; read host source literals without execution (narrow patterns fail on absent/duplicate match) for 30,000/1,000/500/60,000 and 32/24 MB; assert nominal readiness+child=730 > historical 720, explicitly no approved overall budget. Static drift test only. |

Offline reference fixture hashes observed for reproducibility (synthetic, **not
held-out labels**). A changed hash requires reviewed re-freezing, not automatic
regeneration of the expected value:

| Path under `processing/tests/fixtures/` | SHA-256 |
| --- | --- |
| `review-candidates/representative-candidates-v2.json` | `d480108a99431e23f08c374513edf71fad279b70ade8a3292288ed456e734096` |
| `review-candidates/box-evidence-candidates.json` | `7b60f12580ef8a2ebc29acec797aba6fb4f6b27b713196fe11974c6f000f18eb` |
| `service-artifacts/representative-bundle.json` | `974639a166eb8965cbfdd701d1e3462f2d8eed97f86d8ce29eb55ce2ba47db78` |

## Commands, environment and pass/fail record

Commands are from the canonical repository root unless stated. Prefix with `rtk`
when installed per AGENTS; RTK was unavailable in this worker environment. Python
requires 3.12+, frozen processing dependencies including optional `service`, and
all fixtures. Use an already provisioned environment; do not install/download or
configure providers as part of this doc-only task. Node checks require the
repository-compatible Node (local evidence used Node 24), pnpm and installed
workspace dependencies. No backend/database/cloud credentials are needed offline.

For **each** Python command, use a network-denying launcher, not merely UV's
`--offline`. This exact launcher uses the existing venv, loads no `.env`, forbids
socket connections and fails if any attempted network is caught by application
code. It writes no bytecode. Set `PATTERN` to the stated pattern:

```sh
PATTERN=test_operational_contract.py PYTHONDONTWRITEBYTECODE=1 processing/.venv/bin/python - <<'PY'
import os, socket, unittest
attempts = []
def deny(*args, **kwargs):
    attempts.append(1)
    raise AssertionError('Offline acceptance forbids network')
socket.socket.connect = deny
socket.socket.connect_ex = deny
socket.create_connection = deny
suite = unittest.defaultTestLoader.discover('processing/tests', pattern=os.environ['PATTERN'])
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() and result.testsRun > 0 and not attempts else 1)
PY
```

Test code must inject fake LLM/OCR/source transports and avoid CLI `.env` loading
(or patch `load_dotenv` when testing CLI). ASGI TestClient is in-process. Blocked
socket count must be zero, not just a caught exception with green assertions.
Use no real source inputs, secrets, R2 keys, provider clients or cached private data.

| Command key | Exact invocation / scope | PASS / FAIL and present execution state |
| --- | --- | --- |
| C1 | Launcher above separately with `PATTERN=test_service.py`, `test_service_artifacts.py`, `test_recover_pages.py`, `test_targeted_model_recovery.py`, `test_pipeline_timing.py` | Each suite runs >0, assertions all green, zero socket attempts; otherwise FAIL. **NOT RUN by this doc-only task**. Names above were read, not inferred from suite counts. |
| C2 | Launcher above with `PATTERN=test_operational_contract.py` | All O1–O13 run, no skips/network; otherwise FAIL. **NOT RUN: file is proposed and absent**. O2 characterizes a gap; gate still BLOCKED even if green. |
| C3 | `pnpm exec vitest run backend/src/extraction-host.test.ts` | Unchanged mocked host assertions green/no skips; otherwise FAIL. **NOT RUN**; no live R2/Container inference. |
| C4 | Launcher with `PATTERN=test_review_candidates.py` then `PATTERN=test_box_evidence.py`; `pnpm exec vitest run packages/contracts/src/review-candidates.test.ts` | Actual producer and shared-schema compatibility green/no skips; otherwise FAIL. **NOT RUN**; no external store/auth/quality inference. |
| Docs | `pnpm verify docs:check` | Local links valid; otherwise FAIL. **NOT RUN**: project runner writes shared ledger outside this task's ownership. New-file/frontmatter/link inspection is allowed instead. |
| External QUAL-01 | Private held-out evaluator file/name/command **unresolved** | **BLOCKED / NOT RUN** pending frozen independent population, scorer and thresholds. |
| External CONS-01 | Actual API/store/browser test file/name/command **unresolved** | **BLOCKED / NOT RUN** pending consumer release, authorized source delivery and isolated persistence env. |
| External HOST-01 / OPS-01 / OPS-02 | Actual cold/full-flow/cancellation/storage-failure test file/name/command **unresolved** | **BLOCKED / NOT RUN** pending agreed elapsed budgets, paired release, consumer/provider authorization and runtime/lease evidence. |

Do not replace any external row with a made-up test command or a synthetic PASS.
The responsible owner supplies runnable commands and reviewed expected statuses
before that gate is attempted. Existing historical PASS records remain scoped to
their dates/bytes; this contract neither erases them nor promotes them to acceptance.

## Release decision and remaining ownership

No gate is closed by creating this document. Next authorized offline slice may
implement O1–O13 only after reviewing this draft; any producer deadline changes
need their own implementation scope and fail-first tests. Actual consumer tests
belong to the named external owners, not a mock backend added to this file.

Release requires all owners to reconcile unresolved decisions, run positive,
negative and boundary cases at pinned producer/consumer/host revisions, retain
sanitized command results and independently read back durable effects. A failure,
abstention or missing page remains in the record. Human review, approval and
publication remain separate from extraction/transport/serialization success.
