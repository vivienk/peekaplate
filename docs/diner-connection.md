# Published diner menu connection

For prepared `peekaplate.app/diner/<restaurant>` links and the Cloudflare/domain
handoff, see [restaurant URLs](restaurant-urls.md). Hosting and owner-link
enrollment remain separate from the existing published-menu reader below.

The diner can now read an approved menu through the existing public API, verify
the exact downloaded bundle bytes, and display its approved public fields.
This implements the connection between the merged DIN-03 loader and S4-RES
producer. It does not approve restaurant facts or complete pilot tracking.

## Flow

1. A QR/link opens `/venues/<venue UUID>/menus/<menu UUID>` on the diner site.
2. The diner fetches the publication pointer from the configured public API with
   `cache: no-store`. Missing/draft/withdrawn menus return an unavailable screen.
3. It downloads the public bundle without credentials. The shared
   `verifyPublicMenuContentBytes` hashes its **exact bytes before decoding or
   parsing**. Wrong hashes, malformed data and pointer/bundle identity mismatches
   fail closed; no dish or tracking token is exposed by that failed load.
4. A verified delivery supplies the in-memory menu token to the existing
   canonical sender. One consent choice still gates canonical and PostHog
   dispatch independently. GPC/DNT and fixture silence remain enforced.
5. A refresh renews the token and atomically swaps a changed publication.
   A detected 404 stops new collection and queued work at both destinations,
   without changing the diner's consent choice. The already displayed menu stays
   usable. Collection also stops at the current token's expiry if refresh hangs.
   Remounting aborts the old load so it cannot restore an obsolete token.

Withdrawal detection follows the existing scheduled re-read: currently five
minutes before the 30-minute token expires. This is not push/immediate withdrawal.
Already-started network requests cannot be recalled. Previously public immutable
files can remain reachable; the publication pointer controls current availability.

## Build configuration

Local/preview builds default to `VITE_MENU_SOURCE=fixture`. They do not fetch a
live menu or send fixture events. Do not change the isolated PR-preview workflow.

For the reviewed staging diner build only:

```dotenv
VITE_MENU_SOURCE=live
VITE_PUBLIC_API_URL=https://peekaplate-api-staging.vxkong.workers.dev
```

Reuse the existing staging `VITE_POSTHOG_*` public configuration from the
approved project/origin; never use a personal API token, database password or
service-role key. Build with `--mode staging`. Static Pages settings are baked
into JavaScript; changing a dashboard variable does not update an existing build.
An unqualified `/` cannot select a restaurant and shows unavailable in live mode.

## Reuse the existing hosting

- App: `peekaplate-diner-staging.pages.dev`, existing Pages project, branch `main`.
- Public files: pinned deployment URLs on that **same project**. Upload only the
  exact public bundle JSON and card/detail WebPs. Never upload source originals,
  manifests, capture references, handoff reports, credentials or private R2 data.
- The synthetic photo snapshot is `80c72317`; bundle snapshot is `68d424e7`.
  They use immutable caching, `noindex` and exact bundle CORS for the staging
  diner origin. One bundle deliberately has incorrect bytes for rejection QA.
- Pin `https://<deployment-id>.peekaplate-diner-staging.pages.dev/...`, not the
  mutable `synthetic-menu-*` alias. Retain every referenced deployment; normal app
  uploads must not delete these snapshots. The PR-preview cleanup selects only
  its own `pr-<number>` branches.
- `peekaplate-staging-assets` stays private: it contains observation archives and
  ingestion reports. This connection needs no new bucket, project or Worker.

This release deploys the diner Pages artifact only. The existing API version,
console, extraction service, database schema, Queue settings and production
resources are outside the deployment. Both staging Queues remain paused.

## Verification and acceptance boundary

Local browser tests in `tests/e2e/published-integrity.spec.ts` exercise the real
loader, byte verifier and refresher with synthetic HTTP responses. They cover a
valid display, tampered bytes, a fresh withdrawn menu and active withdrawal with
positive/negative dispatch controls. Unit tests additionally cover malformed
UTF-8/JSON/schema, identity mismatch, delayed SDK loading and token expiry.

Hosted acceptance uses the genuine staging staff API to approve, publish and
withdraw three labelled synthetic menus, then the actual deployed diner:

- [ ] Valid pointer/bundle and display photos load; approved dish details render.
- [ ] The tampered bundle is rejected without displaying its altered fields.
- [ ] A fresh withdrawn menu is unavailable and does not fetch its bundle.
- [ ] An active menu's scheduled refresh sees withdrawal, stops re-reading and
      starts no new tracking requests; the existing screen remains usable.
- [ ] Pinned bundle/photo URLs and exact CORS still work after app deployment.
- [ ] All synthetic menus are withdrawn; temporary owner membership returns to
      viewer; the genuine test session ends. API/console/Queues remain unchanged.

The dated acceptance comment in [connection PR #136](https://github.com/vivienk/peekaplate/pull/136)
and its linked staging release records observed results, exact main SHA and
Pages deployment ID. This checklist is the procedure, not a claim that a
merge alone passed it. Synthetic transport/UI checks do not certify restaurant
content, real-device usability, actual control triggers or real PostHog readback
and canonical/report reconciliation. Those remain the DATA-01 pilot acceptance
work with the relevant frontend integrations.

Local November 10 verification before deployment:

| Check | Result | Wall time |
|---|---|---|
| `TEST_WORKERD=1 pnpm check` | 1,204 unit + 72 script tests; lint/types/context/docs PASS | 26.770 s after main reconciliation |
| `pnpm exec playwright test --workers=1` | 115 Chromium tests PASS | 95.970 s |
| `pnpm exec playwright test --config playwright.posthog.config.ts --workers=1` | 9 intercepted SDK browser tests PASS | 19.078 s |
| `pnpm verify build` | Frontends and Worker dry-run PASS | 9.525 s |
| `pnpm verify test:db` | 213 SQL assertions + 86 PostgreSQL/Worker tests PASS | 61.924 s |

The prior main report release was reconciled without losing its synthetic-only
configuration, runbook, report tests or error history. No API deployment is part
of this diner release.
