# Screen preservation and staging wiring

Scope: the correction to main `79aa7f9`, following the deployed `ba70ce9` release. This is one correction/release PR, not a replacement frontend. Source comparison establishes reuse; browser tests establish the listed behavior. Neither proves every future screen or physical device is complete.

## What was wrong and what changes

- The live menu workspace still used a fallback draft table instead of the authored S10 review screen. It now composes the original `ReviewDishes` implementation from [#163](https://github.com/vivienk/peekaplate/pull/163), with authenticated verification/photo-approval methods in the existing API client. S10 verifies only; it does not approve a dish for publication or publish a menu.
- Dish performance displayed the evidence table rather than Jeffin's performance layout. Demo and live reports now share `PerfFrame` and the original performance CSS. The live adapter shows only actual report fields; it does not import sample restaurant metrics. Unsupported category/period metrics remain unavailable.
- The published 2.5D viewer lacked an entry into the existing camera portal. Its explicit table-view action now loads that portal lazily. The original photo, CSS viewer, camera controls and failure fallback are retained. There is no calibrated-size or physical-phone acceptance claim.
- The diner already contained the approved-ingredient-artwork client, but main/staging lacked #165's API, storage projection and processing entrypoints. This release promotes those existing modules and their #51 ingredient-review dependency. It uses the existing private R2 bucket; generation is an operator process, followed by explicit review of the exact bytes, not an automatic public image on menu upload.
- Owner/editor authorization was repeated in two command paths. Both now reuse `authorizeStaffVenue` inside the existing transaction, retaining the membership lock. `CommandError` moves to a neutral leaf and retains its existing re-export. Publication's owner-only policy is unchanged.

## Authored screen map

| Flow | Existing implementation reused | Wiring in this correction |
| --- | --- | --- |
| Sign in, signup, recovery | #143 / #146 auth components | No screen replacement |
| Restaurant setup and shell | #125 / #139 `OwnerShell`, `FirstDashboardContent` | Existing account menu; desktop side columns stay fixed while center scrolls |
| Choose source, URL, photo, PDF, processing | #171 onboarding components | Existing upload/job client retained |
| Add/edit a saved dish | #156 `DishEditor`, shared #172 form presentation | Saved evidence/unknown fields retained |
| S10 review | #163 `ReviewDishes`, `reviewDishes`, `review.css` | Real draft/photo verification; retry identities and access cleanup retained |
| S13 publish | Existing temporary `OwnerPublish` | Intentionally temporary; explicit approval/publish and returned diner URL unchanged |
| Dish performance | Jeffin's `Perf` presentation | One shared frame/style source, actual report adapter and privacy statuses |
| Diner Menu, Search, Detail, Saved, Compare | Existing merged diner screens, including #196 | No replacement screen |
| 2.5D / camera portion view | #162 `portionPreview` / `portionAR` | Explicit production entry and teardown |
| Ingredient artwork | #165 processing, review, delivery and diner client | Existing backend migration/routes and private R2 prefix connected |

`packages/tokens` and `packages/ui` are unchanged. The performance CSS is moved into a shared import rather than copied into a second stylesheet. Its local aliases resolve to the same existing token values. Original demo controllers remain useful as synthetic previews; they are not activated as live reporting or authorization.

## Audit distinctions

Release PRs promoting the same feature to main are not duplicate runtime implementations. The persisted dish editor and synthetic form demo have different evidence/state contracts and already share presentation. The draft correction adapter and contract-level effective-field resolver also accept different shapes; this audit did not establish that they are interchangeable. They are retained. Loading, error, no-access and account controls are integration states, not evidence that a Figma screen has been implemented.

The original S10 source is imported without merging all of #163. Its separate PR must be reconciled against this source reuse; do not replace the screen again. Remove/Undo remains unavailable in the live table because no persisted delete command exists. Extracted candidates still need their supported correction/verification contract; this PR does not invent allergen confirmation or photo evidence when those fields are absent.

## Ingredient pipeline and rollout

Use [the original ingredient pipeline guide](ingredient-icon-pipeline.md). Exact existing modules are promoted from develop; the narrow scheduled adapter omits unrelated order-import retention. The six-hour artwork cleanup runs in dry-run mode initially. It never lists/deletes outside the artwork prefix. A later destructive-cleanup activation requires an explicit operator decision.

1. Apply the existing forward migration `20261113020000` to the established staging project; verify RLS and the restricted runtime grants.
2. Deploy the reviewed exact main API, console and existing routing diner Pages builds. Keep extraction deployment, Queue pause state, provider budgets, production domains and `.io` untouched.
3. Use the existing fictional restaurant and retained diner URL. Verify owner setup/menu/editor/performance, explicit publish behavior, detail/viewer/camera fallback, and approved artwork/read/revocation. Preserve the linked test account and its authorized testing access.
4. Record deployment IDs and hosted screenshots below. Do not label provider mocks, local browser screenshots or local PostgreSQL tests as hosted acceptance.

## Verification record

- PASS: production published-portion browser regression, 2 cases; 30 portion units and bundle budget check. Camera/WebGL failure keeps the menu usable.
- PASS: authored S10/client tests, 79 units; focused browser save/reload, conflict retry, stale-session and verification-only checks.
- PASS: live performance tests, 24 units; desktop/mobile layout, center-only scrolling and account/menu regressions.
- PASS: local database upgrade and real Worker/database integration, 235 SQL assertions and 125 integration tests, including artwork approval/replay/revocation/isolation.
- PASS: frozen Python processing/service suite, 573 tests in 46.998 seconds with Windows UTF-8 mode; no paid provider traffic.
- PASS: production build and API dry-run; initial diner JavaScript 74,817 gzip bytes against 150,000 limit. The camera chunk stays lazy.
- PASS: separate Astra screen-preservation/architecture and Sol backend/artwork reviews at `36ef701`; final verification-only changes receive a separate pinned delta review before merge.
- PASS: final dedicated browser suites with two workers: PostHog 9 (12.8s), routing 7 (5.9s), auth 12 (18.1s), workspace 43 (45.8s; 3 pre-existing skips), published portion 2 (6.9s). Workspace includes heading-order accessibility and the unchanged 16px card-title styling.
- The eight-worker default suite passed 259 cases with 3 skips, then timed out in the existing 360-step SDK withdrawal test before its final assertion. The entire SDK file passed 5/5 with two workers (18.6s; withdrawal case 7.9s). This is a focused recovery, not an uninterrupted full-suite PASS. Final Linux CI must pass before merge.
- Corrected the dedicated-test discovery, fake-clock/IndexedDB delivery race and an invalid performance heading level. The latter changes semantics only; authored sizing remains unchanged. Refresh context after all source/audit edits, then check the committed graph.
- Final Astra review caught a chart-heading selector lost during the semantic fix. Retaining the original `h3` selector beside the new card-title selector restores the shared typography. The new browser assertion failed at 18.72px without it, then both performance/accessibility cases passed at 16px (4.5s). This is corrected source, not an accepted visual deviation.
- NOT RUN: corrected hosted rollout, fresh provider generation, physical-phone camera/scale acceptance. The existing staged artwork table was absent at preflight. These statuses must be replaced only with observed evidence.

## Remaining product boundaries

Only S13 is an intentionally temporary screen. Restaurant-profile persistence, unavailable Overview/Actions data, live owner-AI activation, unsupported report metrics, automatic trusted draft-to-bundle preparation and physical-phone calibration are not made complete by this correction. No sample metrics, inferred food facts or fabricated setup success are used to hide them.
