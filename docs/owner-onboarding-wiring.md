# Owner menu wiring from merged code

This slice connects the signed-in owner shell to the existing staff-authorized
menu APIs. DES-02 guides the multi-source journey, but this is not the complete
owner onboarding or publication flow.

## Why PR156 was merged

The source/upload/processing screens and authentication were already merged.
Ehab's PR156 supplied their reusable API client, draft/review mappings and source
evidence editor. Its draft dependencies were those screens and sign-in. Sai
reviewed and fixed the client boundaries, ran local checks and waited for green
GitHub CI before merging it. This avoided writing a competing menu client.
No other pending team PR is merged by this wiring task.

## Connected flow

1. Sign in, then select a restaurant returned by GET /staff/venues. Accounts
   without membership receive no restaurant authority or sample restaurant.
2. Open Menu and use the merged S06 picker: paste a URL, upload photos/PDF,
   or add a dish manually. Add further sources from Menu as needed.
   Each intake group remains one PDF or up to five photos. Further sources and
   saved dishes stay together in that restaurant's workspace. Supported URL
   intake is a direct public menu PDF/image, not general HTML crawling.
3. Upload original bytes with SHA-256 manifests and stable retry identities.
   Replacing/removing a selection cancels the old immutable group and creates
   another; historical evidence is not overwritten.
4. Processing reads stored job status. Queued work stays queued, status polls
   do not overlap and successful source results survive partial failures.
5. Review an extracted dish alongside its stored source evidence. Save changes
   with the review API, with separate command identities for separate candidates.
   Extracted ingredients remain proposed and allergens remain unknown.
6. Add/edit a manual dish, save its full snapshot, upload an original private
   JPEG/PNG and attach its returned photo ID. Reload retrieves saved fields and
   authorized image bytes. Save does not approve a dish/photo or publish a menu.

The client retrieves a fresh actor-bound token for every request, allows only
the existing local/staging API origins, refuses redirects and validates consumed
responses. Image URLs contain no tokens; temporary blob URLs are revoked on exit.
Account/restaurant changes abort old requests. Access denial clears private state.
Unsaved dish edits warn before leaving, and late imports cannot reopen an
abandoned screen. No new backend route, table, migration or membership grant is
part of this narrowed slice.

## Remaining boundaries

- S05 restaurant-details persistence has no merged API. Its backend expansion is
  parked locally and is not included here. The workspace does not simulate saved
  setup/verification status.
- Required serving-size persistence, source consolidation and automatic autosave
  are not supplied by this wiring. Existing draft fields remain unchanged.
- Harshita's pending PR163 still owns final menu review/publish screen integration.
  Required owner confirmations, optional verification badges, approval and
  publication must remain separate. Use the returned diner URL after an explicit
  successful publish; this workspace sends no publication command.
- Pending AI, portion/2.5D and other team PRs remain separate. No unfinished
  screen is used as a live fallback.

## Verification and rollout

The workspace Chromium suite uses the real Supabase SDK and rendered controls
with synthetic provider/API HTTP. It covers original-photo save/reload, mixed
sources, immutable replacement, corrections, slow polling, late imports, stale
saves and account/access changes. Those results are local, not hosted acceptance.

Hosted readback on November15 found 13 migration entries, latest20261114010000,
and the existing draft/upload tables. No profile migration was applied. Staging
API was version0c60d064-c804-44a0-b4f3-3aaf44e64848 (main20e52a3), and extraction
host60b99488-78f3-4d6a-a497-2ff1597f1ab7 predates merged PR188. All four Queues
were empty and paused. Recheck exact release versions before rollout; keep
normal delivery paused outside an authorized synthetic test window.

Record each rollout's exact commit and authenticated screen evidence on its
release PR. Local fixture checks alone are not hosted screen acceptance.
Deploy PR188's paired host/container before claiming hosted provider-budget
enforcement. A zero-provider reserve probe uses its own disposable job identity.

## Screen composition correction — November 15

The first wiring release used a plain workspace list instead of the authors'
dashboard and Screen 9 composition. Functional save/upload checks did not prove
visual alignment. The correction uses the merged `FirstDashboard` content in
`OwnerShell`, the original three-option `ChooseMenuSource` in `OnboardingLayout`,
and shared `DishFormFrame` / `MenuTable` markup extracted from the owner demo.
The demo retains its existing actions and data; live presentation imports no
sample menu, thumbnails or AI suggestion generators.

The existing Figma Design file was inspected for cross-checking, not recreated:
dashboard `1669:3682`, source choice `2292:9846`, upload `1936:5274`, and dish
form `2470:19843`. The older dashboard pointer `2346:6206` no longer resolves.
Authored source remains the implementation reference. Responsive desktop/mobile
screenshots cover every connected page and are retained with the review evidence.

Known differences follow the persisted API rather than sample design data:
details/publication status can be unavailable; no fabricated progress or activity
is shown. Currency, unknown/proposed/confirmed food fields and extraction evidence
remain explicit. Serving size and 2.5D controls are marked unconnected. Save keeps
a private draft; final review/publication is still a separate integration.

The previous authenticated November 15 run verified original-photo persistence,
manual draft reload, extracted correction save/reload and restoration, partial
upload retention and revoked-access cleanup against staging. It did not establish
visual fidelity. This correction requires its own Pages rollout and screenshot
readback; provider extraction is not rerun for a presentation-only change.

Independent review also caught an inherited global menu-heading style and a
sidebar hint promising unsupported publication unlocks. The live surface now
uses the author's scoped 28px heading and describes unavailable connections
without changing the demo. Browser-dropped files with no MIME use the existing
extension policy to declare PDF/JPEG/PNG while retaining the original bytes;
server signature/hash verification remains authoritative.

## PR206 OCR screen integration

This follow-up is stacked on `feat/s8-menu-review` at
`7884ed1dddb9680383eb898532e844259c1790e8`; PR206 is still open and itself
stacks on PR163. Retarget after those dependencies merge. Existing integration
points are reused, not replaced:

| Screen | Client / backend boundary |
| --- | --- |
| S06 source picker | `OwnerMenuWorkspace.nextSource` selects URL, upload or manual entry. |
| S07 URL | `submitMenuUrl` calls `POST /venues/:venueId/menus/url`; the server materializes a validated direct PDF/image URL. |
| S07 upload | `createUploadGroup` and `uploadGroupFile` send SHA-256 manifests and original bytes to `menus/upload-groups` and its file route. |
| S08 processing | `listJobs` reads persisted states; `listDrafts` runs afterward so a terminal status is not paired with a draft read started earlier. The existing `menuProcessingState` controls empty/failure screens and review navigation for the selected import only. |
| S08/S10 review | `draftToReviewDish` displays saved candidates. Complete/partial imports open review; older drafts cannot turn an empty or failed import into success. |
| S09 correction | `openReviewSession` loads validated stored evidence; `reviewCandidate` sends versioned, idempotent corrections. No browser extraction/provider call is added. |
| Retry/cancel | Existing job commands remain server-authorized. Exhausted attempts have no retry button; an explicit successful retry opens processing. No automatic retry or new job is used to evade limits. |

The backend route module is `backend/src/owner-menu-routes.ts`. Existing
`backend/src/ingestion/orchestrator.ts` coordinates durable jobs, private reports
and draft persistence; `backend/src/extraction-host.ts` hosts extraction and
atomic provider reservations; Python `provider_budget.py` fails closed before
outbound provider calls. All remain unchanged. UI states do not enable Queue
delivery or establish hosted provider availability. Historical staging readbacks
above require fresh verification before rollout; this change deploys nothing,
changes no secrets/budgets, and sends no paid provider request.

PR206's remaining boundaries still apply: S05 details are memory-only; extracted
photo attachment and serving-size persistence lack the needed connection;
review confirmations are not a persisted verification decision. Complete
verification is local UI state, not approval or publication. A real hosted
end-to-end acceptance run remains separate from synthetic browser coverage.
