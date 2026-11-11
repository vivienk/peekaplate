# Period comparison reader

S5-DATA-05 adds an internal backend reader and `comparison_report.v1` contract.
It compares dish-level opening, engagement and direct-Save rates over two explicit
UTC time windows. Windows include their start and exclude their end. This is
observed behavior, not orders, revenue or evidence of causal improvement.

`readComparisonReport` checks current venue membership and reads tenant-scoped,
live canonical facts through `owner_observation_v1`. Test/demo traffic is excluded.
Session-level booleans prevent repeated deliveries or repeated actions from
inflating these visit-based rates. Multiple publication revisions of the same
stable dish share a session cohort; the restored DATA-05 fixture verifies that
two ten-session sets with three overlapping sessions produce seventeen sessions.
This proves that example's current SQL behavior, not product acceptance of every
cross-revision comparison.

The opening rate uses exposed sessions. Engagement uses opened sessions and
requires either a linked checkpoint reaching ten active seconds or a qualifying
displayed comparison. A comparison needs an earlier opening of either participant;
equal timestamps require a smaller local sequence from the same producer. Each
participant must also have its own opening in the window. The entry source need
not be `compare_view`. Cumulative checkpoints are not added together. Direct Save
uses exposed sessions; Undo is not a new direct Save.

Both periods must meet the ten-session floor for each metric's denominator.
Suppressed metrics expose null values, differences and cohort counts. If either
opened cohort contains one to nine sessions, the opening rate is also suppressed
so its rate and exposure count cannot reconstruct that protected group. Zero
openings do not trigger that complementary rule; valid zero rates above their
denominator floor remain usable. `eligible_sessions` in this internal contract is
the smaller of the two eligible cohorts, not an individual event history.

## Verification

Uneeza's restored JSON fixtures drive nine independent mocked-row privacy cases.
The opening-cohort cases now also require complementary opening-rate suppression.
The real PostgreSQL suite covers aggregation, ordered comparison engagement,
one-/nine-/ten-/eleven-opening boundaries, valid zero, cross-publication session
deduplication, test/demo exclusion and unauthorized venue denial.

Run `pnpm check` for contracts/reader/fixture tests and `pnpm verify test:db` for
disposable PostgreSQL migrations, SQL assertions and backend integration checks.
The database runner supplies its own local credentials and cleans up afterward.
Historical mutation evidence in `tests/data05/evidence` remains labelled separately
from the new verification.

## Remaining integration

No comparison HTTP route, console connection, hosted migration or deployment is
added here. A future owner-facing endpoint still needs its reviewed authentication,
source/release policy, response boundary and disclosure checks across query windows
and filters. The existing owner-report route and its synthetic-only release gate
are unchanged. Fixture and local PostgreSQL passes do not certify hosted privacy,
freshness or final DATA-05 product acceptance.
