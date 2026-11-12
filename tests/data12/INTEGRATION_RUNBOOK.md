
# DATA-12 — Sprint 5 Integration Validation Runbook

## 1. Objective

Validate one real, consented staging journey:

Approved menu publication → diner interaction → shared tracking
dispatch → PostHog capture and canonical delivery → durable archive,
index and typed fact → privacy-safe authorized owner report.

Both PostHog and canonical delivery are required acceptance
destinations. A canonical receipt alone does not prove persistence.

## 2. Responsibilities

- Jeffin: Integration coordination and staging readiness
- Uneeza: Expected/actual metrics and evidence reconciliation
- Sai: Independent privacy and security review
- Vivien and Adam: Pending TRK and consent UI alignment
- Product owners: Diner and owner-facing acceptance

## 3. Preconditions and dependency hold

Do not execute dependent staging acceptance until:

- Vivien and Adam confirm TRK scope/adapter ownership and consent
  implementation alignment.
- Compatible frontend, Worker and schema deployments are available.
- The approved PostHog project, host and environment are confirmed.
- The staging venue and test classification are approved.
- The menu publication revision is recorded.
- Authorized staging access and a consenting test visit are available.
- Test evidence can be isolated from real owner populations.

Do not change TRK ownership or create a consent UI ticket.

Never use production diner identities or real owner aggregates to
manufacture acceptance evidence.

## 4. Capture deployment provenance

Before testing, record:

- Staging environment and UTC timestamp
- Exact frontend deployed SHA/version
- Exact Worker deployed SHA/version
- Exact schema/contract version
- Approved PostHog project and host
- Approved test venue and menu publication revision
- Test/demo classification and isolation mechanism
- Authorized test owner and access verification method

Record these in EVIDENCE_LEDGER.md.

Local repository HEAD is not proof of the deployed version.

## 5. Approved menu and diner journey

1. Verify the approved menu upload/review/publish flow.
2. Record the approved publication revision.
3. Open the current diner menu in the permitted staging environment.
4. Verify the diner receives the expected published revision.
5. Establish explicit optional-analytics consent.
6. Perform one approved diner interaction.
7. Record redacted correlation references and the expected event type.
8. Verify the interaction passes through the shared tracking call.
9. Confirm the PostHog and canonical paths are both exercised.

Do not infer consent from browsing or previous test activity.

## 6. PostHog verification

Using the approved PostHog project:

- Verify the event reaches the approved host/environment.
- Verify the approved event name and property allowlist.
- Verify the expected correlation identity.
- Verify no access tokens, raw session IDs, producer IDs,
  personal information or unapproved free-text properties.
- Verify the approved identity lifecycle.
- Record redacted network and PostHog evidence.

A locally intercepted SDK request is not proof of hosted capture.

## 7. Canonical persistence verification

For the same approved event:

1. Verify canonical submission and accepted event identity.
2. Record the canonical receipt.
3. Verify the durable archive object exists.
4. Verify the durable index contains the expected event.
5. Verify exactly one valid typed fact is produced.
6. Confirm tenant and publication-revision attribution.
7. Compare the approved event IDs and properties across boundaries.

Do not mark persistence successful based only on a receipt.

## 8. Replay and recovery

Replay the same permitted canonical event.

Expected:

- Event identity remains unchanged.
- Exactly one durable fact remains.
- Canonical retry does not trigger another PostHog capture.
- Owner report totals do not increase from the replay.

Test offline, reload and reconnect separately.

For each failure, record:

- Failing stage
- Expected result
- Actual result
- Redacted correlation reference
- Safe recovery action
- Final durable fact count

Do not retry by inventing a new event identity.

## 9. Independent destination failures

### PostHog failure

Verify that PostHog failure does not block:

- Canonical delivery
- Diner browsing
- Approved recovery behavior

### Canonical failure

Verify that canonical failure does not block:

- PostHog capture
- Diner browsing
- Canonical retry with unchanged event identity

Never treat success at one destination as proof of success at both.

## 10. Consent and privacy checks

Test each case independently:

- Consent absent
- Consent declined
- Consent ignored
- Consent granted
- Consent withdrawn
- Withdrawal during pending SDK retry
- Withdrawal during pending canonical retry
- No pre-consent event backfill
- Fixture network silence
- Storage-blocked Save/Unsave/Undo

Under the current default-off rule, absent, declined or ignored
consent must not send or queue either destination.

Withdrawal must stop applicable pending sends.

Storage-blocked Save/Unsave/Undo must remain unmeasured.

Verify S5-DATA-09 retention and withdrawal evidence.

## 11. Owner report reconciliation

Use the same approved venue, dish, publication revision and
reporting window.

Independently calculate:

- Distinct exposed sessions
- Distinct exposed-and-opened sessions
- Distinct open-eligible sessions
- Distinct engaged sessions
- Distinct direct-save sessions
- Distinct timed sessions
- Total openings
- Finalized openings
- Average finalized active duration

Compare expected metrics against both report API and UI.

Current report formulas:

- Open rate = exposed-and-opened / exposed sessions
- Engagement rate = engaged / open-eligible sessions
- Save rate = direct-save sessions / exposed sessions
- Timing coverage = finalized openings / total openings
- Average interaction time = average finalized opening duration

Apply metric-specific eligibility and privacy rules.

Do not count duplicate events as additional sessions.

Browsing must never be described as orders or sales.

## 12. Privacy thresholds

Use isolated, labeled synthetic test data.

| Eligible sessions | Expected |
| --- | --- |
| 9 | Suppressed |
| 10 | Available only when metric eligibility is satisfied |
| 11 | Correct calculation, subject to metric eligibility |

A real staging visit may correctly produce a suppressed report.

Never lower the ten-session privacy floor or contaminate live
aggregates to obtain a numeric result.

Preserve these distinctions:

- NORMAL
- SUPPRESSED
- NOT_MEASURABLE
- VALID_ZERO
- EMPTY
- Unknown or stale freshness

## 13. Authorization checks

Verify:

- Authorized owner access
- Non-owner denial
- Cross-tenant denial
- Revoked-access denial
- No unauthorized raw event disclosure
- No unapproved token or personal data in PostHog

Record only redacted evidence.

## 14. Failure handling

If any stage fails:

1. Stop dependent validation for that stage.
2. Identify the exact failed boundary.
3. Record expected versus actual behavior.
4. Preserve safe redacted correlation references.
5. Confirm whether either destination independently succeeded.
6. Apply only the approved recovery procedure.
7. Recheck event identity, durable facts and report totals.
8. Leave unresolved acceptance checks marked PENDING or FAIL.

Never mark a failed or unverified stage as PASS.

## 15. Evidence package

Required evidence:

- Deployed frontend/Worker/schema versions
- Approved PostHog project, host and environment
- Test classification and publication revision
- Redacted correlation IDs
- Browser network evidence
- PostHog capture evidence
- Canonical receipts
- Durable archive/index/typed fact evidence
- Independent expected-versus-actual counts
- Report API and UI evidence
- Consent, withdrawal and retention evidence
- Tenant and revoked-access negative results
- Failure/recovery observations
- Independent Sai review

Record evidence references in EVIDENCE_LEDGER.md.

## 16. Acceptance decision

DATA-12 is ready for acceptance only when:

- Compatible staging deployment is confirmed.
- The real consented journey is captured.
- Both PostHog and canonical persistence are verified.
- Expected and actual report metrics reconcile.
- Privacy and authorization checks pass.
- Outstanding failures and gaps are documented.
- Sai independently reviews the evidence.
- Product owners accept diner and owner-facing behavior.

Current status:

Local privacy threshold tests: PASS (5/5)

Staging journey: PENDING

PostHog and durable canonical evidence: PENDING

Independent reconciliation: PENDING

Sai review: PENDING

Overall acceptance: NOT YET ESTABLISHED
