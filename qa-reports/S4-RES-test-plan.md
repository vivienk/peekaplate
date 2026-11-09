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
| S4-NEG / S4-NOINV | Unit cases cover duplicate IDs, unknown fields, label rejection, incomplete fields, asset revision mismatch and price precision. | PASS, local |
| S4-EXCL | Synthetic tests cover private fields, rejected reviews and cross-tenant DB reads on runtime and admin connections. | PASS, local |
| S4-RES02-1 / 2 | Synthetic producer → privileged admission → approval → publication → public read; URL and hashes match; bytes verify. Runtime admission denied. | PASS, local |
| CLI smoke | Real T0 preparation and disposable PostgreSQL: repeat build identical; price change produced new revision/hash; admission inserted then already-present; tampered variant and runtime admission rejected. | PASS, local |
| S4-DIN03-1 | Staging bundle/asset hosting, CORS and diner integration not exercised. | NOT RUN — requires staging deployment |
| S4-REPL-1 | Live atomic replacement not exercised. | NOT RUN — requires staging deployment |
| S4-WITH-1 | Local fresh public read returned 404 after withdrawal; staging UI/Worker not exercised. | PASS local; NOT RUN — requires staging deployment |
| S4-EVID-1 | Local evidence only; no merged PR, CI run or deployed version recorded. | INCOMPLETE — requires deployment and CI |
| AC-S6 | Stakeholder sign-offs remain outstanding; independent reviews are separate from approvals. | PENDING |

Deployment owner must provide approved HTTPS asset/bundle hosts and diner CORS origins. DIN-03 must adopt exact-byte verification. No real restaurant data was used.
