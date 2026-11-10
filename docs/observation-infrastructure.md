# Staging observation infrastructure

This is the infrastructure handoff for the observation ingestion pipeline. The producer `POST /observations` verifies menu-token authority, applies approximate per-location rate limits and awaits Queue acceptance. The consumer archives evidence in private R2 before writing the canonical database index or conflict quarantine and acknowledging delivery. Deployment and hosted acceptance are separate from merging this code.

**November 2 hosted status:** reviewed main `c6a47bd` is deployed as staging
Worker version `60ac184a-a348-4e2c-843d-e380861771cc`. Six follow-up checks passed:
three archived synthetic observations were backfilled, and a genuine issued-token
Brave request reached the real Queue, private R2 and transactional typed facts.
Retries produced one fact; changed reuse was quarantined. Both Queues are empty
and paused. See [Operations](operations.md#observation-facts-hosted-acceptance)
and the [sanitized evidence](observation-facts-staging-acceptance.json). The
[November 1 record](observation-staging-acceptance.json) remains historical evidence.

The reconciled contracts retain server-derived `traffic_class`, its `live`
default, and canonical payload normalization. The combined producer/consumer
regression uses the real migrated PostgreSQL database with simulated Queue/R2;
it does not replace hosted acceptance. The deployed consumer now writes the
accepted index and typed facts transactionally; its archive backfill also passed
the bounded hosted checks. Keep normal collection paused until the real diner
controls, consent/outbox/delivery and owner-report flow pass acceptance. An
operator may resume only a bounded, labelled synthetic run and pause it afterward.

## Typed facts and archive recovery — November 2

The follow-up implementation writes an accepted index, the shared
`observation_event` row and its matching detail row in one transaction. A failed
detail write rolls everything back and keeps the Queue item retryable. Rejected
events and quarantined copies never become reportable facts. Save and Unsave
map their respective surface fields into `observation_save.surface`; Undo stays
a Save with `save_origin=undo`. No applied migration is edited or added.

The original private archive controls receipt time and traffic classification.
An identical retry can fill missing facts but cannot rewrite the original or
reclassify test traffic as live. Local/staging-issued tokens explicitly sign
`traffic_class=test`; production issuance signs `live`. Owner views continue to
exclude test/demo rows. These views are inputs to reports, not a completed
report API or proof that the ten-session privacy floor is applied downstream.

### Recover missing facts

Only an authorized staging operator runs this, from the repository root:

```sh
pnpm --filter @peekaplate/backend exec node backfill-observations.mjs <venue-uuid>
pnpm --filter @peekaplate/backend exec node backfill-observations.mjs <venue-uuid> --apply
```

The first command only inspects up to 100 accepted index rows missing facts.
The second checks their original private R2 envelopes and fills them through
the same repository transaction. It never resends observations to the Queue,
changes their timestamps/disposition, writes PostHog tables or deletes archives.
Existing Wrangler authorization supplies access; no shared database password or
new permanent credential is needed. The temporary remote development proxy is
authenticated with a secret held only in memory and is stopped afterward.
Nothing is added to the deployed API's routes.

Run only for the approved venue. Verify the reported IDs/counts and repeat until
inspection is empty. A `blocked` result means missing/corrupt evidence, missing
explicit historical traffic classification, or a persistence failure; it exits
nonzero and remains pending. Restore/resolve that evidence before proceeding.
Do not default historical unknown classification to live or skip blocked rows
with a sequence cursor. Unrelated tenant rows remain invisible through forced RLS.

The local browser test fetches a genuine token from the public-menu endpoint,
sends the same observation twice through real workerd/Queue/local R2/PostgreSQL,
and verifies one typed fact and no owner-view test rows. This is a transport
harness, not the unfinished diner screens/outbox. Hosted verification and its
exact release are recorded in Operations after deployment. Normal collection
stays paused until real controls, outbox/privacy and owner-report acceptance pass.

## Canonical database handoff

On October 31, the existing staging Supabase database received the unchanged
migrations from [PR #32](https://github.com/vivienk/peekaplate/pull/32) and
[PR #50](https://github.com/vivienk/peekaplate/pull/50), in this order:
`20261023120000_observation_index.sql`, then
`20261026120000_observation_facts.sql`. All four previous history entries remain.

The schema contains `app_private.observation_index`,
`app_private.observation_conflict`, nine typed fact tables, and
`app_private.owner_observation_v1` / `app_private.owner_opening_activity_v1`.
The hosted audit verified forced tenant RLS on all eleven tables, append-only
triggers, restricted runtime SELECT/INSERT grants, protected security-invoker
views and denied browser/exporter access. Owner views exclude test/demo traffic;
report suppression and HTTP authorization belong to the report implementation.

See the [release record](operations.md#observation-schema-release--october-31-2026)
for verification and limits. Consumer integration must persist accepted index
and matching typed facts transactionally before those facts can drive owner
metrics. Creating empty tables does not activate a consumer or certify that
integration. Delivery remains paused until the reviewed flow passes acceptance.

## Resources and bindings

Account: `51eda1917fd22a9478808a82d2980741`. The October 24, 2026 inventory found no Queues; only the two missing staging Queues were created. The existing private staging bucket was reused. No production resource, database, subscription or token was created or changed.

| Resource | Name / ID | Current use |
| --- | --- | --- |
| Observation Queue | `peekaplate-staging-observations` / `f4979c52a09a4c40ad55e46d32b0ff93` | Staging observations; delivery paused |
| Dead-letter Queue | `peekaplate-staging-observations-dlq` / `45eda79d781d47fe8bca7bb6f5d05bde` | Failed deliveries after the source retry limit; delivery paused |
| Existing R2 bucket | `peekaplate-staging-assets` | Private archive; shared with staging assets, so use a dedicated observation prefix |
| Worker producer binding | `OBSERVATION_QUEUE` | Targets the observation Queue in `backend/wrangler.jsonc`, staging only |
| Worker R2 binding | `OBSERVATION_ARCHIVE_BUCKET` | Targets the existing staging bucket, staging only |
| Rate Limiter (Minute) | `OBSERVATION_RATE_LIMITER_MINUTE` | 60 requests per 60s; approximate per-location enforcement (not global token bucket) |
| Rate Limiter (Burst) | `OBSERVATION_RATE_LIMITER_BURST` | 10 requests per 10s; approximate per-location enforcement (not global token bucket) |

The observation bindings and real consumer reached the live API through release
#94. Future binding changes still require a reviewed main deployment; merging
to develop alone does not deploy. Keep the existing Hyperdrive, Auth issuer and
`TEAM_GITHUB_TOKEN`; never add their credentials to a frontend.

## Why delivery is paused

The real Worker consumer replaced the temporary source HTTP pull consumer during
the approved release. Bounded synthetic acceptance passed, then both Queues
were paused again. Genuine-token browser transport, typed-fact writes and
backfill passed the November 2 follow-up. Normal collection remains off because
real diner controls/outbox/privacy and owner reporting still need acceptance.
The DLQ retains its existing HTTP pull consumer for controlled recovery.

| Setting | Source Queue | DLQ |
| --- | --- | --- |
| Consumer | Worker `peekaplate-api-staging`; `9e89751e2efe4228b840d91843052c47` | HTTP pull; `f3a3fef446fc49b1983a37be275e2845` |
| Maximum retries | 3 after the initial delivery | 100; operator recovery only |
| Retry delay | 10 seconds | 10 seconds |
| Batch wait / visibility timeout | Maximum batch wait 30 seconds | Visibility timeout 30 seconds |
| Batch size | 10 | 10 |
| Retention | 86,400 seconds / 24 hours | 86,400 seconds / 24 hours |
| Delivery | Paused outside bounded synthetic tests | Paused outside bounded synthetic tests |

Pause and retention are provider settings, not invented Wrangler fields. **Pausing does not stop expiry.** No real observations should be collected while the consumer is unavailable. A DLQ is not permanent storage: inspect failed-message age and remaining retention, and arrange monitoring/recovery before enabling real collection. This setup purchased no plan upgrade; measured usage and billing remain the operator's responsibility.

## Verification boundary

Real private R2 conditional writes were tested on October 24 at `2026-10-24T17:26:12.045Z`: two concurrent writes to a new synthetic key produced exactly one winner; an additional create-only attempt failed, and readback preserved the winner's bytes and SHA-256 checksum. The run-owned object was deleted and the authenticated remote-development proxy was disposed. No public Worker or HTTP test endpoint was deployed.

Queue testing uses two clearly synthetic messages: one is archived and read back before its individual ACK; the other is deliberately retried until it reaches the configured DLQ, then acknowledged there. Only the exact probe messages may be acknowledged. Both Queues must be empty before starting, resumed only for the test, and paused again in cleanup. Never purge a shared Queue or acknowledge unrelated work.

The first Queue probe hit a transient `409` because the delivery plane still reported paused immediately after the resume API completed. Cleanup re-paused both Queues. Its remaining synthetic retry message was recovered through the DLQ at `2026-10-24T17:29:04.204Z`; it was not purged or silently discarded. A bounded retry for that exact propagation response is required when repeating the check.

The fresh complete repeat passed at `2026-10-24T17:30:36.147Z`, run `2c7d7bc7-6b23-458f-968f-5c736fd1e14f`. R2 readback before ACK had SHA-256 `5195d6b28a0a3632840ce4b89fd775128e6c46f12752121507a05cf7c0b5f25d`. The failing probe was delivered with attempt counters `0, 1, 2, 3`, then observed and individually acknowledged in the DLQ. Post-cleanup provider readback showed both Queues paused and each backlog at zero. The run-owned R2 object was deleted. No real observation was sent or processed.

That October 24 infrastructure probe did not establish product processing.
The November 1 acceptance above adds actual canonical deduplication/conflicts,
archive/index processing, Queue drain and native malformed-message DLQ delivery.
The November 2 follow-up additionally verifies genuine diner-token HTTP
transport and typed facts. Real product controls, owner reports, native
process-crash recovery and full DLQ-to-canonical replay remain separate gates.

## What Teeyansh can do now

1. Build on merged #70/#31 and the applied canonical migrations. Use the bindings above; credentials stay on the platform, not in frontend code or chat.
2. Preserve create-only evidence: use an atomic conditional R2 write, then compare the existing checksum on a failed condition. An identical checksum is a retry; a different payload is quarantined without overwriting the original. A database lock taken after the R2 write cannot protect that earlier write.
3. Persist the canonical index/facts idempotently, then individually ACK. R2 or database failure must retain/retry work. Calling `ack()` does not send a message to the DLQ.
4. Include failure, concurrent-conflict and recovery tests in his PR. Keep source acceptance/time rules and first-received timestamps aligned with the shared contract.
5. The staging consumer, typed facts, archive backfill and signed-token browser transport are verified within the synthetic scope. Reconcile the real diner controls/outbox and owner-report acceptance before requesting normal delivery. Keep the DLQ for controlled recovery; do not attach a second competing consumer.

The existing collaborator analytics API gives read access to delayed PostHog diagnostics. It does not grant Cloudflare administration or turn those rows into canonical owner facts. Developers can submit code/configuration PRs without receiving the operator's provider token.

## Operator checks

Restore R2 archives with their `payload-checksum` custom metadata intact. For a
sanitized invalid-conflict object, the original untrusted payload was deliberately
discarded; hashing the safe JSON cannot reconstruct that original checksum.
Metadata-free restoration of those objects is not supported by this consumer
and can lead to retries. Preserve evidence and escalate for controlled recovery;
never overwrite the object or silently ACK it to clear the Queue.

Use the project-pinned Wrangler. Set `CLOUDFLARE_ACCOUNT_ID` to the staging account above when listing account-wide resources; some commands do not infer it from `--env staging` alone.

```sh
pnpm --filter @peekaplate/backend exec wrangler queues info peekaplate-staging-observations --env staging
pnpm --filter @peekaplate/backend exec wrangler queues info peekaplate-staging-observations-dlq --env staging
pnpm --filter @peekaplate/backend exec wrangler r2 bucket list --env staging
pnpm verify build
```

Before enabling delivery, verify the actual consumer and settings through provider readback. Preserve existing messages during a consumer change; do not delete/recreate these Queues to deploy code. Keep production resources separate. App deployments follow [ADR 0012](adr/0012-main-environment-promotion.md) and [operations](operations.md).

References: [accepted evidence boundary](adr/0003-intent-evidence.md), [integration handoff](adr/0015-integration-contracts-and-owner-evidence.md) (currently Proposed), [Cloudflare pause/expiry](https://developers.cloudflare.com/queues/configuration/pause-purge/), [DLQ semantics](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

## DATA-01 dual-destination acceptance preparation — November 10

Status: **PREPARED; every case below is PLANNED / NOT RUN.** This is the shared
DATA-01 run specification, not another acceptance ledger or permission to enable
collection. Record actual results in the coordinator's existing shared run and
link that run from [DATA-01](https://app.clickup.com/t/90141746115/86bcnfzu6).
Do not replace the historical November 1/2 records above with these expectations.

Zhiliang owns event/field mapping, ingestion/receipt checks and downstream
reconciliation. Jeffin coordinates the integrated run; Uneeza independently checks
expected results. Frontend owners retain controls, consent/outbox and delivery;
Teeyansh retains backend handoff; the release operator controls environment
configuration and any bounded resume/pause. This document assigns no additional
implementation, policy, operational access or delivery date.

### Preconditions and provenance

- Use the reviewed Matrix v0.1h attached to DATA-01 and the current
  [shared observation fixtures](../packages/contracts/fixtures/observation.v2/README.md).
  Record the Matrix revision and exact served commits; a merged PR or local build
  is not evidence that the corresponding code is deployed.
- The coordinator/operator must confirm compatible frontend, Worker and database
  releases, approved frontend/Worker/asset origins, token/publication references,
  PostHog project/host and allowed properties, plus the bounded run and cleanup.
  Normal collection remains paused. No production data, retention change, shared
  Queue purge or unrelated acknowledgement is authorized by this preparation.
- Enter through the approved direct-link path. Pin approved venue/menu/dish and
  publication revisions before the run. Actual control wiring and release gates
  must be ready; fixtures alone do not satisfy this condition.
- Keep synthetic/test traffic explicitly labelled and excluded from real owner
  metrics. Do not relabel test traffic as live to make a report appear. Synthetic
  owner-report checks use only the producer's permitted reserved venue/entry.
- Inspect the current [PostHog projection](../packages/analytics/src/posthog.ts),
  [delivery rules](../frontend/diner/src/tracking/delivery.ts) and
  [report reader](../backend/src/owner-report.ts) against the pinned deployment.
  Current production report gating/unknown freshness may correctly yield
  unavailable rather than a visible metric; record that outcome separately from
  the future real-data report gate.

### One shared run record

For each case, fill these fields in the existing shared run before assigning a
disposition. Keep actual evidence empty until executed; record why a case is
blocked rather than inventing an actual result.

| Record field | Required content |
| --- | --- |
| Run and case | Run ID, stable case ID below, UTC start/end, coordinator/operator, reviewer, PLANNED / NOT RUN / BLOCKED / PASS / FAIL |
| Served versions | Frontend and Worker commit/build IDs, deployed Worker version, migration/schema versions, Matrix revision, SDK/config version; environment and source mode |
| Approved scope | Authorized venue/menu/dish/publication/revision references, operator-approved origins and PostHog project/host; no credentials or full bearer token |
| Browser observation | Exact control/action and preconditions, consent and privacy-signal state, storage mode, generated event IDs and relevant exposure/opening/comparison references; identify any prerequisite events separately |
| Independent expectation | Approved event/property mapping, expected logical PostHog capture IDs, canonical disposition and expected persisted index/fact outcome, expected report state and relevant cohort/window |
| Actual destinations | Redacted browser/capture observation and provider readback, ordered ingestion receipts, Queue processing evidence, create-only R2 checksum/archive identity, canonical index/fact/disposition, authorized report response |
| Comparison and sign-off | Expected versus actual by stage, explained missing/extra IDs, limits, evidence links, reviewer/disposition and owner of any follow-up |

`event_id` is the cross-destination reconciliation key. The PostHog adapter also
passes it as the SDK event UUID; canonical session/producer IDs and menu tokens
must not be copied into PostHog. A logical capture is not a network request count,
and HTTP success is not independently observed provider ingestion.

An `accepted` receipt proves Queue acceptance only. The stateless producer may
accept an identical retry or changed reuse again; the consumer must deduplicate
or quarantine it. Verify R2/index/typed facts independently. Do not require a
producer `duplicate_same_payload` reason that the current implementation does
not promise. PostHog loss/blocking and its page-memory queue can create explained
gaps; the two complete ID sets are not assumed equal.

### Prepared cases

All rows start **PLANNED / NOT RUN**. Fault injection below is a test design,
not authority to alter a shared service; prefer an isolated approved test layer
and preserve browsing and unrelated work.

| Case | Action / condition | Independent expected result and evidence to collect |
| --- | --- | --- |
| D01-01 Consent and privacy | Perform the agreed eligible control with consent absent, declined or ignored; repeat with DNT/GPC or an unreadable privacy signal. Then opt in. | No pre-consent observation is queued or sent to either destination; opting in does not backfill prior actions. Collect negative network/outbox evidence and allowlisted consent-state observations. |
| D01-02 Fixture silence | Exercise the same controls in the ordinary fixture/demo source mode, including any consent UI. | No ingestion or PostHog capture/SDK request attributable to these fixture events. Console/test assertions are local evidence only; no fixture is described as a hosted diner observation. |
| D01-03 Committed eligible action | With approved live-mode test configuration and consent, perform one selected supported control. Record prerequisite display events separately and correlate the selected event by its generated ID. | One logical capture for that event reaches PostHog independently of its canonical outbox enqueue. Verify approved properties/provider readback, ordered receipt, original archive checksum, one accepted canonical index and matching typed fact. An accepted receipt alone leaves persistence NOT VERIFIED. |
| D01-04 PostHog-specific failure | Block only the PostHog/SDK path in the approved test layer while repeating D01-03 with a new action ID. | Canonical delivery/receipt/archive/fact and browsing remain functional. Record the missing PostHog observation and failure boundary; do not manufacture a matching PostHog row or feed owner reports from its export. |
| D01-05 Canonical retry isolation | Permit PostHog, make canonical delivery transiently fail or leave its outcome unknown, then recover delivery under the original still-valid publication/token. | Pending canonical event keeps its original ID/payload and retries with bounded backoff. Recovery creates at most one accepted fact. Canonical retries, Queue redelivery and receipt processing create no second logical PostHog capture. SDK transport attempts are counted separately. |
| D01-06 Offline and reload | Interrupt the browser after queueing a consented event, reload/reopen, and recover under the allowed source/publication/consent conditions. | Only eligible persisted canonical pending work may resume with original identity. Page-memory PostHog work can be lost; explain that gap instead of replaying canonical events into PostHog. No fresh action is inferred from network delivery or token renewal. |
| D01-07 Partial or uncertain receipt | Use an approved isolated sender response with accepted/retry/rejected entries; separately test malformed, missing, duplicate, reordered or foreign receipt IDs. | A valid mixed receipt removes only terminal accepted/rejected entries and retains retry IDs. An untrusted/malformed receipt retains the uncertain batch. Check outbox state and repeated original IDs; a blanket HTTP200 is not blanket success. |
| D01-08 Withdrawal | Withdraw before a pending send; separately withdraw while an already-dispatched request is in flight, then opt in again. | Applicable unsent work is cleared and no old work is retried/backfilled after re-opt-in. Capture/SDK retry paths stop. A dispatched request may already have arrived; reconcile any resulting archive/fact and do not claim recall, server erasure or downstream removal. |
| D01-09 Publication/token boundary | Retry an old-publication event after replacement; test missing, expired and refused token states using a new isolated case. | No event is relabelled to a newer publication/token. Current sender waits with no token, drops terminal expiry/publication-mismatch and401 / 403 cases, and retains only permitted transient retries. Record discarded event IDs/counts and explain a possible PostHog-only gap. Renewal of original-publication delivery is not promised. |
| D01-10 Save storage modes | Exercise Save/Unsave/Undo with the agreed persistent storage failure and with session-only mode; inspect Saved-screen behavior. | Apply the existing storage-mode decision: unavailable persistence does not emit a successful Save/Unsave/Undo measurement; session-only mode emits no shortlist_viewed. UI/storage owners verify exact behavior. Do not substitute UI appearance for a successful persisted transition or redefine the agreed mode. |
| D01-11 Duplicate and conflict persistence | Repeat the same canonical ID/payload, then submit changed reuse in the isolated approved harness. | Queue receipts may accept again, but the original archive and accepted checksum/fact remain immutable. Identical retries create no extra fact; changed reuse is quarantined and never enters a report. Replaying consumer evidence never recaptures PostHog. |
| D01-12 Report and tenant boundary | Read the authorized bounded report, then try a separate tenant/revoked actor. Check agreed zero/unknown/suppressed/stale and isolated 9 / 10 / 11 cohort examples through the supported source. | Use independently expected canonical facts and per-metric distinct eligible cohorts, exact window and revision attribution. Real reports exclude test/demo traffic; a one-visit cell may correctly stay suppressed. Unknown freshness/unlinked outcomes remain unavailable. Record current 503/release gating separately; public responses omit internal cohorts. A reserved synthetic report proves only its labelled path, not this journey's live metrics. |

The positive transport case and the report case have separate dispositions. Do
not lower the ten-session floor, turn unknown freshness into fresh, or claim that
one captured action proves visible owner analytics. Current production report
activation and complete producer disclosure checks remain independent gates.

### Review and handoff

Zhiliang prepares the mapping and expected stage-by-stage reconciliation; Uneeza
checks the expected outcomes independently. Jeffin links the coordinated run and
frontend readiness, Teeyansh supplies the compatible backend handoff, and the
operator authorizes any hosted execution/cleanup. Each implementation owner
handles findings in their own slice. A reviewer records the source/run version,
decision and evidence link before DATA-01 can move from In Review to accepted.
Preparing this section, or passing existing intercepted tests, executes none of
these hosted cases.
