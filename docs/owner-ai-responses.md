# Owner dashboard Responses connection

The owner dashboard question panel reads an authorized report through the Worker.
The legacy analysis route separately connects to the server-side Responses adapter.
Both are off by default and depend on the existing report configuration.
It builds on the AI report validation and dashboard preview branches (#112/#124).

## Behavior and authority

The browser client allows only the existing exact local/staging API origins and
the exact loopback development proxy. It checks cancellation around session
lookup and preserves typed 401/403 denials for the signed-in workspace to clear
or refresh access. Provider credentials remain server-only. Origin validation
is a dependency-free shared helper, keeping unrelated report contracts out of
the synthetic demo dependency path.

The signed-in owner shell mounts the question panel beside the displayed report
pages only when `VITE_OWNER_AI_ENABLED=true`. The panel is available to owners.
The draft stays with the signed-in owner and restaurant. Reissuing a reference
for the same snapshot preserves the draft, result and in-flight request. Any
expired-reference warning applies only to the failed reference. The next question
uses the renewed reference. Changing the displayed snapshot cancels
pending work and clears the result while keeping the same owner's draft. Session
or restaurant changes clear both. A 401 returns to sign-in. A 403 removes private
report output and refreshes restaurant access.

The Worker issues an `X-Owner-Report-Ref` response header on a successful owner
report GET when dashboard AI and the reference signing secret are configured. The
reference binds the report anchor and content digest to the authenticated owner,
restaurant and environment-specific source for up to 60 seconds. The frontend
passes the reference for the report currently on screen.

`POST /api/v1/venues/:venueId/ai/questions` accepts `{question}` and requires that
reference. It rechecks current owner access and reads the exact signed snapshot.
It answers supported English questions about the visible Dish Performance window,
including a named dish, comparisons, rankings and requests for a bar chart. For
example, ask “What was the save rate for Avocado Toast?” or “Chart open rate by
dish.” “Show visits by dish” and “Top two dishes by visits” read dish active
sessions. “How many restaurant visits were there this period?” reads the current
signed Overview menu-session count. “How many openings?” reads the separate dish-open
count. Dish-opening questions can also select the previous report period or compare
the current and previous periods. Each result uses its own Overview window,
which can start before the Dish Performance window. The same signed snapshot binds
both. A measured zero is displayed as zero. Unknown freshness, missing or suppressed values, or
incomplete whole-menu evidence produce an abstention. The route does not answer
about other restaurants, arbitrary date ranges, orders or unsupported metrics.
The signed reference also preserves whether display-action counts were visible
on the report. A question cannot enable counts hidden by the report settings.
It does not send questions, dish names or report data to an external provider.
Deploy the API route before publishing a console build that uses it.

The legacy `POST /api/v1/venues/:venueId/ai/analysis` accepts a dish ID and one review goal
(menu, engagement or CRM). The normal Worker verifies the signed owner session and
uses the existing owner report reader, which checks current owner membership and
reads the pinned window in a tenant-scoped read-only transaction. The Worker
recomputes the content digest before model evaluation and checks freshness against
the current request clock. A missing, expired, mismatched or changed reference
returns `409 report_reference_unavailable`; refresh the report before requesting
analysis again. The live panel offers Reload report on this conflict and requires
another explicit analysis request afterward. Sending the reference does not grant owner access. The browser
cannot provide metrics, a prompt, a model, a policy or OpenAI credentials.
The existing console origin allowlist applies to both routes. GET exposes the
reference header and POST permits it in preflight for allowed origins.

Both routes require `OWNER_AI_RESPONSES_ENABLED=true`. Local and staging are
restricted to configured synthetic venues. Production uses the existing owner
workflow and report gates. The legacy route also requires provider credentials.
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

## Safe provider diagnostics

Dashboard analysis and description assistance emit an `owner_ai_failure` event
in server logs when a configured request fails. Its only fields are `operation`,
`category`, `httpStatus`, and `providerCode`. Provider codes come from an explicit
allowlist; unknown or absent codes are `null`. No keys, project IDs, request IDs,
headers, prompts, report facts, provider messages or response prose are logged.
The public response remains `503 {"error":"service_unavailable"}`; that status
does not establish that OpenAI returned 503.

| Category | Meaning |
| --- | --- |
| `provider_http` | OpenAI returned a non-success HTTP status. Preserve that status even when its error body is missing, malformed, too large or stalls. |
| `timeout` / `transport` | The request or body could not complete. A null status means no HTTP response was observed. |
| `invalid_response` | JSON, the model envelope, usage or selected evidence failed validation. A 200 status means transport succeeded, not that the output is usable. |
| `configuration` / `request_budget` | A local configuration or reservation gate prevented the request. This is not an OpenAI error. |
| `internal` | The server could not read or validate the report, could not read a dish draft, or another local operation failed. |

Both adapters use the same five-second whole-response deadline and 32 KiB streamed
body limit, including error bodies. They make one attempt and never follow
redirects. Runtime project IDs accept the same alphanumeric, hyphen and underscore
characters as protected staging provisioning. Invalid configuration still fails
closed before consuming a reservation or calling OpenAI.

After an approved staging deployment, observe the existing Worker logs/tail during
one approved synthetic request and filter for `owner_ai_failure`. Diagnostic
events are not returned to the UI and cannot recover failures that occurred before
this code was deployed. No new provider storage, logging retention, feature
activation, credential provisioning or paid request is enabled by this change.

## Private local trial

These private launcher and mock-provider instructions apply to `develop`; the focused release omits that separate local trial tooling. Use `develop` for this trial.

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
Only this standalone fictional preview runs without a Worker report reference.

At most ten outbound provider attempts are permitted during one local server run.
Restarting resets that development guard. Each click may consume existing API
credits. Ctrl+C stops the local services; the password-manager copy remains yours.
No billing setting, auto-recharge setting, purchase, hosted secret or deployment is
changed by the launcher. Existing OpenAI budget alerts remain soft thresholds.

## Hosted activation remains separate

The backend code is wired into createApp and disabled until configured. Hosting requires the
restricted key in a Worker secret named `OWNER_AI_OPENAI_API_KEY` and a server-only
`OWNER_AI_OPENAI_PROJECT_ID`. Store a separate high-entropy printable key of at
least 48 characters in the Worker secret `OWNER_AI_REPORT_REFERENCE_SECRET`.
Staging additionally requires `OWNER_AI_RATE_LIMITER` (a Cloudflare rate limiter
binding). Missing analysis configuration keeps ordinary report reads available
and leaves analysis disabled. The rate-limiter binding is declared in staging
configuration; secrets and deliberate hosted activation still require the release operator.
Before enabling hosted analysis, use a matching console that carries the GET
reference to the POST. Verify the handoff with the mock provider first.
Provider rate limiting is not a monthly spending cap. Choose and verify an
operational budget before activation.

The reusable `OwnerAnalysisPanel` takes the authenticated caller's venue/dish and
`createOwnerAnalysisClient`, whose `getAccessToken` must read the current owner
session. The local dashboard harness supplies only its synthetic session. The
hosted authentication/dashboard handoff, trusted freshness/producer coverage,
independent recommendation evaluation and real owner journey remain acceptance
gates. Do not replace them with fixture freshness or a browser-supplied token.

## Verification

The separate [owner-flow retest](owner-flow-retest.md) documents optional S09
assistance. Description shortening retains literal supplied evidence; ingredient
proposals reuse persisted owner/extraction values without a provider call, recipe
completion or allergen inference. Both require explicit owner review. The new
ingredient integration has no hosted acceptance yet.

Allergen suggestions (Vivien, Nov 17; needs Sai's sign-off) are the one model
inference: one constrained request sends only the owner's typed dish name,
description and ingredients plus the saved menu line for that dish (OCR extraction
itself produces no allergen data), and the strict output schema allows only the
nine public allergen codes. Results
are `unverified`, not publishable and stay "Allergens not confirmed" until the
owner ticks the review box, whose text then names allergens. An empty answer is an
abstention, never an allergen-free claim. Published allergens therefore remain
explicit owner assertions ([public menu](public-menu.md)), but the suggestion
itself can be wrong, so it has no hosted or quality acceptance yet. AI credential provisioning
and trusted report freshness remain blocked; this change does not relax the
dashboard report's evidence gate or enable positive recommendations.

`pnpm exec vitest run backend/src/owner-ai frontend/console/src/owner-dashboard/ai-preview`
checks provider payload minimization, zero preservation, suppression/freshness,
wrong tenant, denied membership, configuration gates, no retries, rate reservation,
refusals/malformed outputs and frontend result matching.

`pnpm exec playwright test --config playwright.owner-ai.config.ts` runs the actual
local dashboard/backend route on `develop` with a mock provider. It does not consume credits
or establish real model quality. It covers desktop and mobile requests, CRM
abstention and failure clearing. The prior single-request live key probe is
separate from this integrated browser test.
