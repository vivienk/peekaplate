# Delivery plan

The foundation is PR 0. It establishes a place to build and verify PeekaPlate; it does not claim the pilot is complete. The product line stays: **3D is the hook. The loop is the product.**

## Current foundation and next tickets

Cloudflare staging pages, the Worker, Supabase and restricted staff-command access have been verified as recorded in [operations](operations.md). Consented shell events from both hosted pages also reached PostHog. The [private analytics export](posthog-export.md) is verified in staging: successful transfer, matching test records, duplicate-safe repeat and restricted access checks passed. Hourly exports are enabled. Teams can start design finalization, T0 menu UI, reviewed content/publication and event-contract tickets against this foundation. Owner reports must use the planned validated Supabase projections without waiting for hourly exports; agree and test freshness in the event/dashboard tickets. This is not a completed diner or owner product.

Diner fixtures/design, event definitions and manual preparation of three sample dishes can proceed in parallel. Publication follows the existing command boundary; real observations require approved publication; dashboard aggregates require validated observations. The restored [implementation plan](implementation_plan.md) supplies the controls, exact calculation proposals and dependencies. Provider verification does not imply these product flows are complete.

## The first sprint

One venue, one useful owner decision, a complete T0 menu and carefully selected T1/T2 dishes. T0 means normal photos and text. T1 adds shallow movement to reviewed photo cutouts. T2 separates real captured plating stages; it does not invent ingredients or unseen food. See [visual tiers](adr/0004-visual-tiers.md).

The source plan's gates are G1 October 19, G2 October 24, G3 October 28, G4 October 29 and readout November 1, 2026. Its cash budget is $375 with labor separate. These are planning constraints, not guarantees. The tech lead must rebaseline dates and vendor costs if a gate is missed; do not remove safety or evidence requirements to keep a date.

## PR order and acceptance

Keep each slice complete. Split an oversized slice into independently testable PRs while retaining the dependency order. The listed roles are responsibilities for the team to assign, not invented staff names.

| PR | Owner / depends on | Observable outcome | Required evidence |
| --- | --- | --- | --- |
| 0 · Repository foundation | Tech lead | Diner/console shells, health Worker, initial contracts, private schema, CI and agent guidance run locally | Unit/script tests, real Postgres constraints, browser smoke, build, context and links |
| 1 · Staff authority and command transaction | Backend lead / 0 | Authorized staff can create a dish revision using expected version and a stable command ID; live projection, receipt and outbox commit together | Real DB concurrent writers; cross-venue deny; stale version; crash rollback; identical retry; conflicting command ID; revoked actor retry |
| 2 · Capture, review and publication | Product + backend / 1 | Reviewer approves immutable capture/manifest; only approved revisions publish a hash-addressed T0 menu; withdrawal changes availability | Unauthorized approval denied; approve/publish race; immutable hashes; unavailable/offline behavior; replay causes no uploads or notifications |
| 3 · T0 diner and durable intent | Frontend + backend / 2 | Diner browses without WebGL/analytics; actual exposure is recorded; offline IDs survive reload and delete only after accepted receipts | Airplane/reload/reconnect; partial receipts; Queue failure; duplicate/conflicting IDs; create-only archive before index; DLQ recovery; retention/deletion |
| 4 · Ticket linkage and POS adapter | Data lead / 3 | Short-lived venue-bound redeem code links one session to its ticket; repeat import is idempotent | Cross-venue code rejected; expiry/collision; duplicate tickets; void/refund/timezone cases; unlinked outcomes stay unknown |
| 5 · T1 then selected T2 | Visual lead / 2; exposure via 3 | Tap loads Three.js 0.183.x behind `mount / update / dispose`; reviewed visual and fallback work on target phones | Initial graph excludes viewer; T0 JS ≤150 KB gzip; T1 incremental code+assets ≤400 KB; reduced motion, keyboard, WebGL loss, dispose/reopen, visual sign-off |
| 6 · Owner readout and experiment | Data + product / 4 | Owner sees linkage coverage and supported comparisons, then schedules one frozen blocked-switchback intervention | Assignment/exposure consistency; no individual attribution; unknowns explicit; cells under 10 sessions suppressed; uncertainty and carryover checks |
| 7 · Pilot release and recovery | Release lead / 3–6 | Named venue can complete the loop, recover from interruption and restore evidence | G3 restore/outage drill; independent backup; replay side-effect test; receipts/IDs/checksums reconcile; deletion reapplied; named alert responder |

PRs 4 and 5 may run in parallel after their prerequisites. Avoid a second database, graph service, Rust service or Python test layer for this TypeScript application. Add a pinned `uv` Python job and pytest only when a real capture-processing job lands with its own tests.

PR 1's implementation provides the staff-token boundary, membership authorization and dish command transaction. The October 18 staging checks verified a genuine Supabase session, authorized writes, retries/concurrency, cross-restaurant denial and membership revocation through the deployed API; remote probes covered restricted Hyperdrive access, context reset and rollback. See [operations](operations.md#staging-deployment-record) for evidence and limits. The login UI remains unimplemented, and logout does not immediately invalidate an issued access JWT. Session-lifetime policy, representative load and recovery checks remain pilot gates. No cloud credentials are needed for the local slice.

PR 1 must establish the complete tenant boundary: verify the session and active venue membership server-side, derive actor/venue/permissions there, then bind context inside the command transaction with transaction-local settings. Browser venue fields cannot grant authority. Use separate migration and runtime credentials; the runtime role must not own tables, be superuser or bypass RLS. Test missing/invalid identity, forged venue fields, cross-venue reads/writes, revoked membership on retry, and context reset after commit/rollback and pooled connection reuse using the deployed connection mode. Caller-set PostgreSQL settings alone do not authenticate a tenant: untrusted clients must never obtain that SQL role or an arbitrary-SQL endpoint.

## Next tickets from the deployed foundation

The infrastructure setup is no longer the first implementation task. Keep the current staging URLs and reuse the verified API, Supabase and Hyperdrive. The [team guide](team_guide.md#where-to-open-staging) explains those services. The [implementation plan on develop](https://github.com/vivienk/peekaplate/blob/develop/docs/implementation_plan.md) supplies detailed screens, events and formulas; confirm its source decisions before coding. Its earlier infrastructure-status statements are superseded by the [October 18 deployment record](operations.md#staging-deployment-record).

These are proposed ticket boundaries, not assigned work or additional completed features. The numbers below describe dependency order, not existing GitHub PR numbers. Split a ticket further if it cannot be independently reviewed within a weekly sprint.

| Ticket | Type / people needed | Demonstrable result | Start and merge dependency |
| --- | --- | --- | --- |
| 1. Sign in and save a dish draft | Implementation; frontend and backend developers, with product/QA acceptance review | A permitted staff member signs in, saves through the existing API and sees useful expiry, denial, retry and conflict states. Include the browser-to-API connection configuration and tests. | Start now. Merge the complete tested flow before publication integration. |
| 2. Prepare three dishes and agree review rules | Content/research; restaurant/product contributor and design/visual contributor, with developer consultation | Rights-cleared photos, verified dish facts and explicit rules for incomplete information, approval and withdrawal. Richer assets are prepared manually. | Start alongside 1. Content/review decisions must precede publication acceptance. Expand toward roughly 20 T0 dishes after the first three work. |
| 3. Build diner screens from the design | Design + implementation; designer and frontend developer | Clearly labelled fixture menu, details, ingredient panel, side-by-side comparison and owner-entry link, including loading/error/keyboard/fallback states. | Start alongside 1–2. Fixture UI may merge independently; real content integration waits for 4. |
| 4. Review, publish and withdraw approved content | Implementation; backend and frontend developers, with product/QA review | Authorized review of exact source/assets; immutable approved menu versions; drafts stay private; withdrawal prevents fresh reads. Connect private file storage and approved delivery with this work. | Use 1's authority boundary and 2's decisions. Publication must merge before the real diner exposure flow. |
| 5. Agree events and metric examples | Research + contract implementation; measurement/product contributor and developer | Map every relevant control, including ingredients and comparison, to agreed event meaning, eligibility, version references and formula examples. Unknown outcomes remain unknown. | Start now with 2–3. Merge accepted contracts before instrumentation/ingestion; do not invent metrics from available clicks. |
| 6. Connect the published menu and reliable tracking | Implementation; frontend and backend developers, with QA | Real approved menu, actual exposure references, offline-safe retry, Queue acceptance, private R2 archive, database indexing and failed-message recovery; browsing survives tracking failure. | Integrate after 3–5. Smaller collector/consumer components may develop earlier using agreed fixtures. |
| 7. Show verified owner evidence | Implementation + analysis; backend/frontend developers and measurement/product contributor | Secure browsing metrics calculated from reconciled records, with coverage and unknowns. Outcome metrics require a separately verified ticket/POS linkage slice. | Report layout and formula tests can start now. Merge live browsing reports after 6; merge outcome reports after linkage. No mocked sales claims. |
| 8. Validate pilot operation and recovery | Verification/operations; developer/operator and product/QA contributor | Real-phone checks, session policy, load evidence, backup restore, retention/privacy, budget alerts and named incident response; production receives separate resources and approval. | Plan now; accept only after the required connected flows. Optional T1/T2 work follows approved assets and exposure, parallel to linkage/report work. |

Turn this sequence into weekly Tuesday-to-Tuesday sprint tickets within the requested 15–20-day window, with effort estimates and reviewer time based on confirmed capacity. Keep assignments open until agreed. Sai and Vivien review code; Mohammad and Marwan are part of the available developer pool, subject to confirmed availability. Product, research and design work does not require every contributor to be a developer.

Each ticket records source links, owned paths, observable acceptance examples, estimated days, required roles, prerequisite tickets and PR merge order **within its week**. Prepare the ticket pack for agreement before creating or assigning ClickUp tasks. The first checkpoint is three dishes moving through staff review to a real T0 menu; the broader outcome-linked pilot still requires the gates below.

## Gate decisions

- **G1:** capture and truthfulness rules signed off; approved T0 content exists. No generated edible surfaces.
- **G2:** core menu-to-ticket path demonstrated; selected visuals meet measured device and payload limits. Switch optional visuals off if they fail.
- **G3:** interruption, duplicate delivery, restoration and replay drills pass. Broken tenant isolation, approval, withdrawal or linkage blocks the pilot.
- **G4:** venue, operator, retention, consent wording and runbook ready. Record known limitations and who can stop the pilot.
- **Readout:** show observed sample and linkage coverage. Do not claim causal lift from a convenience comparison or treat a ticket as proof of an individual's intent.

## Evidence ledger

Each PR records exact commands and results in the PR template. Keep run URLs there rather than copying volatile green badges into architecture docs. A shell test proves the shell; a schema test proves its tested constraints. Neither proves authentication, ingestion, replay, phone performance or production readiness.

`ci` is the stable required-check name. Quality checks always run; database and browser lanes are selected by changed paths. A warm ordinary PR aims for under five minutes; measure hosted runs before adding caches or a monorepo task runner. CI cannot judge whether prose is truthful, so documentation/context checks complement human review.
