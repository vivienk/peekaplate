# Diner tracking staging release

This narrow release promotes the reviewed [PR78](https://github.com/vivienk/peekaplate/pull/78)
menu/detail triggers from develop to main for DATA-12 preparation. It reuses the
existing diner Pages project and public staging configuration. The API, console,
extraction service, database and Queue settings are outside this deployment.

## Scope and readiness

The runtime changes are the menu screen and its event helpers. They record a
readable menu, qualifying card exposures, detail openings and shared activity
checkpoints. Consent starts fresh timing; withdrawal drops ineligible activity.
Publication changes clear prior exposure links. The shared track() call dispatches
independently to the PostHog SDK and canonical outbox. No second SDK capture is added.

The three menu runtime/unit files and relevant browser tests match current
develop. Unrelated order-import, ingredient, insight-action, comparison and owner
auth branches are not promoted by this release.

## Deployment target

- Pages project: `peekaplate-diner-staging`, existing branch `main`.
- Diner: `https://peekaplate-diner-staging.pages.dev`.
- Public API: `https://peekaplate-api-staging.vxkong.workers.dev`.
- Build mode: staging with `VITE_MENU_SOURCE=live` and the existing approved public
  PostHog project/host/origin configuration. Ingestion keys are public build inputs;
  no private token or database credential belongs in the build.
- Deploy a clean, reviewed exact main commit. Verify the served `release.json`
  sourceCommit and pinned Pages deployment. Keep existing bundle/photo deployments.

Use the existing [published-menu connection](diner-connection.md) build and hosting
procedure. A push to develop is not a staging deployment. The Pages console's
production deployment type refers to the main branch of this staging project;
it does not promote the application to its separate production environment.

## Verification

Before deployment, run repository checks, the Chromium suite, the intercepted
SDK/privacy suite, and the staging build. Existing tests cover consent transitions,
50%-visible/one-second exposures, detail timing/window scroll, changed publications,
byte integrity, token expiry, withdrawal, retry and usable menu behavior.

After deployment, record the exact main SHA, Pages ID, HTTP/build metadata checks
and a bounded hosted-frontend smoke test in the release PR. Use labelled synthetic
public responses and intercepted destination requests for that smoke test; do not
send test traffic to providers or reactivate a Queue as an incidental deploy check.
An intercepted request proves browser dispatch, not PostHog ingestion or durable
canonical persistence. The dated release comment holds the observed results;
this procedure alone is not an acceptance record.

## DATA-12 handoff

Jeffin coordinates the real joined run; Uneeza owns independent expected/actual
reconciliation. Use the corrected [DATA-12 preparation PR155](https://github.com/vivienk/peekaplate/pull/155)
and the [owner-report staging scope](owner-report-staging.md).

Before real destination traffic, agree the served frontend/Worker/schema versions,
approved venue/publication, consent and server-derived traffic classification,
bounded Queue/provider window and cleanup. Test-classified observations must remain
excluded from owner reports. Numeric reconciliation requires separately approved
live-classified synthetic evidence in the report fixture and the returned window.

Capture PostHog readback and canonical receipt/archive/index/typed-fact evidence
separately, then reconcile the report and UI. Keep genuinely unexecuted cases pending.
This release does not close DATA-12, grant restaurant access, run a paid model,
enable normal collection or change production.
