# Owner signup, sign-in and email recovery

The owner screens use Supabase Auth. Supabase sends the email through Resend;
the browser receives only a publishable project key. Database passwords, SMTP
credentials and service-role/secret keys never belong in the frontend.

## What is connected

PR #143 connects signup, confirmed-email sign-in, confirmation callbacks, session
restoration and local-device sign-out. PR #146 adds password-recovery email and
reset. Review and merge #143 before #146, after the dashboard/owner flow is ready.
Both PRs remain unmerged during this integration task.

`/owner-auth.html` is the real auth entry. `/owner-sign-in.html` stays a labelled
synthetic preview demo: never enter a real password there. PR previews cannot
enable the provider and contain no real auth callback pages.

Entering an email does **not** query whether an account exists. Continue opens
Sign in, with Create account available. Signup and recovery replies do not disclose
account existence. Wrong details and provider/network failures are different typed
outcomes; raw provider messages never reach the screen. Supabase owns throttling;
the UI respects supplied cooldowns and does not invent account lockouts.

Email confirmation is required. An unexpected signup session fails closed rather
than bypassing confirmation. A confirmed sign-in identifies a person only: the
Worker still checks restaurant membership on every private restaurant request.
No account creation, email confirmation or browser field creates that membership.

The current backend has no authenticated restaurant-list/setup-progress contract.
The auth entry therefore shows an honest signed-in handoff state, not an invented
dashboard or publication status. Connect that state to #139 using server-returned
venue/setup facts before merging or calling the owner flow complete.

## Exact redirect allowlist

In Supabase **Authentication → URL Configuration**, add these exact entries to
the existing staging project. Keep the Site URL `https://peekaplate.app` and keep
email confirmation enabled.

| Purpose | Staging console | Local verification |
| --- | --- | --- |
| Signup confirmation | `https://peekaplate-console-staging.pages.dev/auth-confirm.html` | `http://127.0.0.1:5174/auth-confirm.html` |
| Password recovery/reset | `https://peekaplate-console-staging.pages.dev/auth-reset.html` | `http://127.0.0.1:5174/auth-reset.html` |

These are callback pages, not the synthetic PR links. Do not allow wildcard PR
origins. Production would need `https://peekaplate.app/auth-confirm.html` and
`https://peekaplate.app/auth-reset.html` **only after confirming that domain serves
this console build**. No production routing or auth activation is performed here.
The staging project is not a separately isolated production Auth database.

Supabase uses its standard `{{ .ConfirmationURL }}` template link; it preserves
the requested allowed redirect. Do not replace it with the Site URL. Disable
email link tracking in the mail provider so links are not rewritten. Resend sender
and DNS setup do not establish delivery: check the received email and complete
the journey before marking delivery PASS.

## Public configuration and local run

Copy `frontend/console/.env.example` to an ignored `.env.local`, and configure:

```dotenv
VITE_OWNER_AUTH_ENABLED=true
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
```

Start `pnpm --filter @peekaplate/console dev`, then open
`http://127.0.0.1:5174/owner-auth.html`. Configuration is off by default and only
exact approved console origins can enable it. The SDK is pinned in the lockfile.
PR preview builds force the connection off even if ambient config is present.

## Session and callback rules

- The official SDK creates the PKCE verifier and owns session persistence/refresh.
  Confirmation/recovery emails must be opened in the **same browser and origin**
  that requested them. Use the newest link if several requests were made. A new
  device, blocked storage, expired/reused code or wrong flow must fail safely.
- Callback pages remove query/fragment credentials from the address bar before
  starting provider requests, use `no-referrer`, and contain no analytics. A user
  selects Continue before exchanging a confirmation code. Arbitrary `next` URLs,
  duplicate codes and implicit token fragments are rejected.
- Confirmation verifies the user with Supabase, ends its callback session and
  returns to sign-in. It never accepts a pre-existing session as confirmation.
- Sign-out ends this device's refresh session. Already-issued access JWTs can
  remain valid until expiry; backend membership checks remain authoritative.
- Recovery must prove a fresh recovery exchange before changing a password;
  merely visiting the reset page or having a normal session is insufficient.
  Reset completion signs out and returns to Sign in. PR #146 owns that behavior.
  If the password changed but server sign-out cannot be confirmed, the success
  screen explicitly warns about that partial result instead of suggesting the
  password update failed. The pinned SDK removes the local session before its
  local-scope revocation request. Failed callback exchanges preserve any unrelated
  existing owner session.
  Recovery permission is bound to that exchange's token, and password updates use
  an isolated in-memory SDK session. Another tab signing in/out or refreshing the
  shared session cancels recovery; an in-flight account switch cannot change the
  password request's actor. A cancelled attempt requires a fresh recovery email.

## Verification and remaining gates

`playwright.auth.config.ts` runs real Chromium and the actual SDK against
synthetic provider HTTP responses. It is part of `pnpm verify test:e2e`; these
tests do not send email or establish hosted acceptance. Provider adapter and URL
parser tests run in the ordinary unit suite. Build checks keep demos and real
auth entry/callbacks separate.

Before release, capture separate results for real signup delivery, confirmation,
unconfirmed denial, wrong-details handling, session restoration/sign-out,
recovery delivery, expired/reused links, password update and old/new password
checks. Keep addresses, passwords, email links, codes and tokens out of committed
evidence. Record only sanitized check results and the tested source revision.

November 11 follow-up: the Site URL matches and all four exact local/staging
redirect URLs above are now verified in Supabase. Public Auth settings return
200 with email signup enabled and email confirmation required. The Developer
role remains unable to edit those settings; Vivien configured the allowlist.
Actual email delivery/confirmation/reset await the manual signup/password step.
Hosted dashboard handoff remains unverified. Neither PR is merged or deployed.
