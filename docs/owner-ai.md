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

These local checks reuse the existing Node 24.22.1 / pnpm 11.25.0 installation.
Frozen installation is blocked by Windows link permissions; pnpm's dependency
status action was set to warn for these runs, without changing engine or
lockfile requirements. Full `pnpm check` is not green: the diner lacks its new
workspace contract link, so type checking and broader test loading need a fresh
installation. Clean-source evaluation reports are retained outside Git, with
their actual commit and validation limits. No model, hosted API or independent
rubric acceptance is established by this synchronization.

## Internal report input validation

validateOwnerAiReportInput validates the shared internal owner_report.v1 report
and selects one dish using authorizedVenueId and dishId. Its server-side caller
must first authenticate current venue membership. Each available rate retains
its own checked eligible-session count. VALID_ZERO retains numeric zero;
SUPPRESSED and NOT_MEASURABLE become distinct value-free states. Invalid
status/value pairs, foreign venues, absent dishes and duplicate identities are
rejected. Report ERROR, STALE/freshness and EMPTY override locally available
rates. Source, calculation version and report window are retained.

Public owner responses omit cohort counts and cannot be used as this input.
The reporting service must supply its validated internal report after
complementary suppression. Structural validation cannot prove the underlying
SQL, consent, suppression or freshness calculations are correct.

This exported boundary has local synthetic tests. The reporting API and
recommendation core are not yet wired to it. Stable report/evidence identities,
dish-scoped recommendation references and mapping not_measurable into a core
abstention remain integration dependencies. Draft PR #107 responses are not
accepted contract fixtures.

## November 8 input-validation synchronization (#112)

The validator and its 20 input cases are unchanged relative to the prior Draft.
This synchronization inherits the reviewed count-free core and corrected #82
evaluation. Keep #112 Draft and AI-01 In Progress; no reporting SQL/API, new
report version, production policy, live model or owner UI is added.

Local validation passes 67 focused cases (26 core/contracts, 21 evaluation and
20 internal report inputs), backend/contracts strict types and context/docs
checks. The existing-installation and full-workspace limitations recorded above
also apply here. This is not evidence for the unmerged nullable-freshness report
producer, actual SQL cohorts or live owner integration.
