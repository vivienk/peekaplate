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
