# PR previews

A PR preview is a temporary copy of the diner and console pages built from one pull request. Design, product and QA reviewers can open it in a browser without running the code locally.

## For reviewers

1. Open the pull request on GitHub.
2. Find the **Preview** comment posted by `github-actions[bot]`. It links to both apps:
   - Diner: `https://pr-<number>.peekaplate-diner-preview.pages.dev`
   - Console: `https://pr-<number>.peekaplate-console-preview.pages.dev`
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

[`.github/workflows/deploy-preview.yml`](../.github/workflows/deploy-preview.yml) runs on `pull_request_target` from the trusted base revision, with three isolated jobs. It does not use PR-authored workflow code. There are no path filters, so closing a PR always schedules cleanup:

- **build** runs for same-repository PRs. It checks out the exact PR head SHA with persisted Git credentials disabled, installs dependencies, builds both apps with analytics disabled and uploads the files as a three-day artifact. It has no deployment credentials.
- **deploy** runs no PR code. It checks out only the trusted base, rejects server-side functions, Workers, redirects, configuration and symlinks in the artifact, verifies both target projects, and uploads static files with Wrangler to the dedicated `peekaplate-diner-preview` and `peekaplate-console-preview` Pages projects, using the branch alias `pr-<number>`. It checks that both links return 200, then posts or updates the PR comment.
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

1. Merge this workflow into `develop`. The `pull_request_target` workflow and deployment helper must exist in the trusted base. PR #37 already targets `develop`. Manual cleanup also requires the workflow on the default branch (`main`) before GitHub exposes dispatch.
2. Push a commit to PR #37 or close and reopen it.
3. Confirm the **PR preview** check passes, the comment shows both links, and both pages load with the PR's tokens.
4. Record the run link, commit and result in [operations](operations.md).
5. After PR #37 closes, confirm the cleanup job deleted its deployments and the links stop working.

## October 25 verification boundary

- PR #37 head `23cfe85f7d0a823a1e8aa09092c54e6ed203266f` has passing existing CI. Both local frontend builds and the static artifact sanitizer pass; this is not a preview deployment result.
- GitHub readback confirmed the preview token secret name and nonempty account variable. Secret values were not read; token scope/validity remains unverified.
- Preview environment branch restrictions were set to `develop` and `main`.
- Repository variable `PREVIEW_DEPLOYMENT_ENABLED` is absent, so deployment stays off.
- Live Cloudflare project inspection was blocked by a local connection failure. Project existence/configuration and live deploy/cleanup remain unverified.
- Continue tracking [PR preview deployments for diner and console](https://app.clickup.com/t/86bcqxkwf). Review and merge PR #41 before triggering the trusted workflow for PR #37.
