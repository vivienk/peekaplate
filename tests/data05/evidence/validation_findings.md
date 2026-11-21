# DATA-05 validation findings

## Current PR134 review — November 11, 2026

Status: local reader/fixture checks pass; hosted and product acceptance remain pending.

PR123's five test/fixture/evidence files are restored from a8cd00b after disappearing from the later implementation branch. The nine mocked-row cases still vary current/baseline and exposure/opening cohorts independently. Fixture v3 also suppresses the opening rate when either opened cohort contains one to nine sessions; Save stays independent when its cohort is eligible.

Two real PostgreSQL reproductions failed against the original reader: a ten-exposure/one-opening period disclosed open_rate=0.1 plus count=10, and ten menu-card openings followed by displayed comparisons incorrectly returned zero engagement. Complementary suppression and ordered qualifying-comparison matching fix those failures.

Current verification:
- Focused unit/contract/JSON command: 17/17 PASS, 744 ms.
- Focused real PostgreSQL reader suite: 11/11 PASS, 2.42 s.
- Full pnpm verify test:db: 281 pgTAP assertions and 107 integration tests PASS; integration phase 25.36 s.
- pnpm check: 1,374 unit tests (four optional skips), 74 script tests, lint, strict types, context and documentation links PASS; unit phase 7.49 s, scripts 1.71 s.
- pnpm verify build: both frontends and staging Worker dry-run PASS; no deployment.
- The restored cross-publication fixture is now executed by comparison-report.integration.ts and returns seventeen distinct sessions from two ten-session sets with three overlapping sessions. This verifies that scenario's current stable-dish pooling behavior, not final product policy for all revision comparisons.

The real database cases also cover 0/9/10/11 current-opening boundaries, comparison-before-opening rejection, test/demo exclusion, unauthorized venue denial and transaction recovery. See validation_results.txt for the historical evidence and exact commands.

## Historical independent evidence

The November 9 review passed 17 tests in 1.719 s. A temporary denominator OR-to-AND mutation passed the original eleven tests but failed four added one-sided cases. Production source was restored before that submission. That mutation was not rerun during this PR134 review. Earlier local passes at implementation base c344b7e are retained in validation_results.txt.

## Remaining work

No comparison HTTP route or dashboard is connected here. Owner-facing source/release policy, response boundaries, disclosure controls across windows/filters, hosted privacy/freshness and product scope confirmation need separate review. Mocked rows and local SQL do not certify those. No live restaurant/POS data, hosted migration, deployment or new permission is included.
