# S4-RES QA execution record

**Base:** `2da95ad` · **Branch:** `feat/s4-res-bundle-producer` · [Task](https://app.clickup.com/t/86bct99xa) · [Producer contract](../docs/s4-res-bundle-producer.md)

Local evidence is synthetic; it does not establish staging readiness or stakeholder approval.

| ID | Actual | Status |
|---|---|---|
| S4-AUTO-1 | Contracts integrity fixture: 5 tests passed; direct SHA-256 matched expected hash. | PASS, local |
| S4-AUTO-2 | `pnpm verify test:db`: 213 pgTAP assertions and 84 integration tests passed in 6 files. An earlier run timed out in an unrelated team analytics test; the subsequent full runs passed. | PASS on retry, local |
| S4-BLD-1 | In-memory synthetic bundle: two complete dishes and one identity-only placeholder, with IDs, dimensions, alt and URLs checked. | PASS, local |
| S4-HASH-1 | Exact canonical bytes verified before parsing; tamper, invalid UTF-8, JSON and schema rejected. | PASS, local |
| S4-IDEM-1 | Repeat builds and CLI runs produced identical bytes and handoff output. | PASS, local |
| S4-VER-1 | Content/URL changes alter revision and hash; a digest-only change at the same URL changes only asset hash/approval and conflicts at admission. Immutable asset hosting is required. | PASS for approved formula; same-URL mutation prohibited |
| S4-NEG / S4-NOINV | Unit cases cover duplicate IDs, unknown fields, label rejection, incomplete fields, asset revision mismatch, price precision, and ingredient length/count/NUL boundaries. Invalid ingredients produce an identity-only placeholder. | PASS, local |
| S4-EXCL | Synthetic tests cover private fields, rejected reviews and cross-tenant DB reads on runtime and admin connections. | PASS, local |
| S4-RES02-1 / 2 | Synthetic producer → privileged admission → approval → publication → public read; URL and hashes match; bytes verify. Runtime admission denied. | PASS, local |
| CLI smoke | Real T0 preparation and disposable PostgreSQL: repeat build identical; price change produced new revision/hash; admission inserted then already-present; tampered variant and runtime admission rejected. | PASS, local |
| S4-DIN03-1 | Staging bundle/asset hosting, CORS and diner integration not exercised. | NOT RUN — requires staging deployment |
| S4-REPL-1 | Live atomic replacement not exercised. | NOT RUN — requires staging deployment |
| S4-WITH-1 | Local fresh public read returned 404 after withdrawal; staging UI/Worker not exercised. | PASS local; NOT RUN — requires staging deployment |
| S4-EVID-1 | Local evidence only; no merged PR, CI run or deployed version recorded. | INCOMPLETE — requires deployment and CI |
| AC-S6 | Stakeholder sign-offs remain outstanding; independent reviews are separate from approvals. | PENDING |

Deployment owner must provide approved HTTPS asset/bundle hosts and diner CORS origins. DIN-03 must adopt exact-byte verification. No real restaurant data was used.

## PR #117 local QA — 2026-11-09

Pinned local HEAD `f62c502d29a39574c919c47d46474cf0444d209a`; regression tests and review vectors are uncommitted. The earlier rows are historical evidence, not reruns at this pin.

| Check | Current result |
|---|---|
| Uppercase UUID normalization; zero categories; malformed and NUL UUID; mixed-case duplicate dish | PASS — focused producer and integrity run: 63 tests across two files. Empty categories produce no diagnostics and verify against the shared schema and exact-byte integrity. |
| Five supplied synthetic, proposed vectors | PASS — original and repeat accepted; same-value reformatted and changed-name bytes rejected by hash; matching-hash wrong revision rejected by delivery identity. All four file lengths and SHA-256 values match the supplied manifest. |
| `TEST_WORKERD=1 pnpm check` | FAIL exit 1 at `context:check`: contracts fingerprint is stale after the integrity test edit. Lint and typecheck passed; 1,052 Vitest tests and 67 script tests passed, including the four workerd cases. `pnpm docs:check` separately passed. Refreshing `docs/CONTEXT.md` is outside the requested QA-record-only documentation scope. |
| `pnpm verify test:db` | PASS after starting Docker Desktop: 213 pgTAP assertions across nine suites, 84 integration tests across six files, and local Worker smoke; initial attempt failed before database creation. |
| Python offline suite | PASS: 476 tests; offline socket guard recorded no unexpected network attempts. |
| `pnpm verify build`; `uv build --project processing` | PASS: both exit 0; Worker dry-run and Python wheel/sdist only, no deployment. |
| Playwright default / intercepted PostHog / review preview | PASS: 78 / 9 / 6 tests, respectively, each exit 0 and one worker. |
| Synthetic T0 preparation | PASS: two 1,600×1,200 synthetic JPEGs prepared; manifests say `needs_review`, `publication_eligible: false`. |
| CLI asset privacy/integrity negative checks | PASS: changed WebP byte and `source.jpg` manifest substitution rejected, each exit 1. A disposable-DB corruption check confirmed zero subject and bundle rows for the new menu. |
| Producer/DB/HTTP smoke | PASS for exercised synthetic journey: repeat CLI builds, two complete dishes and identity-only placeholder, loopback exact-byte/identity rejection, repricing, idempotent admission, runtime denial, cross-tenant rejection and immutable overwrite denial. One subject and bundle, zero approvals/publications. |

The workerd-enabled run reported no skips. The DB integration suite ran separately in `test:db`. Hosted CI, real restaurant approval/content, external hosting and approved CORS, DIN-03 end-to-end consumption, physical-device checks and stakeholder acceptance remain NOT RUN/BLOCKED. The exact-byte rule remains proposed pending consumer agreement; `publicationHash` is unchanged.

## Synced-develop verification — 2026-11-09

Merged `origin/develop` at `93194f2772e79958a6edf6ccd02ebf3094cf8d53` and reconciled the fork PR head `d3ea003a59d5f4cbb1dc6ea10d06810d70a2909c`, whose kickoff patch matches local `4183db4`. The earlier context failure was resolved by refreshing merged source fingerprints.

| Check | Result |
|---|---|
| `TEST_WORKERD=1 pnpm check` | PASS: lint, typecheck, 1,052 Vitest tests, 67 script tests, context and docs checks. |
| `pnpm verify test:db` | PASS: 213 pgTAP assertions, 84 integration tests and local Worker smoke. |
| `pnpm verify build` | PASS: frontend builds and Worker dry-run; no deployment. |
| `pnpm exec playwright test tests/e2e/input.spec.ts --workers=1` | PASS: 14 browser tests for the newly merged TextField. |

Prior synthetic producer/HTTP, Python offline and other browser results above were observed before this sync; they do not establish hosted or stakeholder acceptance.

## Producer review fixes — 2026-11-09

Independent review found that corrected candidate reviews could retain incomplete fields while the producer treated them as complete, and that unrepresentable descriptions or currencies aborted an entire bundle. The corresponding regression cases failed before the fixes and passed afterward.

| Check | Result |
|---|---|
| `TEST_WORKERD=1 pnpm check` | PASS after fixes: 1,057 Vitest and 67 script tests, lint, types, context and docs. |
| `pnpm verify test:db` | PASS after fixes: 213 pgTAP assertions, 85 integration tests and local Worker smoke. |
| `pnpm verify build` | PASS after fixes: frontend builds and Worker dry-run. |
| `pnpm verify test:e2e` | PASS after fixes: 87 default and 9 intercepted PostHog browser tests. |
| Synthetic CLI/DB/HTTP smoke | PASS after fixes: repeated bytes, repricing, admission, identity/hash rejection, runtime/tenant isolation and overwrite checks. Corrupted-asset admission separately produced zero handoff rows. |

The earlier browser, Python and asset results remain scoped to the versions and conditions noted above; they are not hosted or restaurant approval.
