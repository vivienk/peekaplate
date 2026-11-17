# S6-RES-04 acceptance evidence

This is an evidence record, not release approval. [S6-RES-04](https://app.clickup.com/t/86bd1am7t) targets immutable Bundle v1 generation and publication handoff. Original freeze was November 10, 2026; any new code or deployment is a release exception requiring independent human release approval.

| Requirement | Implementation and proof | Result / boundary |
| --- | --- | --- |
| Approved snapshots override mutable draft/candidate data; preserve unknown allergens | `bundle-producer.integration.ts` loads real tenant-scoped records with both database roles and compares produced bytes after synthetic mutable edits; null, empty and nonempty snapshot declarations conflict with request input | Local synthetic database lane; see PR for final run |
| Exact stored UTF-8 bytes, schema and revision identity | Producer and shared verifier; real diner adapter accepts matching DB-derived pointer and rejects tampered, old or wrong-revision bytes | Local synthetic transport; see PR for final run |
| Separate admission, approval and publication; foreign owner denied | Real restricted/admin database connections and owner commands in producer integration | Local synthetic database lane; see PR for final run |
| Replacement and withdrawal | Producer → pointer → diner integration and `tests/e2e/published-integrity.spec.ts` scheduled refresh | Browser PASS: 6 tests, including replacement, tamper and withdrawal; intercepted synthetic HTTP only |
| Hosted CLI and A→B acceptance | Existing staging operator, staff APIs, approved public Pages snapshots and actual diner | **BLOCKED:** no authenticated Wrangler session, producer database credential, owner session or independent release-exception approval available. No hosted publication or upload attempted. |
| Human security/content/release decisions | Independent human reviewers and release owner | **BLOCKED:** automated model assistance is not human sign-off; restaurant-approved live content not supplied. |

## Baseline and dependencies

Base `39e48fe0226445f7309be3dd28273da78b56f229` (`origin/develop`). Final head and its CI/review links belong in the PR body: committing those links here would change the head they describe. [PR #117](https://github.com/vivienk/peekaplate/pull/117) is the merged producer foundation, not this ticket's acceptance; [#25](https://github.com/vivienk/peekaplate/pull/25) and [#73](https://github.com/vivienk/peekaplate/pull/73) are merged prerequisites. Historical hosted checks in [#136](https://github.com/vivienk/peekaplate/pull/136) used synthetic transport and do not certify current restaurant content or this PR.

## Reproduction and observed results

Use Node 24.22.3 and pnpm 11.25.0 with `pnpm install --frozen-lockfile` (PASS). No staging credentials are used in the disposable local database lane.

- `pnpm exec vitest run backend/src/bundle-producer/produce.test.ts packages/contracts/src/public-menu-integrity.test.ts frontend/diner/src/menu/published.test.ts frontend/diner/src/menu/refresh.test.ts`: PASS, 4 files / 118 tests.
- `pnpm exec playwright test tests/e2e/published-integrity.spec.ts --workers=1`: PASS, 6 tests. Initial test attempt failed because a fixture name appeared twice in responsive markup; selectors were scoped to the interactive card before the passing run.
- `pnpm verify test:db`: PASS, 15 integration files / 173 tests plus all 16 pgTAP files and local demo. Earlier attempts timed out building the uncached Docker image and then failed because Chromium was missing; image preparation and browser installation resolved those prerequisites.
- `TEST_WORKERD=1 pnpm check`: PASS before the final test-only review corrections, including lint/typecheck, 2,045 Vitest tests, 118 script tests, context and documentation checks. An earlier run identified stale context fingerprints after the test changes; they were refreshed before the passing run. The later corrections were checked with the affected database/browser lanes, Biome, backend typecheck and context check; see final-head CI in the PR.
- `pnpm verify build`: PASS before the final test-only review corrections, including frontend builds and staging Worker dry-run. Existing build warnings include `:xr-overlay` and large chunks; no deployment occurred.
- Mutation scenarios are test-design criteria; mutation runs were not performed.

## Staging and authority

At 2026-11-17T16:29Z an anonymous synthetic missing-menu GET to the staging API returned 404. With origin `https://routing-staging.peekaplate-diner-staging.pages.dev`, the response included that exact `Access-Control-Allow-Origin` and `Vary: Origin`; with `https://denied.example.test` it returned no allow-origin header. This checks only that endpoint at that time, not the full deployed allowlist or assets. `backend/wrangler.jsonc` names the routing origin; [diner connection](../docs/diner-connection.md) records older synthetic snapshots and paused Queues, not their current live state. Active API/Pages version, actual Queue state and retention guarantee were not verified.

`pnpm --filter @peekaplate/backend exec wrangler whoami` reported unauthenticated. Producer database and owner token environment variables were absent. No tokens or private source files are recorded here. The release operator must supply approved task-owned synthetic revisions, corresponding T0 files, protected operator credentials, current owner authority, verified deployed versions/allowlists and an independent release exception before hosted execution. Use separate private output directories if `bundle_base_url` changes; verify identical exact bundle bytes and hashes before admission. Upload public assets and bundle only; never upload requests, handoff reports, source captures or credentials. Do not activate Queues or alter unrelated tenant records.

Snapshot-backed allergens preserve `null`, `[]` and approved values. Legacy unsnapshotted dishes fall back to restaurant-confirmed request declarations; the confirmation provenance for any particular legacy record must be established separately. Dietary codes and image alt also require restaurant confirmation. A T0 manifest verifies referenced files, not restaurant consent or capture rights. Pinned Pages snapshots must be retained; their long-term retention guarantee and owner require confirmation. Synthetic tests do not settle any of these human decisions.

## Independent review and task updates

Pinned prior producer review used base `2ffc32c9d01ef5db2647b972fc68adfa2ad80144` and head `8db815215b92bb2ec7e629b28943311bc4d50cd1`. Automated Standards review was incomplete (not all 33 changed files reviewed) and identified stale hash documentation and the immutable handoff-report output-directory constraint. Automated Spec review identified the remaining cross-boundary gap and confirmed current snapshot/verifier adoption. EGM model-assisted findings additionally flagged legacy declaration authority, hosted retention and the final-head evidence cycle; these are not independent human approvals. Final pinned-head security and correctness review outcomes belong in the PR body.

ClickUp task update: **NOT POSTED — access blocked.** The task-comments API returned `RATE_LIMIT_EXCEEDED` (100/100 daily calls); the prior browser fallback required login. Proposed update: link the PR and #117; report exact final-head CI, local synthetic results, the staging and human approval blockers above, and request an authorized release operator and independent reviewers. Do not claim restaurant acceptance or a new producer-backed review session on S3-RES-01.2.
