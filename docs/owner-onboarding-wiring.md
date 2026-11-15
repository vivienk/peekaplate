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
- Harshita's pending PR163 owns verification-only S10 integration.
  Required owner confirmations, optional verification badges, approval and
  publication must remain separate. Use the returned diner URL after an explicit
  successful publish. The [S13 handoff](owner-publish-handoff.md)
  publishes already prepared snapshots through the existing owner commands.
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
