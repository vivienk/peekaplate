
# DATA-12 — Owner Report Validation Evidence Ledger

## 1. Purpose

Validate the Sprint 5 staging journey from approved menu publication
through consented diner interaction, PostHog capture, canonical durable
persistence, and authorized owner reporting.

PostHog and canonical delivery are independent required destinations.

This ledger separates local test evidence from real staging evidence.
Local fixtures and mocked tests cannot certify staging acceptance.

## 2. Ownership and review

- Integration coordinator: Jeffin
- Expected/actual reconciliation: Uneeza
- Independent privacy/security reviewer: Sai
- Product alignment: Vivien and Adam
- Final acceptance: Pending

## 3. Environment and provenance

| Field | Recorded value |
| --- | --- |
| Environment | Staging — execution pending |
| Approved test venue | Pending confirmation |
| Menu publication revision | Pending |
| Frontend deployed SHA/version | Pending |
| Worker deployed SHA/version | Pending |
| Schema/contract version | `observation.v2` (develop `ae472fb`); deployed version pending |
| Approved PostHog project | Pending |
| Approved PostHog host | Pending |
| PostHog environment | Pending |
| Test classification | Pending |
| Consent state | Pending |
| Run timestamp (UTC) | Pending |
| Redacted correlation IDs | Pending |

Never record access tokens, raw diner identities, credentials,
unapproved personal properties, or raw event bodies.

## 4. Local validation results

| Check | Expected | Actual | Status |
| --- | --- | --- | --- |
| 9-session threshold | Behavioral metrics suppressed | Passed | PASS |
| 10-session threshold | Eligible metrics available | Passed | PASS |
| 11-session threshold | Correct metric calculations | Passed | PASS |
| Smaller eligible cohorts | Affected metrics suppressed | Passed | PASS |
| Zero versus unmeasurable | Distinct statuses preserved | Passed | PASS |

Evidence:
- Test: backend/src/owner-report.data12.test.ts
- Command: npx.cmd vitest run backend/src/owner-report.data12.test.ts
- Result: 5 passed, 0 failed
- Test type: Mocked aggregate-row unit tests
- Date: 2026-11-12

These tests do not independently validate underlying SQL session
aggregation or prove a real staging report.

## 5. Staging expected-versus-actual ledger

| Check | Expected | Actual | Status |
| --- | --- | --- | --- |
| Approved menu revision | Published revision matches diner menu | Not collected | PENDING |
| Consented diner action | Approved action emitted once | Fixture: one live consented event reaches both destinations once (T2, T6) | FIXTURE PASS; LIVE PENDING |
| Shared event identity | Approved correlation identity matches | Fixture: PostHog uuid = canonical event_id (T2, T6) | FIXTURE PASS; LIVE PENDING |
| PostHog capture | Approved event and properties only | Fixture: only allowlisted fields; SDK automatic collection off (T3, T6) | FIXTURE PASS; LIVE PENDING |
| Canonical receipt | Approved event ID acknowledged | Fixture: route accepts only after Queue send; mixed receipts; 503 without receipts (T4) | BLOCKED: queues paused (unblock date pending Sai) |
| Durable archive | Event persisted durably | Fixture: R2 archive before database write before ack (T5) | BLOCKED: queues paused (unblock date pending Sai) |
| Durable index | Event indexed once | Fixture: duplicate event ID acknowledged without a second row (T5) | BLOCKED: queues paused (unblock date pending Sai) |
| Typed fact | One valid typed fact | Not collected; needs consumer run on staging | BLOCKED: queues paused (unblock date pending Sai) |
| Report reconciliation | Independently calculated eligible counts match | Not collected | PENDING |
| Owner access | Authorized owner can read report | Not collected | PENDING |
| Tenant denial | Other tenant cannot read report | Not collected | PENDING |
| Revoked access | Revoked owner cannot read report | Not collected | PENDING |
| Replay | Same event identity; one durable fact | Fixture: same event_id and payload resent; consumer dedupes (T1, T4, T5) | BLOCKED: queues paused (unblock date pending Sai) |
| Canonical retry | No additional PostHog capture | Fixture: canonical retries never capture to PostHog again (T2, T6) | FIXTURE PASS; LIVE PENDING |
| PostHog failure | Canonical path remains independent | Fixture: PostHog failure never stops canonical delivery (T2) | FIXTURE PASS; LIVE PENDING |
| Canonical failure | PostHog path remains independent | Fixture: canonical failure never stops PostHog capture (T2) | FIXTURE PASS; LIVE PENDING |
| Offline/reload/reconnect | No duplicate durable fact | Fixture: offline keeps events; reload keeps pending event; retry keeps identity (T1, T6) | FIXTURE PASS; LIVE PENDING (durable side blocked) |
| No consent | Neither destination sends or queues | Fixture: consent denied by default sends nothing to either destination (T2, T6) | FIXTURE PASS; LIVE PENDING |
| Consent declined/ignored | Neither destination sends or queues | Fixture: gate off and privacy signal (GPC) send nothing (T2, T6) | FIXTURE PASS; LIVE PENDING |
| Withdrawal | Applicable pending sends stopped | Fixture: withdrawal stops new capture and pending sends; in-flight send not retried (T2, T6, T7) | FIXTURE PASS; LIVE PENDING |
| No pre-consent backfill | Earlier actions never replayed | Fixture: earlier actions never replayed after opt-in (T2, T3) | FIXTURE PASS; LIVE PENDING |
| Fixture network silence | No real destination traffic | Fixture: fixture mode sends no tracking or observation request (T2, T6) | FIXTURE PASS; LIVE PENDING |
| Storage-blocked Save/Unsave/Undo | Unmeasured behavior preserved | Fixture: failed Save storage emits no Save/Unsave success event; memory fallback works (T6, T7). Undo not covered | FIXTURE PASS (Save/Unsave only); LIVE PENDING |
| Identity lifecycle | Approved lifecycle verified | Not collected | PENDING |
| Retention/withdrawal | S5-DATA-09 evidence verified | Not collected | PENDING |
| Report suppression | Real visit may remain suppressed | Not collected | PENDING |
| Report freshness | Stale and unknown states preserved | Not collected | PENDING |
| Report semantics | Browsing never represented as orders | Not collected | PENDING |

## 6. Independent reconciliation

For each approved dish and reporting window, record:

- Approved dish and publication revision
- Window start/end in UTC
- Distinct exposed sessions
- Distinct exposed-and-opened sessions
- Distinct open-eligible sessions
- Distinct engaged sessions
- Distinct exposed sessions with direct saves
- Distinct timed sessions
- Total openings and finalized openings
- Independently calculated expected metrics
- Actual report API metric values and statuses
- Actual report UI values and statuses
- Difference and explanation

Do not infer counts from raw event totals.
Do not expose suppressed cohort counts in owner-facing evidence.
Do not lower privacy thresholds or insert test sessions into live
owner populations to obtain numeric metrics.

## 7. Evidence references

| Evidence | Reference | Status |
| --- | --- | --- |
| Local test output | Terminal result, 5/5 passed | Available |
| Frontend/Worker/schema versions | Pending | PENDING |
| Browser network evidence | Pending | PENDING |
| PostHog approved event evidence | Pending | PENDING |
| Canonical receipt | Pending | PENDING |
| Durable archive/index/typed fact | Pending | PENDING |
| Report API response | Pending | PENDING |
| Owner report UI evidence | Pending | PENDING |
| Independent Sai review | Pending | PENDING |

Store only redacted evidence and safe correlation references.

## 8. Dependency hold

TRK scope/adapter ownership was proposed by Adam on the S6-TRK-03 ticket
(2026-11-14): Jeffin owns the TRK adapter evidence, Sai reviews, Ehab runs
the phone journey, Nifemi builds the consent UI and Uneeza runs independent
acceptance. Vivien's and Sai's confirmations are pending.

Prepare local tests and documentation now.

Do not execute dependent staging acceptance until alignment and
compatible deployments are confirmed.

This work does not change TRK ownership or create/assign a consent ticket.

## 9. Acceptance status

Local DATA-12 threshold tests: PASS (5/5)

Real staging journey: PENDING

PostHog and canonical durable persistence: PENDING
(S6-TRK-03 fixture checks pass; live and durable checks pending, see section 10)

Independent reconciliation: PENDING

Sai review: PENDING

Overall DATA-12 acceptance: NOT YET ESTABLISHED

## 10. S6-TRK-03 — consented delivery and PostHog evidence

Ticket: S6-TRK-03 (prove consented canonical delivery and PostHog
ingestion end-to-end). TRK adapter evidence: Jeffin. Reviewer: Sai.

### 10.1 What this section proves and what it does not

Every result below is **fixture** evidence: local unit and browser tests
with mocked destinations, run on `develop` at
`ae472fb50517c4209b6c806489680df6dfc72cfa` (2026-11-14). It shows the
code behaves as the checks in section 5 expect. It is **not** live
staging evidence: no real PostHog project, staging Worker, Queue, R2
bucket or database was used, and no event left the test machine.

### 10.2 Fixture evidence references

| Ref | Test file | What it covers |
| --- | --- | --- |
| T1 | `frontend/diner/src/tracking/delivery.test.ts`, `delivery.fixtures.test.ts` | Receipts, duplicate and conflict handling, 400/401/413/429/503, expired menu token, token only in the Authorization header, same `event_id` on retry |
| T2 | `frontend/diner/src/tracking/dispatch.test.ts` | Consent gate, privacy signal, fixture mode, both destinations once with one `event_id`, independent failures, withdrawal without backfill |
| T3 | `packages/analytics/src/posthog.test.ts` | No SDK before consent, no pre-consent replay, allowlisted fields only, automatic collection off, at most once per `event_id` |
| T4 | `backend/src/index.test.ts` (`/observations` cases) | Token-derived authority, accept only after Queue send, mixed receipts, 503 without receipts, throttling, in-batch conflicts, repeated deliveries |
| T5 | `backend/src/consumer/queue-consumer.test.ts`, `r2-storage.test.ts`, `index.test.ts` | R2 archive before database write before ack, duplicate without a second row, conflict quarantine, retry on transient failure |
| T6 | `tests/e2e/tracking-outbox.spec.ts`, `tracking-delivery.spec.ts`, `posthog-adapter.spec.ts` | Real browser: consent control, GPC, offline/reload, withdrawal clearing the outbox, one PostHog capture per canonical `event_id`, fixture mode silence |
| T7 | `tests/e2e/tracking-storage.spec.ts`, `frontend/diner/src/tracking/withdrawal.test.ts`, `outbox.test.ts` | Storage failure and withdrawal recovery across tabs and reloads |

### 10.3 Commands and results (fixture)

| Command | Result |
| --- | --- |
| `npx vitest run frontend/diner/src/tracking packages/analytics/src/posthog.test.ts backend/src/index.test.ts backend/src/consumer` | 17 files, 352 passed, 0 failed |
| `npx playwright test tests/e2e/tracking-delivery.spec.ts tests/e2e/tracking-outbox.spec.ts tests/e2e/tracking-storage.spec.ts tests/e2e/tracking.spec.ts tests/e2e/posthog-adapter.spec.ts` | 37 passed, 0 failed (Chromium) |

Tools: Vitest 4.1.11, Playwright 1.64.0, macOS. Date: 2026-11-14.

### 10.4 Live checks still needed (S6-TRK-03 acceptance)

| Check | Status |
| --- | --- |
| Live PostHog diagnostic event correlated with a canonical fact | PENDING: needs the approved PostHog project, host and environment |
| `POST /observations` receipt from a real consented diner action on staging | PENDING: needs live mode, API address, intake on and a published menu |
| Worker → Queue → R2 → typed fact trace for the same `event_id` | BLOCKED: queues paused (unblock date pending Sai) |
| 401/403, expired token, 429/503 and duplicate on staging | PENDING: same run as above |
| Consent off and withdrawal on staging (no dispatch) | PENDING: same run as above |
| Fixture/demo data excluded from real canonical owner reports | PENDING: needs a staging report read after the run |

Before the run, Sai confirms: staging in live mode with the API address
set, intake on, a published menu, the approved test venue, the frontend
and Worker versions, and the approved PostHog project, host and
environment. Ehab runs the phone journey and captures the evidence;
Uneeza checks it independently.

### 10.5 Release exception

This evidence is added after the original November 10 freeze as a
documented release exception for S6-TRK-03. It changes documentation
only: no application code, configuration, secrets, queues or deployments.
