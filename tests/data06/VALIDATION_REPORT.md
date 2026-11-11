# DATA-06 independent fixture validation

Status: **fixture preparation checked; DATA-06 application acceptance pending**.

These files prepare expected descriptive signals and privacy boundaries for
Uneeza's DATA-06 work. They do not implement a consideration score or execute a
`dish_consideration.draft.v1` producer. That implementation was not found in the
reviewed backend/contracts source.

## What the fixtures check

- Distinct event IDs for prepared exposure, detail-open, comparison and direct-Save inputs.
- Duplicate event IDs leave the expected descriptive count unchanged.
- Undo IDs are kept separate from direct Save IDs.
- Distinct eligible-session boundaries at 9, 10 and 11, plus ten events from one session.
- Below-floor expectations require both `SUPPRESSED` and a null value.
- The numeric score remains null with `MISSING / POLICY_PENDING`.

The input arrays are **already classified**. For example, the comparison case
receives `qualifying_comparison_event_ids`; it does not establish that a real
comparison was displayed in the correct order. The Save case keeps two supplied
arrays separate; it does not classify a raw Undo event through production code.

## November 11 independent checks

| Check | Result | Scope |
| --- | --- | --- |
| `pnpm exec vitest run tests/data06` | PASS: 14 tests, 0.611s | Uses the normal test configuration; the original configuration discovered zero DATA-06 tests |
| `pnpm exec tsc -p tests/data06/tsconfig.json --noEmit` | PASS | Also included in the workspace typecheck command |
| DATA-06 plus report/AI input, adapter and producer-seam unit suites | PASS: 67 tests, 1.08s | Four existing report/adapter suites plus the two DATA-06 suites; no live model call |
| Running local Worker with disposable PostgreSQL | PASS: one selected report journey, 12.38s total | Existing owner-report route; 38 unrelated integration cases were skipped by the explicit filter |
| `pnpm verify build` | PASS: both frontend builds and staging Worker dry-run, approximately 7.32s | No deployment |
| Two deliberately broken fixture probes | PASS: both rejected at assertions | Empty descriptive expectations and a missing below-floor suppression status |
| `pnpm check` | PASS: 1,452 unit tests, four optional skips, 79 script tests | Includes DATA-06 through normal discovery, strict types, lint, context and docs; unit phase 9.36s |

The selected Worker/PostgreSQL journey exercises current report aggregation,
9/10/11-session boundaries, privacy output and denied/revoked venue access. It
supports the **existing owner-report implementation**, not the proposed DATA-06
output. The database and synthetic credentials were created by the repository
test harness and cleaned up; contributors do not need hosted database passwords.

The earlier author run reported 63 executions: 13 DATA-06 checks and 50 selected
existing tests. Those are historical results on the earlier branch. The current
independent run adds the 11-session case and uses the verification scopes above.
Full repository/CI results are recorded on the final PR commit.

## Run these checks

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/data06
pnpm exec vitest run --config vitest.data06.config.ts
pnpm exec tsc -p tests/data06/tsconfig.json --noEmit
pnpm check
```

For all existing database/Worker checks, start Docker Desktop and run:

```sh
pnpm verify test:db
```

The focused independent database run selected `backend/src/dish.integration.ts`
with the `Multi-tenant owner report isolation` test name through the same disposable
database harness. It did not run the complete database suite.

## Merge order

1. Review and merge **#112** into `develop` first; it remains a separate draft implementation PR.
2. Retarget **#144** from `feat/ai01-report-input-validation` to `develop`, reconcile the then-current base and rerun checks before merging.

This review approves preparation of the fixtures and checks. It does not approve
#112's implementation or close DATA-06's application acceptance.

## What still needs evidence

- [ ] Link the actual DATA-06 producer and approved versioned input/output contract.
- [ ] Execute these expectations against that implementation instead of counting prepared ID arrays.
- [ ] Check actual exposure/readability rules, ordered comparison attribution and maximum linked timing checkpoints.
- [ ] Verify deduplication, revision/tenant boundaries, complementary suppression, coverage and freshness through the DATA-06 output.
- [ ] Obtain product approval for score mapping, weights, units/range and per-session caps.
- [ ] Run the integrated staging journey with genuine authorization and capture its results separately.

Hosted DATA-06 execution, model evaluation, deployments and product sign-off remain
**NOT RUN / PENDING**. Meeting the ten-session floor alone does not establish that a
value may be shown; other withholding rules still apply.
