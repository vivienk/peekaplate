# Optional PostHog product analytics

This integration is a best-effort internal product-analytics channel, **not** the durable observation receipt or owner reporting source under [ADR 0003](adr/0003-intent-evidence.md). It never changes staff commands, database events, outbox processing or replay. Do not run both a browser mirror and future server mirror for the same action.

**Setup status, updated October 21, 2026:** the existing US project `675372`, currently named **Default project**, received synthetic events from both hosted staging sites after the approved setup release. The [internal integration dashboard](https://us.posthog.com/project/675372/dashboard/2233365) is for staging only. Repository defaults keep analytics disabled; these deployments use explicit staging configuration. The separate [Supabase export](posthog-export.md) passed a bounded transfer and repeated-interval check: eight raw copies, four unique events, one matching diner and console test record each. Restricted permissions passed; hourly staging exports are enabled.

## What exists and what does not

Both current screens are placeholders. After a visitor explicitly opts in, the real screen emits `app_shell_viewed` with `surface=diner` or `surface=console`. This new technical event is not `menu_viewed`, a signed-in owner, a restaurant visit or a sale. The React effect cleans up on unmount/StrictMode remount. No analytics runs before opt-in; missing configuration hides the optional control entirely.

The shared `captureDishIntent(input)` adapter validates the existing strict v1 `DishIntentEventSchema` and preserves `dish_open` and `portion_compare`. It is tested but has **no dish-control caller yet**, because those controls do not exist. When adding a real control, use the analytics instance returned by `mountAnalyticsConsent`; call `captureDishIntent` after the actual display/interaction with its pinned exposure contract. Never call it for shell renders, mere button-down, fixture menus or generic comparisons. Console callers cannot submit diner events.

The [implementation plan](implementation_plan.md#5-proposed-event-contract-exactly-what-to-record) proposes broader v2 events. Menu/card exposures, ingredients, saves, comparison replacement, viewer lifecycle and owner report actions remain unwired until their controls, strict schemas and triggers are reviewed. Historical portion events cannot be renamed into generic comparison events. No two names for one action.

## Privacy and failure behavior

- Consent is off initially and exists only in page memory; reloading requires a fresh choice. No cookie, localStorage, sessionStorage, fingerprint or cross-device identity is created. A random page-scoped ID is generated only when capture starts. Withdrawal aborts pending requests and discards identity; already transmitted events cannot be unsent.
- DNT and GPC prevent capture and are checked for every attempt. A blocked capture attempt revokes consent. PostHog receives the network connection IP even though the payload sets `$ip=null` and disables GeoIP; project-level IP discard must also be enabled. Do not describe this as completely anonymous transport.
- Only explicit capture API requests are made. No JavaScript SDK, autocapture, replay, heatmaps, automatic pageviews, identity/account properties, remote settings, feature flags, DOM text, query strings or referrer enrichment. Requests omit credentials/referrers and reject redirects.
- Properties are constructed from an allowlist. The adapter excludes the evidence session ID, timestamps, arbitrary renderer strings, experiment arm/block text and all unknown properties. This deliberately loses evidence context and cannot replace the complete canonical event. PostHog person-profile processing is disabled.
- Four in-flight requests maximum, a three-second timeout, 500 attempts per page and at-most-once attempts per dish event ID. Failure returns a bounded result; no retries, persistent queue, console payload logs or blocking UI. Lost events, reloads, opt-outs, blockers and capped traffic mean counts are incomplete. `sent` means HTTP success, not verified ingestion or a durable evidence receipt.

## Separate staging and production configuration

Reuse project `675372` for staging; do not create a duplicate. A later production release needs a separate project and token. PostHog's free organization supports one project, so confirm the actual plan and approve any required cost before adding another. This task made no upgrade. Vivien can rename the existing project **PeekaPlate Staging** without changing its token or integration. See [project separation and limits](https://posthog.com/docs/settings/projects).

Copy the **public project ingestion token** (`phc_…`) from the intended project's settings; never put a personal API key, project secret, database key or service-role key in `VITE_*`. Public ingestion tokens are intentionally included in browser bundles. The real test configuration is in ignored local build files, not committed to Git. The token permits event submission, not reading project data.

Start from each frontend's `.env.example`. Supply build-time values independently for diner and console:

| Variable | Staging | Production |
| --- | --- | --- |
| `VITE_POSTHOG_ENABLED` | `true` only after privacy review | `true` only after release approval |
| `VITE_POSTHOG_ENVIRONMENT` | `staging` | `production` |
| `VITE_POSTHOG_KEY` | staging project's ingestion token | different production project's ingestion token |
| `VITE_POSTHOG_HOST` | `https://us.i.posthog.com` or `https://eu.i.posthog.com` | host for the chosen production region |
| `VITE_POSTHOG_ALLOWED_ORIGIN` | exact staging origin, no trailing slash | exact approved production origin |
| Vite build mode | `staging` | `production` |

The environment must match Vite's mode; origin must match exactly. A production bundle on a preview/staging/local origin fails closed unless an operator deliberately misconfigures its allowed origin. Region is explicit; unsupported/self-hosted hosts fail closed. Deployment labels from a hosting provider do not determine analytics environment. Keep each token in its own build environment; never reuse the staging token in production. Runtime cannot verify which PostHog project owns a token: check the project name in PostHog before release.

For an approved staging build, inject values into the build process or an ignored `frontend/<app>/.env.staging.local`, then run:

```sh
pnpm --filter @peekaplate/diner exec vite build --mode staging
pnpm --filter @peekaplate/console exec vite build --mode staging
```

Production uses `--mode production` with separately supplied values. The ordinary `pnpm build` remains safe with analytics disabled when no values are provided. These are static Vite builds: setting provider runtime variables **after** uploading assets cannot change tracking; rebuild and upload the reviewed artifacts. To disable, set `VITE_POSTHOG_ENABLED=false`, rebuild and redeploy both surfaces. Do not enable the existing Worker deployment workflow for this frontend-only integration.

## Verified setup and release boundary

PR 14 began from `develop`. Its setup update incorporates the existing `main` deployment configuration and PR 13's Python guidance so that integration does not remove the deployed foundation or leave contradictory documentation. Feature review still targets `develop`; a reviewed release then reaches `main`. Only an exact reviewed `main` commit supplies shared staging, under [ADR 0012](adr/0012-main-environment-promotion.md).

Existing hosted services were checked independently:

- [Diner staging](https://peekaplate-diner-staging.pages.dev/): foundation message, no published menu.
- [Console staging](https://peekaplate-console-staging.pages.dev/): staff shell and asset references.
- [API health](https://peekaplate-api-staging.vxkong.workers.dev/health): foundation health response.

The frontend allowed origins for release are those two Pages origins respectively. No production application URL or production PostHog project was verified. The marketing domain is not the core diner app. No Worker, database, migration or R2 change is needed for this optional frontend capture.

Observed provider and runtime checks:

- Sai initially had Member access. The October 20 follow-up confirmed Admin access and successfully updated the existing export connection. No permission workaround was used.
- **Discard client IP data** was already on in project privacy settings. It was inspected, not changed. Payloads also disable GeoIP and person-profile processing.
- Isolated Chromium opened real local builds on ports 4177 and 4178. Before consent there were no capture requests. Opt-in produced HTTP 200 for one diner and one console `app_shell_viewed`; opt-out and reload produced no further requests.
- PostHog's event list showed both matching generated page IDs. Stored properties included `environment=staging`, the correct surface, `evidence_status=unverified_client_observation` and no URL/account fields. The inspected raw record used `person_mode=propertyless`; GeoIP was disabled.
- Brave's active privacy signal kept capture off. The user's privacy preference was not changed.
- The first live capture probe timed out; a later instrumented run passed for both surfaces. The initial cause was not established. These checks demonstrate connectivity and the tested privacy behavior, not delivery reliability or complete analytics counts.

Automated repository browser tests intercept synthetic capture requests. The separate live checks above establish real project ingestion only for the stated synthetic examples. No production or real-diner data was sent.

Repository verification after reconciling the branches: **PASS** `pnpm check` (50 application tests, 21 script tests, types, lint, context and local links); **PASS** `pnpm verify build test:e2e` (both builds, Worker dry-run and eight browser cases); **PASS** `pnpm verify test:db` (43 pgTAP assertions, 13 Worker/database integration cases and the local demo lifecycle). These checks do not establish production readiness, load capacity or the future menu journey.

## Remaining owner and release actions

1. **Staging release completed:** PRs #14 and #15 were merged under the user’s explicit delegated setup approval, disclosed as agent assistance rather than independent human inspection. Main commit `2a135faa4386fc3e1002aef3d1a150930e5ff9bf` was built and deployed to both staging sites. Live consent checks passed and both generated IDs were read back in PostHog. This one-time instruction does not change the normal human-review policy.
2. **Administration:** an administrator can rename the project and confirm it remains staging-only. Confirm the actual billing plan, usage cap/alerts and who handles deletion requests. The earlier Member access blocked billing inspection; the access correction does not itself verify an account-specific spending limit.
3. **Privacy before real diners:** approve the public notice, region and retention/deletion policy. PostHog documents one-year event retention for Free and seven years for paid plans; it does not offer a shorter automatic retention setting. A 30-day proposal is therefore not implemented by this setup. A different policy needs an explicit, tested deletion process or a different collection decision. See [retention](https://posthog.com/docs/data/events-retention) and [data storage controls](https://posthog.com/docs/privacy/data-storage).
4. **Real controls:** when menu controls ship, test each agreed trigger against pinned approved content and check one observation per actual action. Do not rename historical v1 portion events into general comparison events. Build the durable PostgreSQL evidence path separately; PostHog HTTP success is not its receipt.

Team members need PostHog membership only if they will inspect its data or manage charts. Developers can use synthetic fixtures and intercepted tests without account access. Supabase access is separate: application users obtain permitted data through the backend, not through a browser service-role credential. Browser capture requires no personal PostHog API key. The separately requested [Supabase export](posthog-export.md) uses a private schema migration and its own restricted database login. Admin/TLS and credential corrections are complete; live synthetic transfer, matching rows and duplicate-safe retry are verified. See the export runbook for run IDs, limits and recovery steps. Its hourly copy does not supply the planned live owner dashboard, which reads validated Supabase projections through an authorized backend.

## Internal analysis versus owner analytics

For teammate access to the Supabase copy, use the [staging inspection API](team-data-access.md) with individual login and explicit reader grants. It returns bounded, allowlisted diagnostics; it does not proxy PostHog administration, expose raw visitor identities or implement owner reports.

The internal [Integration health - staging dashboard](https://us.posthog.com/project/675372/dashboard/2233365) counts `app_shell_viewed`, broken down by `surface` and filtered to `environment=staging`. It labels these **opted-in placeholder page views**, not unique diners/owners. The generated distinct ID measures a page lifetime, not a visit or person. Repeat capture after toggling consent can add another technical view. Do not use the provider's generic starter dashboard as proof of menu usage; its automatic events are not collected here.

Once real dish callers exist, exploratory counts of `dish_open` and `portion_compare` can be broken down by `dish_revision_hash` and displayed tier. These are client observations, not verified restaurant facts, consideration rates or orders. Do not expose PostHog shared dashboards to restaurant owners or use client fields as tenant authority. The public ingestion API can be spoofed.

A production owner dashboard still requires server-verified venue access, validated evidence, agreed metric denominators and minimum-ten-eligible-session suppression from [ADR 0006](adr/0006-orders-and-measurement.md). No owner report/query endpoint or dashboard is claimed here. Ingredient rates, saves, order linkage, revenue and causal lift cannot be calculated from this slice.

References: [PostHog capture API](https://posthog.com/docs/api/capture), [anonymous events](https://posthog.com/docs/data/anonymous-vs-identified-events), [IP storage controls](https://posthog.com/docs/privacy/data-storage).
