# AI-01 safe recommendation core

Status: local foundation for S3-AI-01. It is not an owner API, model integration, production recommendation policy or deployment record.

## Boundary

`OwnerRecommendationRequestSchema` accepts only a bounded `owner-recommendation.v1` request tied to one venue, report version and exact time window. Available rate evidence requires at least ten eligible sessions. Missing, suppressed, stale, conflicting and unsupported evidence use value-free variants so a caller cannot reconstruct withheld cells. Unknown fields, duplicate evidence IDs and unsupported metrics are rejected.

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
