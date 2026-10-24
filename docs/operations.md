# Local and staging operations

## Observation infrastructure — October 24, 2026

Created only the missing staging source Queue and DLQ in the existing account, reused private `peekaplate-staging-assets`, and verified source retry-to-DLQ routing with HTTP pull consumers. The complete synthetic repeat at `2026-10-24T17:30:36.147Z` passed archive/readback before ACK, initial delivery plus three retries, DLQ arrival and exact probe cleanup. A separate real R2 concurrency check allowed exactly one create-only writer and preserved its bytes on conflicting attempts. Provider readback confirms both Queues empty and paused, 24-hour retention, `r2.dev` disabled, no custom domain and no CORS rule. No production resource, application consumer, database fact or unfinished PR changed.

The [observation infrastructure handoff](observation-infrastructure.md) records names/IDs, configuration, test limits and consumer replacement steps. Staging producer/R2 bindings are prepared in `backend/wrangler.jsonc`; their live activation requires the reviewed `main` deployment. No ingestion route or successful placeholder Queue handler is added. This new setup record advances the earlier provisioning checkpoint below without claiming the full observation pipeline is implemented.

## Team analytics hosted verification — October 22, 2026

The staging Worker is deployed and its collaborator read path works. This record supersedes the earlier same-day prerequisite audit below. The two hosted 403 cases were initially deferred; the [October 23 follow-up](#non-collaborator-confirmation--october-23-2026) now records successful non-collaborator denial. Controlled collaborator removal remains pending. This is staging development access, not pilot or production sign-off.

| Release item | Verified result |
| --- | --- |
| Main release | `afe45dbe99967a9010f73bce7fb5f82a3597313d` (`afe45db`) |
| Protected deployment | [Run 39907285014](https://github.com/vivienk/peekaplate/actions/runs/39907285014), successful; requested by `vivienk`, approved under the maintainer's authorization by eligible reviewer `hemu77`; no administrator bypass used |
| Activation flag | `STAGING_DEPLOYMENT_APPROVED=true`; manual dispatch remains required |
| Worker version | `5922a293-6893-47fd-8bc5-a20f0afd8d0b` at `https://peekaplate-api-staging.vxkong.workers.dev` |
| Migration | Read-only audit confirmed history version `20261021130000`, its function and the sole project-scope row `675372` |
| Hyperdrive | Existing binding, restricted `peekaplate_staging_login`, query caching disabled, connection limit 20 |

The deployment's frozen install, `pnpm check`, `pnpm build` and Wrangler deploy passed. GitHub's approval history confirms a different eligible account approved Vivien's request. Administrator bypass is still allowed by the environment settings, but was not used. Vivien confirmed the checker token is limited to this repository with Metadata read, the Cloudflare token's IP restriction was removed, and both expire January 20, 2027. Scope/expiry details are operator confirmations: GitHub secret values cannot be read back. The successful release verifies their effective deployment/API use, not every permission or expiry claim. Rotate through protected secret storage before expiry.

### Hosted checks

Fourteen direct HTTP checks passed against this release. The caller's existing GitHub credential was held in memory, verified as `hemu77`, sent only to GitHub and the fixed staging Worker, and never printed or saved. Analytics requests used `from=2026-10-20T06:00:00Z&until=2026-10-20T07:00:00Z`.

| Check | Result |
| --- | --- |
| `GET /health` | 200 |
| `GET /team/analytics/events` with the collaborator's credential | 200; four synthetic records |
| `GET /team/analytics/summary` with the same credential | 200; two event/surface groups |
| Missing and invalid credential on both endpoints | 401 in all four cases |
| Client project override, duplicate parameter, excessive date window and result limit | 400 in all four cases |
| Existing staff revision endpoint without staff authentication | 401; no write performed |
| Diner and console staging roots | 200 HTML for both |

All applicable API responses had `Cache-Control: no-store`, a request ID and no permissive CORS grant. Both successful analytics responses passed `TeamAnalyticsResponseSchema`: fixed staging project/source, bounded arrays and allowlisted properties, without visitor/person/IP fields. Freshness remains `hourly_export_delay`; these are internal diagnostics, not owner metrics.

A read-only SQL transaction passed eleven assertions: migration history; staging-only scope; fixed-search-path security-definer ownership by a non-login/non-bypass role; runtime function execution; runtime denial of scope-table reads; denied raw/view reads and analytics-schema access for browser/runtime roles; denied browser function execution; no reader schema-create privilege; safe runtime role flags; forced RLS on all six application tables; and an append-only exporter without application-schema access. Readback remained eight raw copies and four deduplicated events. No migration, grant or restaurant record changed during this audit.

The PostHog export remains enabled/hourly, including only `app_shell_viewed` with `environment = staging`. Subsequent scheduled runs completed, including `01a1672c-5761-0000-4453-2b83d1fc11dd`. Their zero-row results establish successful execution, not new collection or completeness. See [the export record](posthog-export.md).

### Remaining boundary

- **Non-collaborator denial: PASS**, as recorded in the October 23 follow-up below. **Controlled collaborator removal: NOT RUN**; a disposable collaborator must return 200 before removal and 403 afterward. Random credentials test 401, not membership denial. Do not remove a real teammate. Local denial/revocation tests are separate evidence.
- Existing successful staff-write, concurrency and revocation evidence remains below. This release rechecked unauthenticated staff denial and database permissions without repeating that full hosted write sequence.
- Production has no configured application deployment or separate database/bindings. There is no hosted production endpoint to accept here. Production-mode route denial is covered locally; it is not a production deployment test. Pilot load, restore, monitoring/retention/billing ownership and production approval remain separate delivery work.

Contributors can continue tickets with local fixtures and the bounded staging read API. Share [team data access](team-data-access.md), not provider passwords or the checker token. Complete the controlled removal test before closing full hosted acceptance. This documentation update does not deploy a newer application revision.

### Non-collaborator confirmation — October 23, 2026

Harshita helped complete the remaining outsider check. The maintainer supplied two successful terminal reports from a valid non-collaborator account, using the [repository checker introduced in PR #33](https://github.com/vivienk/peekaplate/pull/33). The second run followed a fresh `develop` clone. These are user-run hosted results, not a new test executed by the documentation editor.

| Evidence | First run | Fresh-clone repeat |
| --- | --- | --- |
| Verification time (UTC) | `2026-10-24T05:52:32.802Z` | `2026-10-24T06:07:16.871Z` |
| GitHub `/user` | 200; expected account matched | 200; expected account matched |
| Staging events | 403; `error=forbidden` | 403; `error=forbidden` |
| Events request ID | `e5c56d75-4c30-4bfa-8cc1-48736a0d6494` | `caff985f-24b6-4a4a-8deb-93741b07425d` |
| Staging summary | 403; `error=forbidden` | 403; `error=forbidden` |
| Summary request ID | `3c8c3962-48d1-4e69-b3b7-41af1274761f` | `260bf8ee-c591-4b88-bba9-4d340f747fb0` |
| Checker outcome | PASS | PASS |

Both UTC timestamps fall on October 23 in America/Phoenix. Target: `https://peekaplate-api-staging.vxkong.workers.dev`, with the checker's fixed historical query window. This verifies denial for the tested valid outsider identity on both routes; it does not measure data freshness. No token, password, raw analytics body or private conversation is retained here. The reports do not identify a new Worker release; the latest recorded deployment remains `afe45db` above.

The collaborator 200 and invalid-token 401 evidence remains in the October 22 record. The outsider 403 check is now complete, and the staging inspection API is available to accepted repository collaborators. Controlled collaborator-removal acceptance and production verification remain NOT RUN. No access grants, migration, provider setting or deployment changed for this confirmation.

## PostHog export handoff — October 21, 2026

The private analytics export is verified in staging. Two successful runs of the same synthetic interval produced eight raw copies and four deduplicated events; the known diner and console records each matched once. All 14 read-only row/permission checks passed. The hourly schedule is enabled, with the official Supabase CA and hostname verification retained. See [the export runbook](posthog-export.md) for run IDs, recovery history and evidence limits. No grants were broadened. Subsequent scheduled execution was verified on October 22 above; sustained monitoring remains separate work. Menu and event-contract tickets can proceed; the hourly internal copy is separate from the planned promptly updated owner-report pipeline.

Repository transition: [migration and release checklist](repository-migration.md) records repository and deployment gates. Under [ADR 0012](adr/0012-main-environment-promotion.md), `main` supplies both environments: test an exact commit in staging, then promote that same commit to production after human approval. The staging workflow requires `STAGING_DEPLOYMENT_APPROVED=true`; it is enabled for manual staging dispatch as recorded above. Production deployment remains unconfigured.

## What is configured

Node 24.16.0, pnpm 11.25.0, frozen lockfile, two Vite apps and a Hono Worker with health and authenticated dish commands. `backend/wrangler.jsonc` configures the verified account, HTTPS Supabase issuer and existing Hyperdrive ID only under `env.staging`. It contains no password, API token, local-mode override or production binding. The October 18 issuer inspection returned an ES256 public signing key; genuine staff-session checks passed as recorded below. Application fixtures use synthetic data; package and image downloads contact their registries.

The October 18 provider inspection verified the existing Supabase project `icwhkrlsecpzcomfjsso` and Hyperdrive `peekaplate-staging-postgres` (`bef46ec5f5044d0ea5f9e48450895b64`) in Cloudflare account `51eda1917fd22a9478808a82d2980741`. Hyperdrive targets that project's direct PostgreSQL endpoint, uses `peekaplate_staging_login`, has query caching disabled and a 20-connection limit. The Supabase dashboard calls the project's default branch `main / PRODUCTION`; that provider label is distinct from the application's deployment environment. This existing project is the staging candidate, not a separate production database.

A read-only database audit found both migration versions (`202610130001`, `20261014210000`), all six `app_private` tables with RLS enabled and forced, and a non-superuser staging login with only the `peekaplate_runtime` role membership, no RLS bypass and no role-creation privilege. Effective table/column grants and actor/tenant policy expressions matched the staff migration. The login has schema usage but no schema-create privilege; `anon` and `authenticated` have no SELECT grant on these six tables. This verifies catalog settings, not migration-file checksums. The hosted acceptance evidence below covers the existing staff command, not future publication or ingestion behavior.

R2 inventory confirms existing buckets `peekaplate-staging-assets` and `peekaplate-production-assets`. The staging bucket has no custom domain or CORS policy and its public development URL is disabled. It is not yet bound to an asset-serving workflow; leave original-photo access private. Production bucket policies were not audited. Existing D1 databases are not part of this backend: PostgreSQL remains the single application database. Do not wire D1 as a second source of truth, create duplicate resources or delete the unused databases as part of this setup. No additional paid database branch was created.

## GitHub staging environment settings — verified October 22, 2026

The live [staging environment settings](https://github.com/vivienk/peekaplate/settings/environments/25058679013/edit) were inspected and the branch restriction saved on October 22, 2026 (America/Los_Angeles).

| Setting | Verified configuration |
| --- | --- |
| Deployment branches and tags | Selected branches and tags; exact branch pattern `main`; 1 branch and 0 tags allowed |
| Required reviewers | Enabled; `hemu77`, `jeff13in`, `TeeyanshShukla` listed |
| Prevent self-review | Enabled |
| Administrator bypass of protection rules | Allowed |
| Wait timer | Disabled |
| Environment variable | `CLOUDFLARE_ACCOUNT_ID` exists and is populated |
| Environment secrets | `CLOUDFLARE_API_TOKEN` and `TEAM_GITHUB_TOKEN` exist; only names were inspected |

These settings are saved in GitHub, outside the Git tree. This dated record documents their observed state; merging it does not apply settings or detect future drift. The [staging workflow](../.github/workflows/deploy-staging.yml) requires `refs/heads/main`, targets the `staging` environment and runs only by manual dispatch with repository variable `STAGING_DEPLOYMENT_APPROVED=true`. At the settings audit, main's workflow used only the Cloudflare variable and secret. This release also passes `TEAM_GITHUB_TOKEN` to Wrangler through a private temporary secrets file; merely storing that secret in GitHub does not configure the deployed Worker.

No secret values were read or committed. Token validity, scopes and expiration were not verified. This settings audit did not enable or change `STAGING_DEPLOYMENT_APPROVED`, run a deployment, or test approval enforcement through a workflow run. Administrator bypass remains allowed, so the configured reviewer gate is not an absolute barrier to administrators. Before activation, verify credential permissions, intended staging bindings and the independent approval process. This environment observation does not establish repository branch protection, a billing-plan change or production readiness.

### October 22 release prerequisite audit (before activation)

A read-only SQL transaction against staging project `icwhkrlsecpzcomfjsso` initially found migration-history versions `202610130001`, `20261014210000` and `20261020070000`. At that earlier audit, migration `20261021130000`, its history entry, scope table and read function were absent. Vivien subsequently applied it; the new verification above confirms its history and effective permissions. No migration or grant was applied during either verification audit.

Project-local Wrangler authenticated successfully with the operator's existing OAuth credential and could list the intended account's Worker secrets; the staging Worker returned an empty secret list. This verifies the operator connection, **not** the separate `CLOUDFLARE_API_TOKEN` or `TEAM_GITHUB_TOKEN` stored in GitHub. Both GitHub environment secret names exist, but their values, expiry and effective permissions remain unverified. GitHub secrets cannot be read back for local testing. Test them only through an approved protected runner without printing them; do not substitute the operator's OAuth result as evidence for those tokens.

At this earlier audit the activation variable was unset and deployment remained disabled. Vivien subsequently enabled it after completing the prerequisites; the protected release and hosted positive checks are recorded above. The October 23 follow-up closes outsider denial; controlled collaborator removal remains deferred. The earlier audit itself changed no credentials, provider resources or deployment settings.

## Staging deployment record

Verified October 18, 2026 (America/Phoenix; provider timestamps are October 19 UTC). [PR #10](https://github.com/vivienk/peekaplate/pull/10) merged at `bb56cef94f09f4937a89532cf1f28d47d323a171`. Its tree matches the reviewed head `15213aab13607118fd8b70b6ab456fe78aa97e6a`; [main CI](https://github.com/vivienk/peekaplate/actions/runs/39204477938) passed. All three applications were built from that clean main revision and deployed through the authorized operator route. Routine human-review requirements remain unchanged.

| Component | Staging URL | Provider deployment |
| --- | --- | --- |
| API | [Worker health](https://peekaplate-api-staging.vxkong.workers.dev/health) | Worker version `0ce9faa6-6267-4ff0-b4e6-ef535135dd2f` |
| Diner shell | [Diner](https://peekaplate-diner-staging.pages.dev/) | Pages deployment `057a77d4` |
| Owner/staff shell | [Console](https://peekaplate-console-staging.pages.dev/) | Pages deployment `3c841efb` |

Keep these existing staging names. `console` is the owner/staff application, not an additional product. No custom domain is registered or attached as part of this setup. The [plain-language setup walkthrough](team_guide.md#where-to-open-staging) explains the services, access and deployment process.

Pages uses direct uploads from reviewed builds, with `main` as each staging project's default branch. The provider may label that default deployment "production"; these are still dedicated **staging** projects. Direct Upload does not provide native Git-triggered builds; a future protected Actions workflow can upload the same artifacts. No automatic push deployment or production app was activated. Both public sites contain only foundation shells, not a published restaurant menu or working staff login.

Observed checks:

- PASS: `pnpm verify build` on the merged revision, including Worker dry-run and both frontend builds.
- PASS: live `/health` returned 200; unknown route and `/events` returned 404; missing and invalid staff tokens returned 401. API responses included `Cache-Control: no-store` and request IDs. Five sequential probes took 81–370 ms from the operator machine; this is a smoke observation, not a latency benchmark.
- PASS: both Pages roots and all referenced JS/CSS assets returned 200; Brave rendered the expected diner and console headings.
- PASS: six temporary remote-preview probes used the real staging Hyperdrive binding. Each opened a read-only database transaction, verified the non-superuser/non-bypass runtime login, checked that absent tenant context and an unknown actor expose no rows, and verified actor/tenant settings were cleared in the next transaction. The preview was stopped afterward; no probe was deployed as a public application route and no data was written. This is narrower than two-restaurant isolation testing and does not prove physical connection reuse.
- PASS: genuine Supabase password sign-in with the operator-created test account, followed by a successful dish revision through the deployed API (1,493 ms for the first authorized request). An identical retry returned the same result; conflicting command contents, stale versions and command reuse for another dish returned 409. Browser-supplied authority fields were rejected with 400.
- PASS: two competing writes at the same version produced one 200 and one 409. Two identical concurrent retries returned the same version-3 result. Five alternating cycles returned 403 for the second synthetic venue and 200 for the authorized venue.
- PASS: a separate temporary remote preview called the existing command function through the real Hyperdrive binding and injected a failure after the outbox INSERT. The transaction rolled back: zero event, projection, receipt or outbox rows remained for that failed command. This is a fault-injection check of the command/database path, not a failure injected into the public API.
- PASS: database inspection after the API checks found exactly one dish at version 3, three events, three command receipts and three outbox entries; the denied venue had zero events. Removing the temporary membership caused both an old authorized retry and a new command to return 403. No test memberships remain. Clearly labelled synthetic venues and append-only test records remain for audit; exclude them from future restaurant analytics.
- PASS with documented limitation: signing out the test session rejected refresh with 400, while the existing access JWT still authorized an otherwise permitted retry with about 3,570 seconds until expiry. This is Supabase's token-lifetime behavior, not immediate session revocation. Membership removal then blocked that same token. The local login harness and remote previews were stopped; passwords and tokens were held in memory only, never written to the repository or logs.
- NOT RUN: representative load/p95, physical pool-connection reuse proof, a fresh migration rehearsal against a separate hosted database, complete backup restoration, and production acceptance. CI covers local database upgrade/rollback and browser checks; do not substitute that evidence for these remaining operations checks.

Wrangler credentials are encrypted locally with the key in Windows Credential Manager. Deployment additionally requires `workers_scripts:write`; `workers:write` alone allowed inspection but failed deployment. Pages requires `pages:write`. No credentials are stored in the repository or frontends. The separately authorized MCP connection is not a GitHub Actions credential.

Wrangler 4.149.0 can redirect `pages project create` to Workers when invoked by an agent. For this existing Pages architecture, the verified one-time `--force` creation option kept the intended platform. Two unintended, unrouted Worker uploads from that redirect were removed; the API Worker and actual Pages projects remain. Subsequent uploads target the existing Pages projects explicitly. See the resolved ledger entries in [errors.md](../errors.md).

The existing staff-command foundation is ready for the next implementation slice within this tested boundary. Build the staff login UI, dish review/approval and immutable menu publication before connecting diner exposure and event ingestion. Diner design, manually prepared assets and event-contract review can proceed in parallel. Queue/DLQ provisioning belongs with the ingest implementation. Before a real pilot, finish session-lifetime policy, representative latency/load checks, backup/restore evidence and cost/incident ownership. Production additionally requires a separate database, bindings and release approval; existing staging URLs do not establish those controls.

## Local development and tests

Run the [README commands](../README.md). Use separate terminals when working on one target:

```sh
pnpm --filter @peekaplate/diner dev
pnpm --filter @peekaplate/console dev
pnpm --filter @peekaplate/backend dev
```

`pnpm verify test:db` builds a PostgreSQL 16 test image with pgTAP and creates a temporary Docker network/database. It installs the previous schema, preserves a synthetic venue through the forward migration, confirms a second `up` has no pending migration, runs SQL policies, then exercises the real local Worker with signed JWTs and restricted database credentials. Tests include concurrent writers, duplicate/conflicting commands, revoked membership, rollback, replay and physical connection reuse. Cleanup removes the harness container, its volumes and network. The random database host port binds only to `127.0.0.1`; credentials are disposable fixtures. Never point this harness at a shared database. A Docker daemon and image downloads are required. Image tags are pinned to versions, not immutable digests.

`pnpm dev:backend` uses that disposable database setup with a loopback JWKS service and the actual Worker. It writes a synthetic owner session to ignored `work/local-session.json`; the private signing key stays in memory. Run `pnpm local:demo` in another terminal to create a dish revision. Stop with Ctrl+C; local data is intentionally discarded. Do not run it alongside the plain backend dev process on port 8787. A forcibly terminated process can leave its uniquely named `peekaplate-db-*` container/network and session file; inspect ownership before removing those exact resources. Restart after the one-hour fixture token expires.

### Windows Docker startup recovery

If Docker fails before the Linux engine starts with an inaccessible `dockerInference` or `engine.sock` file, check the installed Desktop version and current [Docker release notes](https://docs.docker.com/desktop/release-notes/) first. Docker's maintainer reports a fix in 4.92 and later in [the startup incident](https://github.com/docker/desktop-feedback/issues/460). Repeated socket-directory renames are not a durable repair.

Quit Docker and confirm its WSL distribution is stopped before making an offline backup of the existing Docker disk files at the configured data location. Verify the backup checksums, then use the official installer to upgrade in the existing installation mode. Preserve the data directory; do not factory-reset, unregister the WSL distribution or prune volumes as a startup workaround. The [Windows installation guide](https://docs.docker.com/desktop/setup/install/windows-install/) distinguishes per-user and machine-wide installs.

After the upgrade, `docker version` must report both client and server, and `docker info` must reach the Linux engine. Then run `pnpm verify test:db`; it also checks the local startup/demo/cleanup flow. An installer success or a running window alone does not close the incident. Keep the backup until existing workloads and the project test run are verified. Record the actual version and test outcome in the PR and `errors.md`; do not commit machine backups or diagnostic logs.

## Staff command contract

`POST /venues/{venueId}/dishes/{dishId}/revisions` requires `Authorization: Bearer <staff JWT>` and `Content-Type: application/json`:

```json
{"commandId":"00000000-0000-4000-8000-000000000001","expectedVersion":0,"name":"Example dish","description":"Example description"}
```

The venue in the URL selects a resource; only verified staff membership grants access. Owner/editor memberships may write; viewers cannot. The strict body rejects actor, role and tenant fields. Names are trimmed and limited to 160 characters, descriptions to 4000, and the HTTP body to 16 KiB. Version zero creates the first revision. Later commands carry the last observed version. A successful command returns HTTP 200 with `dishId`, `revisionId`, `version`, `name` and `description`; an identical authorized retry returns the same result. Reusing the command ID for different content or a different dish returns 409, as does a stale expected version. Missing/invalid identity returns 401, insufficient membership 403, invalid JSON/schema 400, wrong content type 415 and an oversized body 413. Missing service configuration or temporary dependency failure returns a sanitized 503. Retry temporary failures with the same command ID and body.

Hosted verification requires a configured `AUTH_ISSUER` ending in `/auth/v1`, HTTPS JWKS, audience/role `authenticated`, an expiry, a UUID subject and RS256/ES256 signatures. Anonymous sessions are rejected. The `APP_ENV=local` option permits only loopback HTTP issuers and selects `LOCAL_DATABASE_URL`; neither setting belongs in staging. Hosted connections use the `HYPERDRIVE` binding. Logs contain a generated request ID and failure category, never bearer tokens or database row errors. `/health` remains liveness only and does not report database readiness. `/events` remains unavailable.

`pnpm test:e2e` starts local apps itself. Install Chromium once with `pnpm exec playwright install chromium`. CI installs system dependencies too. Four tests cover no-JavaScript diner content, the console/real local Worker health path, and axe accessibility plus narrow-screen overflow on both shells. Traces are retained on failure; there is no routine DOM dump. They do not exercise a live restaurant, staff login, queue or GPU viewer. Use `pnpm verify test:e2e` and `pnpm verify test:db` to record failed-check observations as described in [contributing](../CONTRIBUTING.md#local-checks).

## Database change procedure

Use `YYYYMMDDHHMMSS_description.sql` for new dbmate migrations (the initial migration uses a shorter ordered timestamp). Keep `-- migrate:up` and `-- migrate:down` sections. Applied files are immutable. The initial down migration deliberately refuses destructive rollback; future repairs should roll forward.

Use a reviewed, pinned dbmate release (the harness uses 2.36.0) with a separate migration credential supplied through the environment, never a command argument or committed file. Apply to staging first with `dbmate --migrations-dir migrations up`. A runtime credential must not own tables or bypass RLS; do not use the migration owner or Supabase service-role key in the browser. Do not enable API access to `app_private`.

The staff migration creates the `peekaplate_runtime` group role and narrow table/column grants. A separately provisioned login receives that role; never use the migration owner for requests. The October 18 staging audit verified that login's effective restrictions; recheck after permission changes and verify production separately. Before each release, test an upgrade from the last deployed schema as well as a fresh install. Back up before risky changes; restoration requires an operator decision and a rehearsed runbook.

## Cloud-integration checkpoint

Account access and scoped Wrangler authentication are available; reuse the deployed resources above. Effective runtime grants and the bounded hosted staff-command checks have passed. The staff login UI and remaining pilot checks are still separate deliverables. Keep secrets in the operator's credential store or protected provider configuration, not chat, fixtures or Git. An API key is not a staff session JWT.

The October 22 environment settings record supersedes the earlier assumption that staging controls were unavailable. Required reviewers, prevent self-review and the main-only restriction are configured; administrator bypass remains allowed. Protected Actions deployment and the positive access path now pass as recorded above. A direct operator deployment remains a separate route requiring a clean, reviewed exact `main` commit and independent human approval; that direct route does not itself enforce a GitHub environment gate.

The staff-command cloud checks above are complete within their recorded scope: existing migration versions and effective runtime grants, genuine login, restricted uncached Hyperdrive, isolation, retries, concurrency, membership revocation, rollback and transaction-context reset. Do not recreate accounts or resources merely to repeat initial setup. Remaining pilot work includes the session-lifetime policy, representative latency/load, physical pooled-connection reuse evidence and backup restoration. A fresh hosted migration rehearsal remains unrun. Local connection reuse is evidence for application logic, not proof of a hosted pool. Supabase remains the accepted provider under ADR 0005; a Neon switch needs an explicit decision and equivalent auth integration evidence.

## Later Actions-based staging activation

Team analytics API release and collaborator access are documented in [team data access](team-data-access.md). The forward migration grants only checked function execution to the existing runtime. Merging the release does not establish hosted activation.

The required reviewer and main-only environment settings were observed on October 22 as recorded above. The later successful protected run exercised approval and both stored credentials; use that dated release record for current status. The following procedure remains applicable to future releases; no billing-plan change was verified.

The repository owner supplies real account values and enables controls before automated deployment:

1. Before enabling Actions deployment, recheck the recorded `staging` settings: only the `main` branch, required reviewers and prevent self-review. Account for the allowed administrator bypass when obtaining independent human approval. Verify `CLOUDFLARE_API_TOKEN` permissions and the intended account and staging bindings without printing credentials. The presence of a secret name is not authentication evidence. If the required controls or credentials cannot be verified, leave the workflow disabled and use the authorized operator route above.
2. Reuse `peekaplate-diner-staging` and `peekaplate-console-staging`. Use `pnpm install --frozen-lockfile` followed by `pnpm --filter @peekaplate/diner build` or `pnpm --filter @peekaplate/console build`; outputs are `frontend/diner/dist` and `frontend/console/dist`. Set `CLOUDFLARE_ACCOUNT_ID` to the verified account and upload each output with an explicit project name, `--branch main` and `--commit-hash <reviewed-sha>`. Use `wrangler pages deploy`; do not recreate projects. Disable automatic production promotion until review controls exist. The console shell contains no real staff data.
3. Deploy the Worker from a reviewed exact `main` commit using the authorized operator route or the gated workflow when available. Record its SHA and provider deployment ID. Confirm `/health`, a rejected unknown route and the authenticated staff-command flow. Ingest is not implemented. Never promote a newer untested `main` commit as though it were the same release.
4. Reuse the existing staging Postgres and Hyperdrive; verify the reported R2 buckets before use. Provision Queue/DLQ resources with their implementation. Commit only verified non-secret binding IDs and test actual connections. Keep migration credentials, runtime credentials and signing secrets separate. A future production environment needs its own database and bindings; do not share the staging database. Follow [Cloudflare's Supabase/Hyperdrive guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/).
5. Set budget notifications, retention/deletion ownership, backup destination and a named incident responder. Never infer these settings from an example file.

Production is a separate decision with separate credentials/resources. There is no production deployment workflow in this foundation.

## Optional PostHog staging release

The existing US PostHog project `675372` is used only for synthetic staging data. Both hosted staging pages now send verified consented synthetic shell views. The [setup record](posthog.md) identifies current access, privacy settings, the internal dashboard and remaining approval gates.

For future releases, obtain the required review and build the exact approved `main` commit with `--mode staging`. Supply the five `VITE_POSTHOG_*` values from each frontend's `.env.example`; use its exact Pages origin and the staging project's public ingestion token. Build-time configuration is required: runtime variables cannot change uploaded static JavaScript. Never add personal API keys or database secrets to these values.

Upload only `frontend/diner/dist` and `frontend/console/dist` to their existing, explicitly named Pages projects, using `--branch main` and the reviewed commit hash. Browser capture requires no Worker or database deployment. The separate [Supabase export](posthog-export.md) requires its reviewed migration and restricted connection. Verify zero capture before consent, one correct event after opt-in, withdrawal/reload, browser privacy blocking and real PostHog readback on both hosted URLs. Record deployment IDs and the exact SHA. To roll back analytics, rebuild with `VITE_POSTHOG_ENABLED=false` and redeploy, or restore the previous reviewed Pages release.

Member access is sufficient for these synthetic checks and internal charts. An administrator still needs to confirm project naming, staging-only use, the actual billing limits and deletion responsibility. No paid upgrade was purchased. Production requires its own project and release approval; real diner collection also needs an approved privacy/retention policy.

## GitHub merge controls

On October 19, the canonical repository was public and GitHub reported both `main` and `develop` as unprotected. Earlier private-plan limitations are historical. The stored ruleset proposals are not active policy; an administrator should now evaluate enabling them for the public repository. For now, keep write access limited; require reviewed PRs, passing `ci`, and an independent human approval comment before merges; preserve migration/release history with merge commits. These are team process controls, not GitHub enforcement, and admins can bypass them. Protect production credentials in provider settings and keep production promotion behind explicit human release sign-off. Configuration files and CODEOWNERS do not establish enforcement.

CI runs with read-only tokens and pinned action SHAs. PR bodies are read as data, never interpolated into shell commands. The final gate requires path selection and quality to succeed and every applicable integration lane to pass. Fork PRs receive no deployment credentials. Require a human approval with a review comment on the current commit for every PR, including AI-written and dependency changes. Reviewers and mergers currently enforce both approval and comment content manually. Native approval rules could enforce approval only after they become available and are activated. No additional comment-check workflow or automatic approval is configured.

Each existing CI job has one purpose: `changes` selects relevant integration lanes; `quality` checks formatting, types, unit tests, builds and documentation; `database` tests migrations and database constraints; `browser` tests the diner/console smoke flows; `ci` is the single required aggregate check. Documentation checks run after code checks and builds, and still run after an earlier failure, so a missing PR section cannot hide a broken build. Database/browser jobs remain path-selected.

Dependabot checks routine versions on the first day of each month, with one open grouped minor/patch PR per ecosystem (npm and GitHub Actions). Major version upgrades require deliberate manual review, including runtime/type compatibility. Security updates remain independently triggered when enabled and grouped per ecosystem; version-update limits and semver ignore rules do not delay them. See [GitHub's configuration reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) and [PR preparation](../CONTRIBUTING.md#dependency-pr-preparation). No auto-merge. The repository owner must confirm Dependabot alerts and security updates are enabled in Settings; their live activation is not part of this migration audit.

## Pilot recovery, before G3

Document and demonstrate: Queue retry and poison-message DLQ handling; create-only archive conflict quarantine; replay with network side effects disabled; independent backup of Postgres, approved assets/manifests and R2 evidence; restore reconciliation by ID and checksum; deletion requests reapplied after restoration. Measure the plan's content RPO ≤24 hours and restore RTO ≤4 hours. Until the drill exists, those are targets only.

For a failing release, stop promotion and preserve logs without secrets or raw diner data. Prefer restoring the prior application deployment and forward-fixing schema. Do not delete an event stream or silently acknowledge unarchived observations to clear an alert.

## PostHog hosted release — October 19, 2026

Released exact main commit `2a135faa4386fc3e1002aef3d1a150930e5ff9bf` after [PR 14](https://github.com/vivienk/peekaplate/pull/14) and [PR 15](https://github.com/vivienk/peekaplate/pull/15). The user explicitly delegated setup approval; the review disclosed agent assistance. Ordinary PR review requirements remain unchanged.

- Diner Pages deployment: `013f89a7`, [staging diner](https://peekaplate-diner-staging.pages.dev/).
- Console Pages deployment: `9ebf0f78`, [staging console](https://peekaplate-console-staging.pages.dev/).
- Worker and database were unchanged by this frontend release.
- Live isolated-browser checks passed on both stable URLs: no capture before consent, HTTP 200 after consent, expected minimal properties, and no new capture after withdrawal/reload. Both matching generated IDs were visible in PostHog. Synthetic data only.
- Private Supabase export is a separate change; see [its current status](posthog-export.md). These results do not prove diner-event ingestion, menu functionality or owner reports.
