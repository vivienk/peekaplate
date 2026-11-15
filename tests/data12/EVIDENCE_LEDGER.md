
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
| Schema/contract version | Pending |
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
| Consented diner action | Approved action emitted once | Not collected | PENDING |
| Shared event identity | Approved correlation identity matches | Not collected | PENDING |
| PostHog capture | Approved event and properties only | Not collected | PENDING |
| Canonical receipt | Approved event ID acknowledged | Not collected | PENDING |
| Durable archive | Event persisted durably | Not collected | PENDING |
| Durable index | Event indexed once | Not collected | PENDING |
| Typed fact | One valid typed fact | Not collected | PENDING |
| Report reconciliation | Independently calculated eligible counts match | Not collected | PENDING |
| Owner access | Authorized owner can read report | Not collected | PENDING |
| Tenant denial | Other tenant cannot read report | Not collected | PENDING |
| Revoked access | Revoked owner cannot read report | Not collected | PENDING |
| Replay | Same event identity; one durable fact | Not collected | PENDING |
| Canonical retry | No additional PostHog capture | Not collected | PENDING |
| PostHog failure | Canonical path remains independent | Not collected | PENDING |
| Canonical failure | PostHog path remains independent | Not collected | PENDING |
| Offline/reload/reconnect | No duplicate durable fact | Not collected | PENDING |
| No consent | Neither destination sends or queues | Not collected | PENDING |
| Consent declined/ignored | Neither destination sends or queues | Not collected | PENDING |
| Withdrawal | Applicable pending sends stopped | Not collected | PENDING |
| No pre-consent backfill | Earlier actions never replayed | Not collected | PENDING |
| Fixture network silence | No real destination traffic | Not collected | PENDING |
| Storage-blocked Save/Unsave/Undo | Unmeasured behavior preserved | Not collected | PENDING |
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

TRK scope/adapter ownership and the proposed consent UI ticket
remain pending Vivien's alignment with Adam.

Prepare local tests and documentation now.

Do not execute dependent staging acceptance until alignment and
compatible deployments are confirmed.

This work does not change TRK ownership or create/assign a consent ticket.

## 9. Acceptance status

Local DATA-12 threshold tests: PASS (5/5)

Real staging journey: PENDING

PostHog and canonical durable persistence: PENDING

Independent reconciliation: PENDING

Sai review: PENDING

Overall DATA-12 acceptance: NOT YET ESTABLISHED
