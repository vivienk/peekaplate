# AI-01 safe recommendation core

Status: local foundation for S3-AI-01. It is not an owner API, model integration, production recommendation policy or deployment record.

## Boundary

`OwnerRecommendationRequestSchema` accepts only a bounded `owner-recommendation.v1` request tied to one venue, report version and exact time window. Available rate evidence requires at least ten eligible sessions. Missing, suppressed, stale, conflicting and unsupported evidence use value-free variants so a caller cannot reconstruct withheld cells. Unknown fields, duplicate evidence IDs and unsupported metrics are rejected.

Eligible-session counts stay internal, matching `toOwnerReport()`. They enforce the
privacy floor but never appear in recommendation text or the result payload.

Window identity currently uses exact ISO strings. A future report adapter must
reuse the request's window representation; a differently formatted but equivalent
instant fails closed. This foundation does not normalize reporting windows.

`buildOwnerRecommendation` receives the server-authorized venue separately and fails closed when the request or any evidence belongs to another venue, report version or time window. At most three unique report metrics and 1,000 context characters are admitted. Untrusted summaries are counted for the budget but are never copied into instructions or output. This slice permits one deterministic attempt, zero tool calls and zero executable effects.

The result is either one review-only draft action with exact evidence references and limitations, or an explicit abstention. Every result is bound to the request venue, report version, window and a versioned policy; recommendation results also expose the selected rule and approved action ID. A contextual validator rejects fabricated evidence references or crossed request identities. Every result requires owner approval and carries an empty `allowedEffects` tuple. The implementation never publishes a menu, mutates data, sends a message, runs SQL or claims orders, revenue, diner motive or causality.

## Recommendation rules

Thresholds are supplied only by a strict, versioned rule configuration. Rules select from fixed metric-compatible action IDs whose user-facing text is owned by code; arbitrary rule text cannot enter the result. Rule priorities are unique and evaluated deterministically. This branch deliberately ships no production thresholds because the AI evaluation rubric and guardrails are still in progress. Tests use a synthetic rule only to prove evaluation, evidence citation, tenant isolation and prompt-injection resistance. A live model cannot be connected until the approved rubric, current restaurant membership check, validated S3-DATA-02 report API and model/output evaluation are present.

## Offline development evaluation

Run `pnpm verify eval:owner-ai` to execute the frozen synthetic-core.v1 development
cases and write `test-results/owner-ai/development-evaluation.json`. The normal
unit suite also runs these cases, without writing the report. The dedicated
command removes any old report before starting, and returns a failing exit code
when a case, discovery or startup fails.

It also validates the fresh report after Vitest exits: `synthetic-core.v1` must
contain all 21 unique passing cases and `DEVELOPMENT_CHECK_PASS`. Missing or
incomplete evidence fails the command even when Vitest itself exits successfully.
The CLI regressions use isolated child fixtures; they do not change the frozen
recommendation oracle or call a provider.

The report includes source commit, dirty-worktree flag, timestamp, fixture and
criterion IDs, full expected/actual output, case counts and development-only
disposition. Retain only clean-commit reports as reproducible handoff evidence.
The cases cover valid zero, 9/10/11-session boundaries, each withheld state,
cross-venue/report/window rejection, strict fields, injection and rule boundaries.
Invalid contracts are rejected rather than coerced into safe-looking metrics.
The synthetic threshold is not a proposed or approved business threshold.

This is implementation evaluation of the deterministic core, not an independent
rubric run, statistical quality score, LLM evaluation or use of the QA-02 dataset.
It does not map the still-unsettled DATA-02 response, compute real denominators,
establish HTTP membership authorization, validate publication behavior or prove
hosted privacy. Those boundaries remain explicitly NOT RUN / NOT VERIFIED in
the report. Uneeza and Sai retain independent evaluation and validation.

## Remaining integration

- Owner API authorization and HTTP error mapping.
- Approved production rule thresholds or a bounded model adapter.
- Prompt/model/report version persistence and cost accounting.
- S3-RES-03 owner UI, approval workflow and design sign-off.
- Independent rubric evaluation and hosted evidence.

Fixture tests establish the pure contract boundary only; they do not certify recommendation quality or production readiness.

## November 8 core review handoff (merged #46)

Reconciled with develop after #25 and #73. Their asset preparation, review API and
source-provenance guard are preserved. The additional privacy regression failed
before the template fix and passes afterward: changing only an internal cohort
from 23 to 97 sessions no longer changes the owner-facing result. The ten-session
input floor remains enforced.

Recorded on the reviewed #46 core candidate `413f79e`: 26 focused AI tests (1.787s command time); `pnpm check`,
888 unit and 67 script tests (24.237s); `pnpm verify test:db`, 213 SQL assertions
and 76 integration tests (48.165s); `pnpm verify build` (7.254s).
`pnpm exec playwright test --workers=1` passed all 51 Chromium checks (62.067s).
These are synthetic/local checks, not live recommendation or model acceptance.

#46 is merged. The synchronized #82 evaluation now expects the count-free
rationale while retaining the internal 9/10/11-session boundary cases. Regenerate
its clean-commit evaluation evidence before review, then synchronize #112. Do not
restore internal counts to satisfy older fixtures. Producer/report privacy,
freshness and live integration remain separately reviewed work.

## November 8 evaluation synchronization (#82)

The 21-case oracle now expects count-free recommendation text from the merged
core. Ten- and eleven-session inputs yield the same public explanation; the
nine-session input remains invalid. Five old expectations failed before this
oracle update and all 21 pass afterward. The combined core/contract/evaluation
suite passes 47 cases. Backend and contract strict TypeScript checks pass.

Initial local checks reused the existing Node 24.22.1 / pnpm 11.25.0 installation
with the dependency-status action set to warn because agent-side installation
could not create Windows links. The contributor subsequently completed normal
frozen installation (213 checked lock entries), resolving the missing workspace
link without changing engine or lockfile policy.

Normal #82 validation now passes lint, all seven package typechecks and 905
application tests (four skipped). Of 67 script tests, 66 pass; the preview
artifact-symlink regression cannot create its junction in the agent sandbox.
Keep that security test intact and verify the aggregate check in a normal
terminal or Linux CI. Context/docs checks pass. Clean-source evaluation reports
are retained outside Git with their actual commit and limits. No model, hosted
API or independent rubric acceptance is established by this synchronization.

## Internal report input validation

validateOwnerAiReportInput validates the shared internal owner_report.v1 report
and selects one dish using authorizedVenueId and dishId. Its server-side caller
must first authenticate current venue membership. Each available rate retains
its own checked eligible-session count. VALID_ZERO retains numeric zero;
SUPPRESSED and NOT_MEASURABLE become distinct value-free states. Invalid
status/value pairs, foreign venues, absent dishes and duplicate identities are
rejected. Report ERROR, STALE/freshness and EMPTY override locally available
rates. Unknown pipeline freshness (`is_stale: null`) also withholds all rates as
value-free `missing` evidence, including otherwise valid numeric zero; verified
freshness (`false`) retains that zero. Source, calculation version, report window
and unknown freshness metadata are retained.

Public owner responses omit cohort counts and cannot be used as this input.
The reporting service must supply its validated internal report after
complementary suppression. Structural validation cannot prove the underlying
SQL, consent, suppression or freshness calculations are correct.

This exported boundary has local synthetic tests. The pure consumer adapter
below maps it into the existing recommendation request; the reporting API remains
unwired. Trusted report/evidence identity issuance and the real producer handoff
remain integration dependencies. Merged PR #107 retains the reserved
synthetic-venue gate; its public responses omit internal cohorts and are not the
internal producer fixture needed by this validator.

## November 8 input-validation synchronization (#112)

The validator and its 20 input cases are unchanged relative to the prior Draft.
This synchronization inherits the reviewed count-free core and corrected #82
evaluation. Keep #112 Draft and AI-01 In Progress; no reporting SQL/API, new
report version, production policy, live model or owner UI is added.

Local validation passes 67 focused cases (26 core/contracts, 21 evaluation and
20 internal report inputs), backend/contracts strict types and context/docs
checks. After normal frozen installation, all seven package typechecks and 925
application tests pass (four skipped); build/context/docs checks pass. The same
preview-junction setup limitation prevents the agent aggregate check from being
green. This is not evidence for the unmerged nullable-freshness report producer,
actual SQL cohorts or live owner integration.

## November 8 normal-terminal verification

The contributor's normal-terminal `pnpm check` passes on the synchronized #112
source: lint, all seven package typechecks, 925 application tests (four skipped),
all 67 script tests including artifact-symlink rejection, and context/docs.
The initial terminal launch lacked pnpm on child-process PATH; a task-local
launcher selected the unchanged project-pinned pnpm 11.25.0 and Node 24.22.1.
No repository script, security test or engine/lockfile policy was relaxed.
The final evidence-ledger/documentation update does not change runtime code,
contracts or tests. Dedicated reports identify their actual clean source commits.
Database/browser integration, hosted reporting, model execution and independent
rubric acceptance remain separate verification gates; #112 stays Draft.

## November 10 input-validation synchronization (#112)

PR82 and PR107 are merged into develop. This synchronization retains the frozen
21-case oracle, the fresh/complete evaluation-artifact guard and its five CLI
regressions, together with the reserved synthetic-venue report gate.

The widened report schema admits unknown freshness as null. A failing regression
showed that the previous input validator incorrectly admitted all three rates.
The validator now withholds those rates as value-free missing evidence, retains
the original null metadata and still preserves valid zero when freshness is
verified. There are 21 input-validation cases after this correction.

This remains an internal validator, without report-to-recommendation/API wiring.
Louis's precise internal producer fixture, trusted identities, post-disclosure
cohorts and freshness handoff remain required. Keep PR112 Draft and AI-01 In
Progress; model/provider/budget, independent rubric and hosted acceptance are
separate gates.

## November 10 report-to-core consumer adapter (#112)

`toOwnerRecommendationRequest(internalReport, scope)` maps the internal validator
into the unchanged `owner-recommendation.v1` request. Its server-only caller must
authenticate current venue membership and supply `authorizedVenueId`, the selected
`dishId`, and a trusted snapshot context. Never take that context from a browser
request or treat structural validation as proof of authorization.

The context contains existing core `requestId`, `reportId`, `reportVersion` and
three metric evidence IDs, plus the bound venue/dish, source, calculation version,
generation timestamp and exact start/end strings. The adapter checks that tuple
against the selected report. It does not generate IDs, derive a report version
from a timestamp or require new producer database columns. Production identity
issuance and how one report version binds a selected dish are still a shared
producer/caller integration decision; the tests inject labelled synthetic IDs.

| Internal evidence | Existing core evidence |
| --- | --- |
| NORMAL / VALID_ZERO with verified freshness | Available value and its own checked cohort; numeric zero stays zero |
| NOT_MEASURABLE | Value-free `missing`; the original report retains the denominator-specific reason |
| SUPPRESSED / STALE / MISSING / EVIDENCE_CHECK_FAILED | Value-free suppressed / stale / missing / conflicting |
| Unknown report freshness | All metrics missing, including otherwise valid zero |
| Related cell hidden by shared complementary suppression | Suppressed; never restore its internal value |

The adapter reuses `toOwnerReport()` to honor the shared disclosure projection
before admitting an otherwise available metric. This is not verification of
producer SQL, arbitrary overlapping-filter suppression or real freshness.
Only the three existing rate keys are selected. Dish names, free-form source
text, internal counts and producer context are not copied into public output.
Counts remain internal inputs to the existing privacy checks.

The caller can then pass the request and an approved server-owned policy to
`buildOwnerRecommendation()`. The existing generator and exact contextual result
validator are unchanged: an LLM paraphrase is not admitted by this adapter.
No HTTP endpoint, provider client, live report connection, approval action or
deployment is added. An absent approved production policy is still a live-use
gate; synthetic test policy is not product approval.

Sixteen synthetic seam cases connect this mapping to the real deterministic core,
including valid zero, not measurable, unknown freshness, withheld cells,
complementary suppression, foreign scope, a second dish, changed source/window/
generation/calculation identity and ambiguous evidence IDs. The existing frozen
21-case development oracle remains unchanged. Real producer-shaped input,
membership authorization, independent evaluation and hosted acceptance remain
separate; keep #112 Draft and AI-01 In Progress.

## Internal producer-constructor seam (mock SQL)

The existing `readOwnerReport()` calls a private `buildInternalReport()` before
the shared `toOwnerReport()` disclosure projection. Three consumer tests observe
that actual constructor through a test-only passthrough at the projection seam;
the real projector still runs. The SQL aggregate rows and membership lookup are
mocked, so these are not database, authorization or hosted acceptance tests.
The test captures internal cohorts directly and never reconstructs them from
the public response or exposes a new internal API.

Normal rates, a valid zero Save rate and a small opened cohort exercise the
actual constructor, disclosure projection, consumer adapter and deterministic
core together. The constructor currently returns `is_stale: null`. All three
cases therefore produce value-free missing evidence and abstention, including
the otherwise valid zero; the tests do not manufacture verified freshness.
Complementary suppression and removal of public cohort counts remain intact.
Caller snapshot/evidence identities are explicitly synthetic fixtures, not a
production identity-generation scheme.

An external JSON fixture is not required for these local constructor checks.
Actual database-backed internal output, trusted report/evidence identities,
freshness/disclosure semantics, current membership and the real producer/caller
handoff still require their separate verification. The existing frozen 21-case
development oracle, production reader/SQL, shared contracts and core remain
unchanged. #112 stays Draft and AI-01 stays In Progress.
