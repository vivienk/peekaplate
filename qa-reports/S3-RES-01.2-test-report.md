# S3-RES-01.2 QA test plan and report

Pull request: [vivienk/peekaplate#73](https://github.com/vivienk/peekaplate/pull/73)
ClickUp: [86bcquqr3](https://app.clickup.com/t/86bcquqr3)
Branch: `feat/s3-res-01-2-review-api`. Rebased on `origin/develop` `d6e5a16`, from `d341c86`. The backup is `backup/feat/s3-res-01-2-review-api-pre-rebase-2026-11-06`.

This plan was written and committed **before** any fix, any new test run, or any run of the application. The single exception was the post-rebase baseline gate required by the spec. Actual/Status columns were filled in by the follow-up results commit. Status values: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

## Scope

The plan covers the three open review findings on PR #73 and a black-box regression of the review API after the rebase:

- **A** (`@hemu77`, `review-artifact.ts:94`): segments and diagnostics are not bound to the stored producer report.
- **B** (`@hemu77`, `review-command.ts:538`): the command hash conflates an omitted `reviewNote` with an explicit `null`.
- **C** (`@TeeyanshShukla`, `review-command.ts:650`): `mark_incomplete` keeps the incomplete fields in the active corrections.

Data: synthetic fixtures only (`processing/tests/fixtures/review-candidates/*`). No real menu, user or tenant data.

## Rebase baseline (executed before this plan)

| Check | Result |
|---|---|
| `pnpm verify lint typecheck test build context:check docs:check` on the rebase resolution | exit 0. Biome 280 files; Vitest 49 files, 815 passed / 4 skipped; `node --test` 67/67 |

## Acceptance criteria

| ID | Criterion | ClickUp AC traced |
|---|---|---|
| AC-R1 | Every T-A, T-B and T-C test fails before its fix and passes after. Positive cases T-A5 and T-B2 pass both before and after. | Validation and retry behaviour specified and tested |
| AC-R2 | A stored producer bundle cannot be paired with a request whose segments, segment status/error, warnings, errors or box links differ from what the exporter produces from that bundle. Any such request returns 409 `artifact_mismatch`; the untouched export verifies. | Returns draft candidates and source evidence under the approved contract |
| AC-R3 | A `commandId` reused with different field presence (omitted vs `null`) returns 409 `command_conflict`. An identical retry replays the stored receipt. | Retry behaviour |
| AC-R4 | After `mark_incomplete`, no field is both incomplete and corrected. `editedFields` always equals the sorted keys of `corrected`. A request listing a field in both `corrected` and `incompleteFields` returns 400 `invalid_candidate` and writes nothing. | Corrections and incomplete markers with original vs edited fields preserved |
| AC-R5 | `pnpm verify lint typecheck test build context:check docs:check pr:check` passes. | CI evidence |
| AC-R6 | `pnpm test:db` passes against real PostgreSQL, including the new database-backed cases. | Tenant/authorization denial, save/reload |
| AC-R7 | Every R-API case passes against the running local Worker and PostgreSQL, or is `BLOCKED` with evidence. | Save/reload, negative tests, request/response examples |
| AC-R8 | An independent reviewer agent reports no open P1/P2 issues on the diff against `origin/develop`. | Independent review |

## Automated tests (written first, TDD)

| ID | Finding | File | Case | Expected | Red before fix | Green after fix |
|---|---|---|---|---|---|---|
| T-A1 | A | `backend/src/review-artifact.test.ts` | Failed and skipped segments removed from the request; stored bundle and hash unchanged | 409 `artifact_mismatch` | FAIL `'ok'` ≠ 409 | `PASS` |
| T-A2 | A | same | Request `errors` cleared | 409 | FAIL `'ok'` | `PASS` |
| T-A3 | A | same | Request `warnings` cleared | 409 | FAIL `'ok'` | `PASS` |
| T-A4 | A | same | Failed segment rewritten to `status: ready`, `error: null` | 409 | FAIL `'ok'` | `PASS` |
| T-A5 | A (positive) | same | Untouched exporter output verifies. A box-evidence report/export pair whose only request-side difference is the exporter's `metadata.candidate_box_evidence` also verifies. | `ok` before and after | PASS (positive) | `PASS` |
| T-A6 | A | same | The same box-evidence pair with a forged `candidate_box_evidence` link (moved to another candidate or with a changed box) | 409 | FAIL `'ok'` | `PASS` |
| T-B1 | B | `backend/src/review-command.test.ts` | `correct` with no `reviewNote` on a row noted `'Retained note'` keeps the note. The same `commandId` with `reviewNote: null` returns 409 `command_conflict`, with no write. | as stated | FAIL: promise resolved (replayed receipt) | `PASS` |
| T-B2 | B (positive) | same | Identical retry (same payload, same field presence) | Stored receipt returned unchanged; no new write | PASS (positive) | `PASS` |
| T-B3 | B | same | New `commandId` with `reviewNote: null` | Note cleared to `null` | PASS (behaviour guard; fresh null already cleared) | `PASS` |
| T-B4 | B (schema) | `packages/contracts/src/review-persistence.test.ts` | `ReviewCandidateCommandSchema` keeps an omitted `reviewNote` absent and an explicit `null` present | `'reviewNote' in parsed` false/true | PASS (schema already keeps presence) | `PASS` |
| T-C1 | C | `backend/src/review-command.test.ts` | Correct `price_amount` and `name`, then `mark_incomplete ['price_amount']` with no `corrected` | `incompleteFields=['price_amount']`, `corrected={name}`, `editedFields=['name']` | FAIL corrected kept `price_amount` | `PASS` |
| T-C2 | C | same | Event-stream replay (`replayCandidateReview`) after T-C1 | Same record as the T-C1 response | FAIL projection kept `price_amount` | `PASS` |
| T-C3 | C | same | `corrected.price_amount` together with `incompleteFields ['price_amount']` | 400 `invalid_candidate`; no write | FAIL: promise resolved (200) | `PASS` |
| T-DB-1 | C | `backend/src/dish.integration.ts` | Real Worker and PostgreSQL: correct, then `mark_incomplete` the corrected field, then GET reload | Same state as T-C1 in the response and on reload | not run before fix | `PASS` |
| T-DB-2 | B | same | Real Worker and PostgreSQL: omitted-note command, then the same id with `null` → 409; then a fresh id with `null` → note cleared on reload | as stated | not run before fix | `PASS` |

## Application-level QA (running Worker)

Setup: `pnpm dev:backend` starts the real Worker (`wrangler unstable_dev`, `APP_ENV=local`), a disposable PostgreSQL with all migrations, and a local JWKS issuer. It writes `work/local-session.json` (origin, venue, actor and a signed staff JWT). A driver script (`backend/work/qa-res012/qa_api.mjs`, not committed; it starts the same stack as `pnpm dev:backend` and adds a local R2 binding seeded with the producer bundle) sends real HTTP requests using the v2 fixture.

| ID | ClickUp AC | Steps | Expected | Actual | Status |
|---|---|---|---|---|---|
| R-API-1 | returns candidates and evidence | `PUT …/review-session` with `representative-candidates-v2.json` | 200; 3 items, all `pending`, `version 0`, `published:false`; originals and evidence equal the request | 200; items=3; statuses=pending/v0,pending/v0,pending/v0; published=false; originals equal=true | `PASS` |
| R-API-2 | retry | Identical PUT retry; then the same `commandId` with a changed candidate name | 200 with an identical body; then 409 `command_conflict` | retry 200 identical=true; reuse 409 {"error":"command_conflict"} | `PASS` |
| R-API-3 | save/reload | `GET …/candidates` | Equals the R-API-1 body | 200 equal=true | `PASS` |
| R-API-4 | correction and attribution | `correct` soup `{name, price_amount}` at `expectedVersion 0` with `reviewNote 'Retained note'` | v1; `editedFields ['name','price_amount']`; `reviewedBy` = session actor; original unchanged; `effective` shows the corrections | 200; v1; edited=["name","price_amount"]; reviewedBy=actor; original=Garden Soup/null; effective=Organic Garden Soup/9.50 | `PASS` |
| R-API-5 | stale version | New `commandId`, `expectedVersion 0` | 409 `version_conflict` | 409 {"error":"version_conflict"} | `PASS` |
| R-API-6 | Finding C | `mark_incomplete ['price_amount']` at v1, no `corrected`; then GET | `incompleteFields ['price_amount']`; `corrected {name}`; `editedFields ['name']`; `effective.price_amount` back to the original; reload identical | 200; status=incomplete; incomplete=["price_amount"]; corrected={"name":"Organic Garden Soup"}; edited=["name"]; effective.price_amount=null; reload identical=true | `PASS` |
| R-API-7 | Finding C | Overlapping request at v2 | 400 `invalid_candidate`; GET shows v2 unchanged | 400 {"error":"invalid_candidate"}; reload v2 | `PASS` |
| R-API-8 | Finding B | Coffee: `correct` with note at v0; omitted-note `correct` at v1 (note kept); same `commandId` with `reviewNote:null` → 409; identical retry → 200 with the same receipt; new `commandId` with `null` at v2 → note cleared | as stated | seed 200; omitted 200 note=Retained note; reuse-null 409 {"error":"command_conflict"}; retry 200 same=true; new-null 200 note=null; reload note=null v3 | `PASS` |
| R-API-9 | rejection | `reject` bread | `reviewStatus rejected`; `corrected {}`; `publishable false` | 200; rejected; corrected={}; publishable=false | `PASS` |
| R-API-10 | tenant/auth denial | GET with no token; GET with a malformed token; GET another venue's path with the session token | 401; 401; 403 `forbidden` | 401; 401; 403 {"error":"forbidden"} | `PASS` |
| R-API-11 | validation | Unknown `action`; review body over 16 KB; `text/plain` body; path `extraction_id` mismatch on PUT | 400 `invalid_request`; 413 `body_too_large`; 415 `unsupported_media_type`; 400 | 400 {"error":"invalid_request"}; 413 {"error":"body_too_large"}; 415 {"error":"unsupported_media_type"}; 400 {"error":"invalid_request"} | `PASS` |
| R-API-12 | Finding A | Seed the producer bundle (`representative-extraction-v2.json` plus scope) into the Worker's local R2. PUT with `jobId` and `privateArtifactRef`: untampered → 200; failed segment dropped → 409; errors cleared → 409 | as stated (`BLOCKED` with evidence if local R2 cannot be seeded) | seed=true; dropped 409 {"error":"artifact_mismatch"}; errors 409 {"error":"artifact_mismatch"}; untampered 200 ref=true | `PASS` |
| R-API-13 | publication isolation | After all commands, `published` stays `false` on GET | `published:false` | published=false | `PASS` |

## Results

Environment: Windows 10.0.26200 x64, Node.js 24.16.0, pnpm 11.25.0, wrangler 4.149.0 (`unstable_dev`, local workerd), Docker 29.6.1 with the repository PostgreSQL image (`tests/db/Dockerfile`). Data: synthetic v2 fixtures only.

### Commits

| Commit | Content |
|---|---|
| `5037d26` | Rebase: net change of the `c005b0f` reconciliation plus `d341c86`, replayed on `d6e5a16` |
| `6ddc328` | This plan (committed before any fix or application run) |
| `8595645` | Finding A fix + T-A1..T-A6 |
| `c4f6bc8` | Finding B fix + T-B1..T-B4 |
| `1c77a81` | Finding C fix + T-C1..T-C3 + T-DB-1 |
| `e5d2284` | T-DB-2 |

### Automated checks

| Check | Result | Status |
|---|---|---|
| Red run, Finding A tests on the pre-fix verifier | 5 failed (T-A1..T-A4, T-A6) / 9 passed (T-A5 and existing) | expected red |
| Red run, Findings B/C tests on the pre-fix command | 4 failed (T-B1, T-C1, T-C2, T-C3) / 29 passed | expected red |
| `pnpm verify lint typecheck test build context:check docs:check pr:check` | exit 0. Biome 280 files; Vitest 49 files, 828 passed / 4 skipped (baseline 815, +13 new); `node --test` 67/67; context 12 modules / 10 handoffs; 54 Markdown files; `pr:check` not applicable locally | `PASS` |
| `pnpm verify test:db` | exit 0. pgTAP 213 assertions across 9 suites (including `review_persistence.sql` 21); integration Vitest 5 files, 75 passed (includes T-DB-1 and T-DB-2) | `PASS` |

T-B3 and T-B4 passed before the fix. A fresh `commandId` with `reviewNote: null` already cleared the note, and the contract already keeps omitted keys absent. Both are kept as guards for the behaviour the fix depends on, not as red-first regressions.

### Application QA: before vs after the fixes

The same driver was run against the pre-fix sources (`git checkout 6ddc328 -- backend/src/review-artifact.ts backend/src/review-command.ts`) and then against the fixed head.

| Case | Pre-fix | Fixed |
|---|---|---|
| R-API-6 | `FAIL`: `corrected` kept `price_amount`, `effective.price_amount=9.50` | `PASS` |
| R-API-7 | `FAIL`: 200, overlapping request saved | `PASS` |
| R-API-8 | `FAIL`: `commandId` reuse with `reviewNote:null` returned 200 and the old receipt | `PASS` |
| R-API-12 | `FAIL`: the first registration with dropped failed/skipped segments returned 200 and was stored; the honest export was then refused with `409 extraction_conflict` | `PASS` |
| All other R-API cases | `PASS` | `PASS` |

Tally after the fixes: 13 `PASS`, 0 `FAIL`, 0 `BLOCKED`, 0 `NOT RUN`.

QA note Q-1 (test design, not a product defect): the first draft of R-API-12 tampered after an honest registration of the same extraction. The tampered requests were then refused by `extraction_conflict` and never reached the verifier, so the case could not tell the fixed code from the broken one. The case now uses a never-registered venue. In that setup the pre-fix run reproduces Sai's finding end to end.

### Open items (outside this PR)

- Staging save/reload with a real `jobId` + `private_review_artifact` from the extraction host (RES-01.3/01.4).
- S3-ARC-01 contract alignment and independent re-review by `@hemu77` / `@TeeyanshShukla`.
- Command receipts stored before `c4f6bc8` hash differently and will not replay. Acceptable because nothing is deployed.
