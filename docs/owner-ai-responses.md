# Owner dashboard Responses connection

This development integration connects the owner dashboard panel to a server-side
Responses adapter. It is not deployed and does not enable production reports.
It builds on the AI report validation and dashboard preview branches (#112/#124).

## Behavior and authority

`POST /api/v1/venues/:venueId/ai/analysis` accepts only a dish ID and one review goal
(menu, engagement or CRM). The normal Worker verifies the signed owner session and
uses the existing owner report reader, which checks current owner membership and
reads in a tenant-scoped read-only transaction. The browser cannot provide metrics,
a prompt, a model, a policy or OpenAI credentials. Cross-origin requests outside the
console allowlist are denied, even when they carry an otherwise valid token.

The route is off unless `OWNER_AI_RESPONSES_ENABLED=true`, `APP_ENV` is local or
staging, and the server-approved synthetic venue matches. Production is rejected.
The separate owner-analysis.v1 contract does not relax the existing deterministic
recommendation validator or pretend a new model policy has passed independent QA.

The adapter accepts only a validated public report projection. It withholds a
suggestion when freshness is unknown/stale, the report snapshot is over five
minutes old, or any of the three rates is unavailable/suppressed. Current real
report construction sets freshness to unknown; this connection preserves that
abstention rather than manufacturing fresh evidence. CRM always abstains because
the current report has no customer-retention evidence.

Only three numeric browsing rates and the goal reach OpenAI: no names, customer
records, counts, tenant IDs, free-text summaries, raw events or order data. One
fixed GPT-6 Luna request uses `/v1/responses`, `store:false`, no tools, no streaming,
a five-second timeout and at most 128 output tokens. No retry or provider fallback
occurs. Restricted Responses Write is sufficient; model-list access is not used.
The provider can select one permitted metric or abstain. Owner-visible text,
values, snapshot hash and review-only constraints are produced by the server/code,
not accepted as model-generated prose. This is a bounded review prompt, not a
forecast, business threshold, causal claim, or automatic menu/CRM action.

## Private local trial

Requirements: Node 24.16 or later in the 24.x line, pnpm 11.25, and the frozen
workspace dependencies. From the repository root:

```sh
python3 scripts/start-owner-ai-private.py
```

Enter the saved restricted key at the hidden Terminal prompt and the non-secret
OpenAI project ID at the next prompt. The launcher does not save the key. It is
held only in process memory/environment for this session and is removed from the
environment before starting the frontend child process. Never use VITE_ variables
for the key, paste it into chat, or put it in a tracked file.

Open `http://127.0.0.1:5174/owner-dashboard.html` and click **Review report** in the
AI panel. This page uses a clearly synthetic local report with an ephemeral local
session; it does not log in to Supabase or read a restaurant database. The local
backend binds only to 127.0.0.1:8792. A development-only same-origin proxy obtains
the ephemeral session. The OpenAI key never goes to the browser. Normal builds
force the local preview switch off and do not contain the proxy/session setup.

At most ten outbound provider attempts are permitted during one local server run.
Restarting resets that development guard. Each click may consume existing API
credits. Ctrl+C stops the local services; the password-manager copy remains yours.
No billing setting, auto-recharge setting, purchase, hosted secret or deployment is
changed by the launcher. Existing OpenAI budget alerts remain soft thresholds.

## Hosted activation remains separate

The backend code is wired into createApp but not deployed. Hosting requires the
restricted key in a Worker secret named `OWNER_AI_OPENAI_API_KEY` and a server-only
`OWNER_AI_OPENAI_PROJECT_ID`. Staging additionally requires `OWNER_AI_RATE_LIMITER`
(a Cloudflare rate limiter binding); missing configuration fails closed. These
bindings were not provisioned by this change. Provider rate limiting is not a
monthly spending cap. Choose and verify an operational budget before activation.

The reusable `OwnerAnalysisPanel` takes the authenticated caller's venue/dish and
`createOwnerAnalysisClient`, whose `getAccessToken` must read the current owner
session. The local dashboard harness supplies only its synthetic session. The
hosted authentication/dashboard handoff, trusted freshness/producer coverage,
independent recommendation evaluation and real owner journey remain acceptance
gates. Do not replace them with fixture freshness or a browser-supplied token.

## Verification

`pnpm exec vitest run backend/src/owner-ai frontend/console/src/owner-dashboard/ai-preview`
checks provider payload minimization, zero preservation, suppression/freshness,
wrong tenant, denied membership, configuration gates, no retries, rate reservation,
refusals/malformed outputs and frontend result matching.

`pnpm exec playwright test --config playwright.owner-ai.config.ts` runs the actual
local dashboard/backend route with a mock provider. It does not consume credits
or establish real model quality. It covers desktop and mobile requests, CRM
abstention and failure clearing. The prior single-request live key probe is
separate from this integrated browser test.
