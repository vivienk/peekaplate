# S5-DATA-05 Independent Validation Findings

Date: 2026-11-09
Status: PARTIALLY VALIDATED — PENDING INTEGRATION EVIDENCE

## Verified Results
- Existing backend tests: PASS (4/4)
- Existing contract tests: PASS (4/4)
- Independent privacy boundary tests: PASS (9/9)
- Total: 17 passed, 0 failed (1.719 seconds in the final focused run).
- Current command/results and historical counts: [validation_results.txt](validation_results.txt).

## Privacy Boundary
- 9 eligible sessions: INSUFFICIENT; eligible_sessions and metric values are null.
- 10 eligible sessions: COMPARABLE in mocked-row test.
- 11 eligible sessions: COMPARABLE in mocked-row test.
- These independent tests mock database query results; they do not execute PostgreSQL queries.
- The JSON privacy fixtures now drive the tests directly. Current and baseline
  periods have separate overall, exposure and opening session counts.
- Current/baseline 9/11 and 11/9 suppress all metrics and their eligible counts.
- Four one-sided denominator cases keep overall sessions at 11 while only one
  current/baseline exposure or opening cohort is 9. Affected values, delta and
  eligible count must all be null; unaffected metrics retain their exact rates,
  deltas and eligible counts. Dish/report status remains COMPARABLE when an
  unaffected metric is usable.

## Regression check

A temporary mutation changed the denominator guard from OR to AND. The original
11 tests still passed (1.796 seconds); the corrected suite failed in exactly four
one-sided denominator cases (1.719 seconds). Restoring the original implementation
returned all 17 tests to PASS (1.719 seconds). No production change or mutation is
included in this PR. This proves the new tests detect that specific adapter-level
privacy regression; it does not validate SQL or hosted suppression.

## Pending Validation
1. Database-backed integration tests were not executed because test database connections are not configured.
2. Cross-revision deduplication fixture expects 17 distinct sessions from two groups of 10 with 3 overlapping sessions. This expectation has not been verified against backend SQL.
3. Confirm with Louis and Zhiliang whether publication-revision-specific aggregation is within DATA-05 scope.

## Failure Ledger
- Confirmed failures in executed tests: None.
- Unexecuted integration checks: Pending, not counted as passes.
- Open scope question: Revision-specific deduplication and attribution.

## Review
Independent validation evidence submitted for Sai's review.
This report does not constitute self-certification or final acceptance.

The branch incorporates its existing `s5-data-05-periodic-comparison` dependency
for reproducible tests. Approval of this validation slice does not approve that
implementation branch, authorize a deployment or certify DATA-05 completion.
