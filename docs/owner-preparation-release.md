# Owner-to-diner staging release

Prepared by Sai · November 16, 2026.

This focused main release reuses the team's merged implementations. It carries
official S13 from [#208](https://github.com/vivienk/peekaplate/pull/208), artwork
placeholders from [#210](https://github.com/vivienk/peekaplate/pull/210), canonical
profile/draft services from [#217](https://github.com/vivienk/peekaplate/pull/217)
and the authored screen corrections from
[#213](https://github.com/vivienk/peekaplate/pull/213). Reviewed automatic
preparation comes from [#216](https://github.com/vivienk/peekaplate/pull/216).
Screen 1 Terms/Privacy popups come from
[#201](https://github.com/vivienk/peekaplate/pull/201); reading a document never
accepts the agreement. It does not merge develop wholesale or add a replacement screen, profile,
producer, upload, OCR, storage or analytics pipeline.

## Flow to verify

1. Sign in at <https://peekaplate-console-staging.pages.dev/owner-auth>.
2. S05 saves restaurant details/logo through the canonical private profile API.
   S06 selects manual entry, URL, PDF or photos; S07 submits through the existing
   upload contract and S08 displays the real persisted processing job.
3. The existing Queue/extraction Worker/Python service returns reviewed-format
   drafts. S09 saves original photo, dish corrections, currency and serving
   information. Reload must restore those exact values.
4. S10 reviews, removes/restores and verifies active dishes; S11 confirms menu
   verification. Verification is separate from publication.
5. Preparation approves only verified active drafts through the existing
   canonical command, reuses stable dish identity, and calls the existing bundle
   producer. S13 previews the exact admitted snapshot with authenticated image
   reads; preparation alone exposes no menu or photo anonymously.
6. S13 explicitly approves/publishes. Only a successful publication returns the
   restaurant's diner URL for copy/share. That diner loads the same published
   revision; withdrawal prevents subsequent prepared-content reads.

Restaurant-detail verification remains team-owned. A new profile is
`submitted`, never silently `verified`. The dashboard's publish action waits
for that verification, while the existing Menu-page publication entry is
owner-permission based. Test and record both paths; using the Menu entry does
not establish dashboard verification acceptance.

## Preservation and release scope

- The authored S05–S13 markup, shared forms, tokens and official S13 presentation
  are reused. The owner image transport uses revocable blob URLs only for the
  preview presentation; approval hashes refer to the original snapshot.
- Existing camera entry remains deliberate. Matching serving-count calibration
  is required for measured placement. Newly prepared original photos do not
  acquire invented portion layers or physical measurements.
- Owner photos currently use their validated original bytes for card/detail.
  The existing Python asset pipeline already creates card-480/detail-1280 WebP;
  connecting that trusted path is separate from adding a new Worker encoder.
- Main's exact-origin CORS, observation consumer, extraction two-attempt budget,
  private R2 bucket and `INGREDIENT_ARTWORK_CLEANUP_DRY_RUN=true` are preserved.
  No unrelated order-import migrations/bindings are promoted.
- Owner AI stays off. #218's report-reference backend is merged into develop,
  but this non-AI release does not claim same-snapshot frontend forwarding,
  trusted freshness or live model acceptance.
- The `.io` homepage and production domains remain unchanged.

## Hosted preflight and clean handoff

Read-only checks found staging API `c6979a54`, console `2aa479ae`, and extraction
Worker version `ade63fef-a946-485d-aaee-9257542eed2f`. Those are pre-release
identities, not evidence that this release is deployed. Hosted migration history
contained 14 entries ending `20261114010000`; apply only missing reviewed owner
migrations `20261116010000`, `20261116020000` and `20261117010000` after approval.
Applied migrations remain immutable.

The observation primary was resumed under the requested testing authorization:
its 42-message backlog drained to zero and the DLQ stayed empty. The menu primary
and both DLQs remained paused and empty at preflight. Recheck before activation;
do not purge messages or remove the existing two-attempt provider guard.

Run a labelled fixture journey first, recording deployments, exact commands,
expected/actual results and a screenshot of every tested screen. Include empty
state, private preview, retries, save/reload, cross-restaurant denial, publish,
generated diner URL and withdrawal. Never label mocked or local results hosted.

After those tests, leave the shared demo login on an isolated **empty** test
restaurant: no profile, jobs, drafts, prepared menu or publication. Keep earlier
fixtures and personal accounts intact. Do not delete/reset linked accounts or
publish a password in this repository. Shared-login validation needs the current
password; one attempt using the earlier private file was rejected, with no reset
or repeated guessing.

Hosted release, migrations, clean-workspace access grant and genuine signed-in
acceptance remain **NOT RUN** until their final recorded approval/execution.

## Local assembly verification

The main-based release passed `pnpm check`: 1,727 unit tests (five existing
skips), 100 script tests, lint, strict types, context and documentation links.
`pnpm verify test:db` passed 278 SQL assertions across 14 files, 142 integration
tests and the actual local Worker smoke. The connected workspace suite passed
64 Chromium cases, including private preview, explicit publication, retries,
desktop/mobile screen evidence and access changes. `pnpm verify build` passed
both frontend builds and the staging Worker dry run.

These browser cases use synthetic provider/API HTTP fixtures. They are local
regressions, not evidence of live OCR, a hosted staff session or provider billing.
PR #219's Screen9-to-approved-2.5D asset work is explicitly excluded from this
release and is the next integration step.
