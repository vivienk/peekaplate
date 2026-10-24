# Staging observation infrastructure

This is the infrastructure handoff for Teeyansh's Queue consumer. It provides a place to send, retain and recover synthetic observations. It does not implement his consumer, the ingestion endpoint or canonical database facts. His unfinished PRs are unchanged.

## Resources and bindings

Account: `51eda1917fd22a9478808a82d2980741`. The October 24, 2026 inventory found no Queues; only the two missing staging Queues were created. The existing private staging bucket was reused. No production resource, database, subscription or token was created or changed.

| Resource | Name / ID | Current use |
| --- | --- | --- |
| Observation Queue | `peekaplate-staging-observations` / `f4979c52a09a4c40ad55e46d32b0ff93` | Staging observations; delivery paused |
| Dead-letter Queue | `peekaplate-staging-observations-dlq` / `45eda79d781d47fe8bca7bb6f5d05bde` | Failed deliveries after the source retry limit; delivery paused |
| Existing R2 bucket | `peekaplate-staging-assets` | Private archive; shared with staging assets, so use a dedicated observation prefix |
| Worker producer binding | `OBSERVATION_QUEUE` | Targets the observation Queue in `backend/wrangler.jsonc`, staging only |
| Worker R2 binding | `OBSERVATION_ARCHIVE_BUCKET` | Targets the existing staging bucket, staging only |

The binding configuration must reach a reviewed `main` release and the protected staging deployment before it exists in the live API Worker. Merely merging to `develop` does not deploy it. Keep the existing Hyperdrive, Auth issuer and `TEAM_GITHUB_TOKEN`; do not replace their credentials or add them to a frontend.

## Why delivery is paused

The current API Worker has a `fetch` handler and no observation `queue` handler. Attaching an unfinished or empty handler could acknowledge work without archiving or indexing it. Instead, a temporary **HTTP pull consumer** establishes the source-to-DLQ routing without running product code.

| Setting | Source Queue | DLQ |
| --- | --- | --- |
| Consumer | HTTP pull; `a0b4e09af2af44b2bcab74b9bf5fac1c` | HTTP pull; `f3a3fef446fc49b1983a37be275e2845` |
| Maximum retries | 3 after the initial delivery | 100; operator recovery only |
| Retry delay | 10 seconds | 10 seconds |
| Visibility timeout | 30 seconds | 30 seconds |
| Batch size | 10 | 10 |
| Retention | 86,400 seconds / 24 hours | 86,400 seconds / 24 hours |
| Delivery | Paused outside bounded synthetic tests | Paused outside bounded synthetic tests |

Pause and retention are provider settings, not invented Wrangler fields. **Pausing does not stop expiry.** No real observations should be collected while the consumer is unavailable. A DLQ is not permanent storage: inspect failed-message age and remaining retention, and arrange monitoring/recovery before enabling real collection. This setup purchased no plan upgrade; measured usage and billing remain the operator's responsibility.

## Verification boundary

Real private R2 conditional writes were tested on October 24 at `2026-10-24T17:26:12.045Z`: two concurrent writes to a new synthetic key produced exactly one winner; an additional create-only attempt failed, and readback preserved the winner's bytes and SHA-256 checksum. The run-owned object was deleted and the authenticated remote-development proxy was disposed. No public Worker or HTTP test endpoint was deployed.

Queue testing uses two clearly synthetic messages: one is archived and read back before its individual ACK; the other is deliberately retried until it reaches the configured DLQ, then acknowledged there. Only the exact probe messages may be acknowledged. Both Queues must be empty before starting, resumed only for the test, and paused again in cleanup. Never purge a shared Queue or acknowledge unrelated work.

The first Queue probe hit a transient `409` because the delivery plane still reported paused immediately after the resume API completed. Cleanup re-paused both Queues. Its remaining synthetic retry message was recovered through the DLQ at `2026-10-24T17:29:04.204Z`; it was not purged or silently discarded. A bounded retry for that exact propagation response is required when repeating the check.

The fresh complete repeat passed at `2026-10-24T17:30:36.147Z`, run `2c7d7bc7-6b23-458f-968f-5c736fd1e14f`. R2 readback before ACK had SHA-256 `5195d6b28a0a3632840ce4b89fd775128e6c46f12752121507a05cf7c0b5f25d`. The failing probe was delivered with attempt counters `0, 1, 2, 3`, then observed and individually acknowledged in the DLQ. Post-cleanup provider readback showed both Queues paused and each backlog at zero. The run-owned R2 object was deleted. No real observation was sent or processed.

This infrastructure probe does **not** test canonical database deduplication/conflict handling, actual consumer crashes, tenant authorization, ingest receipts or owner reports. The full Queue → R2 → canonical database → ACK/retry → DLQ/replay test remains an integration gate after the relevant code and migrations are approved.

## What Teeyansh can do now

1. Continue the consumer locally using the agreed `observation.v2` contract and Jeffin's forward migrations. Use the binding names above; credentials are injected by the platform, not committed to Git or shared in chat.
2. Preserve create-only evidence: use an atomic conditional R2 write, then compare the existing checksum on a failed condition. An identical checksum is a retry; a different payload is quarantined without overwriting the original. A database lock taken after the R2 write cannot protect that earlier write.
3. Persist the canonical index/facts idempotently, then individually ACK. R2 or database failure must retain/retry work. Calling `ack()` does not send a message to the DLQ.
4. Include failure, concurrent-conflict and recovery tests in his PR. Keep source acceptance/time rules and first-received timestamps aligned with the shared contract.
5. After review, an authorized operator replaces the temporary source HTTP pull consumer with the real Worker consumer, preserves the DLQ/retry configuration, deploys the reviewed release and runs the full integration acceptance. Only then resume normal source delivery. Keep the DLQ for controlled recovery; do not attach a second competing consumer.

The existing collaborator analytics API gives read access to delayed PostHog diagnostics. It does not grant Cloudflare administration or turn those rows into canonical owner facts. Developers can submit code/configuration PRs without receiving the operator's provider token.

## Operator checks

Use the project-pinned Wrangler. Set `CLOUDFLARE_ACCOUNT_ID` to the staging account above when listing account-wide resources; some commands do not infer it from `--env staging` alone.

```sh
pnpm --filter @peekaplate/backend exec wrangler queues info peekaplate-staging-observations --env staging
pnpm --filter @peekaplate/backend exec wrangler queues info peekaplate-staging-observations-dlq --env staging
pnpm --filter @peekaplate/backend exec wrangler r2 bucket list --env staging
pnpm verify build
```

Before enabling delivery, verify the actual consumer and settings through provider readback. Preserve existing messages during a consumer change; do not delete/recreate these Queues to deploy code. Keep production resources separate. App deployments follow [ADR 0012](adr/0012-main-environment-promotion.md) and [operations](operations.md).

References: [accepted evidence boundary](adr/0003-intent-evidence.md), [integration handoff](adr/0015-integration-contracts-and-owner-evidence.md) (currently Proposed), [Cloudflare pause/expiry](https://developers.cloudflare.com/queues/configuration/pause-purge/), [DLQ semantics](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).
