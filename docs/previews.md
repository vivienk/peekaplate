# PR previews

A PR preview is a temporary copy of the diner and console pages built from one pull request. Design, product and QA reviewers can open it in a browser without running the code locally.

## For reviewers

1. Open the pull request on GitHub.
2. Find the **Preview** comment posted by `github-actions[bot]`. It links to both apps:
   - Diner: `https://pr-<number>.peekaplate-diner-preview.pages.dev`
   - Console: `https://pr-<number>.peekaplate-console-preview.pages.dev`
   - Console component demo (synthetic values, for design review): `https://pr-<number>.peekaplate-console-preview.pages.dev/foundations.html`. Only preview builds include it (`PEEKAPLATE_PREVIEW_DEMOS`); staging and production builds do not.
3. Each new push to the PR rebuilds the preview and updates the same comment. Check that its commit matches the latest PR commit before reviewing.
4. Report findings as PR review comments, with the link, browser and screen size.

No comment means one of these:

- it comes from a fork or Dependabot, which receive no deployment credentials;
- previews are switched off (see [Setup](#setup));
- the **PR preview** check failed. Open it from the PR's checks list.

## What a preview is and is not

| A preview is | A preview is not |
| --- | --- |
| The built static pages from the PR's latest commit | Connected to the API, database, Queue or R2 |
| A way to review layout, tokens, copy and accessibility | Evidence that staging or production works |
| Public to anyone who has the link, and hidden from search engines | Suitable for real restaurant or diner data |

Analytics are disabled in every preview build. Trusted response headers additionally block browser API/analytics connections, forms and embedded frames. Use only synthetic content. Browser headers are not a complete sandbox against malicious HTML or navigation; never enter credentials or real restaurant data into a PR preview.

## How it works

[`.github/workflows/deploy-preview.yml`](../.github/workflows/deploy-preview.yml) runs on `pull_request_target` from the repository's trusted default branch (`main`), with three isolated jobs. Both this workflow and `scripts/preview.mjs` must exist on `main`, even for PRs targeting `develop`. It does not use PR-authored workflow code. There are no path filters, so closing a PR always schedules cleanup:

- **build** runs for same-repository PRs. It checks out the exact PR head SHA with persisted Git credentials disabled, installs dependencies, builds both apps with analytics disabled and uploads the files as a three-day artifact. It has no deployment credentials.
- **deploy** runs no PR code. It checks out the trusted default-branch commit, rejects server-side functions, Workers, redirects, configuration, symlinks and a supplied `peekaplate-preview.json`, then writes trusted headers and that commit marker using the requested PR head SHA. It verifies both target projects and uploads static files with Wrangler under the `pr-<number>` branch alias. Both aliases must return the expected SHA in their marker before the PR comment is updated; HTTP 200 alone can belong to an older build. Marker checks retry up to six times with ten seconds between attempts.
- **cleanup** runs when the PR closes or merges. It deletes every deployment for that PR's branch alias from both projects and marks the comment as removed.

The normal **CI** workflow remains the required build and test check. **PR preview** is separate and not required, so a credentials or provider outage cannot block merges.

## Isolation

- Preview projects are separate from `peekaplate-diner-staging` and `peekaplate-console-staging`. They have no production deployment.
- The `preview` GitHub environment holds its own `CLOUDFLARE_PREVIEW_API_TOKEN`. It needs only Cloudflare Pages edit permission, never the staging Worker, Hyperdrive, Queue or R2 token.
- The build job, which runs PR code, has only read permission and no environment or secrets. Fork and Dependabot PRs skip preview jobs. Deployment tools are installed on a fresh runner before the Cloudflare credential is injected, and uploads run outside repository configuration.
- No Supabase, PostHog or GitHub team token is given to previews.

Limitation: a Cloudflare Pages token is account-wide, so it could also edit the staging Pages projects. Use a dedicated token only in the `preview` environment, and rotate it if it might have leaked. Restrict the preview environment to exact branches `develop` and `main`; unmerged PR workflow changes must not gain access to it. Review changes to those trusted branches. Administrators and code merged into a trusted branch remain part of the trust boundary.

## Retention

- When a PR closes or merges, cleanup attempts to delete all matching preview deployments, including active aliases via the provider API. Failures remain visible and require retry. Cleanup runs even when new previews are disabled.
- Built artifacts expire after three days.
- If cleanup fails, run **PR preview** manually from the Actions tab and enter the PR number. Its `cleanup` job deletes that PR's deployments.
- Review both preview projects monthly in the Cloudflare dashboard and delete deployments whose PRs are closed.

## Setup

An administrator with Cloudflare and GitHub access does this once. No step changes staging.

1. Create two Cloudflare Pages Direct Upload projects named `peekaplate-diner-preview` and `peekaplate-console-preview`. Set the production branch to `unused-production` so a PR branch never becomes production. Keep both deployment configurations free of secrets and resource bindings, without Git integration or custom domains. The workflow fails closed if these checks fail; it never creates or modifies project configuration.
2. Create a Cloudflare API token with **Account → Cloudflare Pages → Edit** only.
3. In GitHub, create an environment named `preview`. Add the secret `CLOUDFLARE_PREVIEW_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. Restrict deployment branches to exactly `develop` and `main`. Required reviewers are optional; enabling them makes each deployment wait for review.
4. Add the repository variable `PREVIEW_DEPLOYMENT_ENABLED` with the value `true`. Set it to anything else to switch previews off.

## First validation: PR #37

PR #37 (design tokens) is the first validation case:

1. Merge the reviewed preview workflow, helper, tests and documentation into the default branch (`main`). A merge into `develop` alone cannot activate `pull_request_target` or manual dispatch. Promote this delivery-only slice separately from unreleased application changes; then synchronize its fixes back into `develop`. PR #37 may continue to target `develop`.
2. Push a commit to PR #37 or close and reopen it.
3. Confirm the **PR preview** check passes, the comment shows both links, and both pages load with the PR's tokens.
4. Record the run link, commit and result in [operations](operations.md).
5. After PR #37 closes, confirm the cleanup job deleted its deployments and the links stop working.

## October 25 verification boundary

Historical observations below describe the earlier local setup attempt; see the current follow-up for the later settings and verification boundary.

- PR #37 head `23cfe85f7d0a823a1e8aa09092c54e6ed203266f` has passing existing CI. Both local frontend builds and the static artifact sanitizer pass; this is not a preview deployment result.
- GitHub readback confirmed the preview token secret name and nonempty account variable. Secret values were not read; token scope/validity remains unverified.
- Preview environment branch restrictions were set to `develop` and `main`.
- Repository variable `PREVIEW_DEPLOYMENT_ENABLED` is absent, so deployment stays off.
- Live Cloudflare project inspection was blocked by a local connection failure. Project existence/configuration and live deploy/cleanup remain unverified.
- Continue tracking [PR preview deployments for diner and console](https://app.clickup.com/t/86bcqxkwf). Review and merge PR #41 before triggering the trusted workflow for PR #37.

## October 26 follow-up

The initial October 26 check found PR #41 merged into `develop` as `aa7c717` with green CI and `PREVIEW_DEPLOYMENT_ENABLED=true`, while `main` still lacked the workflow/helper. The activation and lifecycle evidence below supersedes that missing-workflow state.

The follow-up supplies the preview slice to `main`, adds exact-SHA readiness, and makes the symlink regression portable: Windows uses a directory junction, while other platforms use a directory symlink. Both exercise the same real `lstat` rejection; no security assertion is skipped.

Read-only provider inspection confirmed the two existing preview projects pass isolation preflight and the manual PR #37 aliases still return HTTP 200 with restrictive CSP. Both staging frontends and authenticated team data reads remain available, with unchanged deployed versions. See the [dated operations evidence](operations.md#pr-preview-repair--october-26-2026). No hosted deployment, cleanup or credential change was performed in this pass.

GitHub changed this event's source/reference to the default branch in December 2025. See the [official event and environment-protection change](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/). Keep the preview environment restricted to trusted branches; do not work around activation by giving a PR-head workflow secrets.

## Hosted lifecycle acceptance — October 26

[PR #47](https://github.com/vivienk/peekaplate/pull/47) merged the reviewed delivery slice into `main` as `ab6f9c4`; [main CI passed](https://github.com/vivienk/peekaplate/actions/runs/40393030720). The following checks used synthetic PR #48 at `1339089062625ebde44b52b00be2a14ae6ae48ab`:

- [Automatic preview run](https://github.com/vivienk/peekaplate/actions/runs/40393096652): build and deploy passed using GitHub-held credentials. Build took 19 seconds and deploy 41 seconds; the full run including queue time took 84 seconds.
- Both provider records were `preview` deployments under `pr-48`, with the exact head SHA. Both aliases returned that same trusted marker and HTTP 200 with `connect-src 'none'`.
- Both rendered screens were visible at 390×844, without uncaught JavaScript errors or horizontal overflow. These are browser checks, not real-phone performance measurements.
- One [bot comment](https://github.com/vivienk/peekaplate/pull/48#issuecomment-6426202331) contained both links and the correct commit.
- Closing the test PR triggered [automatic cleanup](https://github.com/vivienk/peekaplate/actions/runs/40393553935). The cleanup job passed in 16 seconds; provider readback found no `pr-48` deployments in either project. The same bot comment changed to removed. Edge retirement briefly returned transient errors; by `2026-10-26T20:13:56Z`, both page and marker URLs returned 404.

The test PR is reopened for the final reviewed documentation/merge step; its eventual merge repeats cleanup. No Worker, Supabase, Queue/R2, PostHog or production deployment was changed. Repeat lifecycle acceptance when changing the workflow or provider configuration.
