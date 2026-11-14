# DATA-12: report checks and remaining reconciliation evidence

Reviewed by Sai, November 13, 2026. Base: `develop` at `385a19f`.
This is local report verification, not approval of the full DATA-12 staging journey.

## What the tests actually exercise

| Check | Expected | Evidence / limit |
| --- | --- | --- |
| Aggregate rows at 9 / 10 / 11 sessions and repeated-session count 1 | Suppress 9 and 1; disclose safe cohorts at 10/11 | `owner-report.data12-reconciliation.test.ts` feeds hand-authored query results. It checks serialization, not SQL session counting or event deduplication. |
| Eleven opened sessions with eleven openings, ten final timings | Timing coverage 10/11 = 0.909 | Corrected the impossible earlier row with eleven opened sessions but only ten openings. |
| No openings above the exposure floor | Open rate VALID_ZERO; engagement/timing NOT_MEASURABLE | Corrected the earlier zero-opening row's nonzero opened-session denominator. |
| Empty query | EMPTY, no dishes, unknown freshness | Explicit empty-result regression. |
| Below-floor comparison aggregate | All three comparison metrics INSUFFICIENT and null, with counts stripped | Tests serializer suppression. Does not execute comparison ordering/deduplication. |
| Actual report SQL window | Include start, exclude end for exposures and final checkpoints | Two PostgreSQL regressions in `comparison-report.integration.ts` execute `readOwnerReport` against migrated facts. |

The previously cited `tests/data06/privacy_boundaries.json` and
`tests/data06/descriptive_signals.json` are not in this tree; #144 remains a
separate dependency. Merged #155 now supplies `owner-report.data12.test.ts`,
five additional aggregate-row unit checks and a staging runbook. Neither suite
imports DATA-06 event fixtures or establishes application acceptance.

Existing PostgreSQL tests provide additional, separately scoped evidence:

- [Comparison integration](../../backend/src/comparison-report.integration.ts)
  tests ordered versus reversed comparisons, complementary suppression and the
  checked-in DATA-05 revision fixture.
- [Synthetic consumer integration](../../backend/src/consumer/owner-synthetic.integration.ts)
  adapts the checked-in 22-delivery starter story, persists 21 unique events,
  checks duplicate replay and excludes its **test-class** events from owner views.
- [Worker/database integration](../../backend/src/dish.integration.ts) exercises
  signed staff access, tenant denial and actual report queries using local synthetic facts.

These checks do not prove the provenance of any hosted venue or execute the AI agent.

## Provenance: hosted verification still required

`app_private.owner_observation_v1` reads accepted **live-class** facts. The HTTP
`source=synthetic` value labels the response; it neither filters input provenance
nor makes real observations synthetic. The allowlist is an access boundary only.

The fixed allowlisted venue `00000000-0000-4000-8000-000000000123` has **not been
audited against its hosted inputs by this PR**. The local starter-story test uses a
different random venue and test-class traffic; it cannot establish that claim.
Before DATA-12 approval, Sai/Louis must record:

- [ ] Exact staging API SHA/version, configured venue and evaluation interval.
- [ ] Canonical event/index IDs, source fixture version/hash and matching private
  R2 archive hashes for every included input; explain every unmatched row.
- [ ] Evidence that all included live-class inputs were intentionally generated
  synthetic cases, with no real diner traffic mixed into that venue.
- [ ] Actual expected-versus-actual report results from that same audited set.

Keep raw payloads, credentials and private source data out of this public report.
An empty report is not proof that a nonempty synthetic seed was validated.

## Freshness and time-window corrections

`readOwnerReport` retains `freshness.is_stale: null`. Its latest included event's
`first_received_at` does not prove the Queue/backfill is caught up. No trusted
pipeline completion/freshness signal is wired, so unknown must not display Fresh.
Jeffin's panel/fixture work in PR #170 and Zhiliang's AI consumer must preserve
that distinction; neither is certified by this PR's unit tests.

The owner SQL now uses `start <= occurred_at < end`, including activity
checkpoints, matching comparison windows and the panel's end-excluded semantics.
The new PostgreSQL regressions failed before correction (11 exposures instead of
10; 1.0 timing coverage instead of 10/11) and passed after correction. A checkpoint
exactly at the old end becomes eligible when the end advances by one millisecond.
This runtime correction needs a reviewed staging release before hosted use.

## Execution record

The original three-file unit run passed 18 tests, but that did not establish the
broader reconciliation claims above. Fresh post-fix results are recorded in the
PR review comment with exact commands, counts and elapsed time.

## Remaining acceptance

Hosted diner → independent PostHog/canonical delivery → Queue/private R2 →
Supabase facts → authenticated report → rendered panel is **NOT RUN by this PR**.
Final independent metric reconciliation, trusted freshness, hosted provenance,
frontend wording/fixture alignment and AI-consumer semantics remain explicit
DATA-12 gates. No Queue, provider, hosted migration or production change is made.
