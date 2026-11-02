# Staging observation infrastructure

This is the infrastructure handoff for the observation ingestion pipeline. The producer `POST /observations` verifies menu-token authority, applies approximate per-location rate limits and awaits Queue acceptance. The consumer archives evidence in private R2 before writing the canonical database index or conflict quarantine and acknowledging delivery. Deployment and hosted acceptance are separate from merging this code.

**November 1 hosted status:** reviewed main `35e989d` is deployed as staging
Worker version `3db23304-c53a-4fee-b0ba-260c3afe4060`. Ten bounded hosted
pipeline checks and fifteen public HTTP checks passed. The real source Worker
consumer is attached; both Queues are empty and paused again. See
[Operations](operations.md#observation-consumer-hosted-acceptance) and the
[acceptance record](observation-staging-acceptance.json) for scope and remaining work.

The reconciled contracts retain server-derived `traffic_class`, its `live`
default, and canonical payload normalization. The combined producer/consumer
regression uses the real migrated PostgreSQL database with simulated Queue/R2;
it does not replace hosted acceptance. This consumer writes the canonical index
and conflict records only. Transactional typed-fact persistence and an idempotent
archive/index backfill still need their own implementation and tests before
owner views can show those observations. Keep normal collection paused until
that work and browser-to-destination acceptance pass. An operator may resume
only the bounded, labelled synthetic acceptance run and pause it again afterward.

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
were paused again. Normal collection remains off because the diner/token path,
transactional typed-fact writes/backfill and owner reporting are not accepted.
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
Real diner-token HTTP delivery, typed facts, owner reports, native process-crash
recovery and full DLQ-to-canonical replay remain separate integration gates.

## What Teeyansh can do now

1. Build on merged #70/#31 and the applied canonical migrations. Use the bindings above; credentials stay on the platform, not in frontend code or chat.
2. Preserve create-only evidence: use an atomic conditional R2 write, then compare the existing checksum on a failed condition. An identical checksum is a retry; a different payload is quarantined without overwriting the original. A database lock taken after the R2 write cannot protect that earlier write.
3. Persist the canonical index/facts idempotently, then individually ACK. R2 or database failure must retain/retry work. Calling `ack()` does not send a message to the DLQ.
4. Include failure, concurrent-conflict and recovery tests in his PR. Keep source acceptance/time rules and first-received timestamps aligned with the shared contract.
5. The real staging consumer is now attached and verified within its index/conflict scope. Finish typed-fact writes/backfill and browser/owner acceptance before requesting normal delivery. Keep the DLQ for controlled recovery; do not attach a second competing consumer.

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
