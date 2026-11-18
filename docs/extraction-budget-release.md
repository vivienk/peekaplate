# Extraction-only release: #184 and #188

This release promotes the reviewed provider-attempt budget from #188 and the
read-only FE-06.4 verifier from #184 onto main. It does not deploy anything by
itself. Deploy only the extraction Worker/Durable Object and its matching Python
container from the final merge SHA recorded on the release PR.

The API, console and diner stay on `ba70ce9cfd5dcb3efe34a1e57e2562ff52863f06`.
Their runtime source, contracts and hosting configuration are unchanged by this
release. No Supabase migration, provider credential change, ingredient-artwork
rollout, Queue activation, production deployment or `.io` change is included.

## Why the paired release is compatible

The existing API still signs the same tenant/job/source capability, submits the
same extraction request, and consumes the same report and private-artifact
contracts. The new budget route is used by the extraction service's private
loopback proxy, not by the API or either browser application. The hosted child
receives a job-specific proxy token instead of the service/signing credentials.
The Dockerfile copies the new Python module through its existing `COPY src`.

Both services must be updated together. A successful Worker upload alone is not
proof that an already-running container uses the new image. Record its image
digest and rollout completion before intake. Do not use `--containers-rollout
none`, and do not delete the existing Durable Object namespace or budget rows:
redelivery must retain the original job's allowance.

## Deployment steps for Teeyansh

1. Confirm the release PR's final merge SHA and green main CI. Keep menu delivery
   paused, inspect the Menu Queue/DLQ backlog and stop if unrelated work is present.
   Leave observation delivery unchanged. Record the current extraction Worker
   version and image digest for rollback; old dated docs are not a fresh inventory.
2. Use a clean checkout of that exact SHA, not the moving develop branch:

   ```powershell
   git fetch origin main
   git switch --detach <RELEASE_MERGE_SHA>
   git status --short
   pnpm install --frozen-lockfile
   pnpm --filter @peekaplate/backend exec wrangler whoami
   pnpm --filter @peekaplate/backend exec wrangler deploy --config wrangler.extraction.jsonc --keep-vars --containers-rollout immediate --message "FE-06.4 budget release <RELEASE_MERGE_SHA>"
   pnpm --filter @peekaplate/backend exec wrangler deployments list --config wrangler.extraction.jsonc
   ```

   Stop on any command failure or dirty tracked source. Use the existing approved
   Cloudflare account and staging configuration. Keep existing secrets and
   dashboard variables. The command explicitly selects extraction; do not run the
   generic API deployment workflow or a Pages deployment. The current extraction
   Actions workflow omits `--keep-vars`, so use the operator command above for this
   rollout rather than silently overwriting dashboard configuration.
3. Verify the extraction rollout and matching container image are complete. Read
   API health without redeploying it. The extraction `/health` requires the existing
   service bearer; an unauthenticated 401 does not establish container readiness.
   An authenticated health 200 still does not prove the budget path or extraction.
4. Perform the non-billable reservation checks below. Do not call `/extract`, submit
   a menu or activate delivery while testing the reservation endpoint.
5. Once those checks pass and the coordinated test window is confirmed, use one
   fresh synthetic menu job for FE-06.4. Preserve the existing fictional restaurant
   and diner URL. The budget is **two outbound provider attempts per tenant/job**,
   including model cascades, OCR retries and redelivery. Timeouts can consume an
   attempt. New job IDs have separate allowances: do not create replacement jobs
   to bypass the agreed two-call total for this controlled test.
6. Re-pause menu delivery, inspect source/DLQ backlog without purging unknown work,
   and record cleanup and any agreed temporary membership restoration. Do not
   delete linked staging accounts or remove someone else's testing access.

## Non-billable hosted budget verification

Use the existing `mintExtractionCapability` helper in
`backend/src/extraction-capability.ts` from the trusted operator environment.
Use the approved fictional tenant with a **separate fresh probe job UUID** and a
synthetic source hash. That probe must not reuse the later extraction job, because
reservations intentionally consume its allowance even without provider traffic.
Service and signing credentials remain in private configuration, never chat,
command arguments, committed files or screenshots. If the operator lacks those
credentials, coordinate a scoped operator-run probe instead of replacing secrets.

Send `POST https://peekaplate-extraction-staging.vxkong.workers.dev/budget/reserve`
with the existing service bearer, `X-Source-Capability`, `X-Tenant-ID`, `X-Job-ID`,
`X-Source-Hash`, and JSON Content-Type. The JSON body is:

```json
{"reservation_key":"<new-unique-key>","provider":"synthetic"}
```

| Probe | Expected |
| --- | --- |
| First and second distinct keys for the same probe job | 200, granted true, used_calls 1 then 2, max_calls 2 |
| Third distinct key | 429, granted false, provider_call_budget_exhausted |
| Replay an earlier granted or denied key | Same recorded result; no new allowance |
| Several simultaneous unique keys for another isolated probe job | Exactly two grants in total |
| Wrong tenant/job/hash or missing/invalid capability | Rejected before a reservation or provider request |
| Repeat the exhausted probe after instance restart, preserving its storage | Still denied; do not delete storage to simulate a restart |

Record only sanitized request IDs, probe IDs, statuses, counters and deployed
versions. These requests reach budget storage only; they do not invoke a model or
OCR provider. Failure, uncertainty about the image, or missing authorization keeps
paid execution blocked. Full transport/credential checks remain required even
though the local workerd test passes.

## FE-06.4 evidence and verifier

Capture the real upload, private R2 source hash, Queue delivery, fresh extraction,
attempt-scoped report archive, canonical drafts, evidence mapping, correction,
save/reload and owner/viewer/cross-restaurant denials. Run initial-draft checks
before changing review state. Supply your own staff/viewer sessions through
`PEEKAPLATE_STAFF_TOKEN` and `PEEKAPLATE_VIEWER_TOKEN` in the local environment:

```powershell
node scripts/verify-ingestion-e2e.mjs --job-id <JOB_UUID> --venue-id <SYNTHETIC_VENUE_UUID> --cross-tenant-venue-id <DENIED_VENUE_UUID> --require-pr161 --max-provider-calls 2 --expected-source-id <SOURCE_ID> --expected-source-hash <SOURCE_SHA256> --report-json <PRIVATE_REPORT_PATH> --evidence-out <PRIVATE_EVIDENCE_PATH>
```

The verifier never submits work or enforces the upstream budget. Its evidence
correctly reports upstream usage as unknown; attach the separate budget/provider
evidence. A 401 is not an authorization-denial 403. Successful extraction and
scoring accuracy are separate claims.

See [provider budget design](provider-call-budget.md) and the [verifier
handoff](staging-e2e-acceptance-2026-11-14.md). The release PR records exact local
test counts, runtimes, final SHA and CI. Hosted rollout and the controlled provider
run remain Teeyansh's next steps, not completed by this source promotion.
