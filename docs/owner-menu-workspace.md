# Owner menu upload and manual drafts

This is the backend handoff for [FE-06, S06–S09](https://app.clickup.com/t/90141746115/86bcthzjc).
Ehab owns its screen integration; Nifemi/Harshita retain their assigned UI work.
Jeffin's #105 Add/Edit reference and #125/#139 shell do not establish live persistence.
Auth #143 → #146 remains a separate, unmerged connection. A signed-in user still
needs an owner/editor membership for the requested restaurant.

## Storage and authority

Reuse private R2 `peekaplate-staging-assets`, the existing menu-ingestion Queue,
Python extraction service and Supabase ingestion/review tables. Files stay in R2;
Supabase holds tenant-bound metadata, jobs, drafts and command receipts. No new
bucket, shared password or browser database access is required.

Migration `20261112010000` adds `menu_upload_group`, `dish_draft_photo`, ordered
group/upload state, fenced cancellation, explicit manual origin/version/fields
and approved revision facts. Both new tables force tenant RLS. Runtime receives
SELECT/INSERT only on these metadata tables; existing draft/job permissions remain.
Applied migrations are never edited. This migration depends on the existing
core/ingestion schema; it does not require applying unrelated order-import work.

All APIs below require a staff bearer token and current owner/editor permission.
Cross-restaurant and viewer requests are denied. Exact browser origins are
`https://peekaplate-console-staging.pages.dev` and `http://127.0.0.1:5174`.
Preview URLs receive no blanket CORS access. New workspace routes are staging/local
only. CORS does not grant membership or bypass authorization.

## Upload and resume

1. Compute each selected file's SHA-256 in the browser. POST JSON to
   `/venues/:venueId/menus/upload-groups`:

   ```json
   {"idempotencyKey":"client-generated-stable-key","files":[{"sourceType":"photo","sourceHash":"<64 lowercase hex characters>"}]}
   ```

   One PDF **or** one to five JPEG/PNG images. The backend saves an ordered
   manifest and returns `{group:{id,jobs}}`. The same key must retain the exact
   ordered types/hashes/count; changed reuse is 409. This manifest is a declaration,
   not evidence that any source was uploaded or checked.
2. PUT each file's raw bytes separately to
   `/venues/:venueId/menus/upload-groups/:groupId/files/:index` (zero-based).
   Set `Content-Type` and `Idempotency-Key` (16–128 letters/numbers/underscore/hyphen).
   Each file is limited to 12,000,000 bytes; PDFs must parse and contain 1–10 pages.
   The server checks actual bytes, hash, signature and manifest slot before marking
   `source_uploaded=true`. Requests never combine five 12 MB files in Worker memory.
3. Once every non-cancelled file is verified, the server dispatches the existing
   jobs. The database claim also checks group readiness, so an early Queue message
   cannot start extraction of missing files. One extraction job remains one file.
   Repeating the final successful file PUT repairs a failed/partial Queue send;
   processing and draft writes remain idempotent.
4. GET `/venues/:venueId/menus/jobs?groupId=:groupId` to resume. Jobs expose
   `upload_index`, `source_uploaded`, stored status, warnings/error fields and
   draft count. The bounded list returns at most 100 jobs. Do not invent percentage
   progress or present a local timer as provider progress.
5. Read extracted dishes through `GET /venues/:venueId/drafts?jobId=:jobId`.
   For a complete or incomplete job, POST `{commandId}` to
   `/venues/:venueId/menus/jobs/:jobId/review-session`. The server loads the retained
   report and verifies its private artifact, source hash and original evidence;
   the response is the existing extraction review session. No private R2 key,
   embedded source snapshot or provider credentials are needed in the browser.
   Use its extraction/candidate IDs with the [review API](review-api.md) for
   corrections. A missing, oversized or tampered artifact blocks review.

Existing single-file `POST /venues/:venueId/menus/uploads` remains compatible and
now enforces the PDF page limit. `POST /venues/:venueId/menus/url` accepts
`{url,idempotencyKey}` and materializes a public PDF/image through safe retrieval.
Original/resolved source URLs and the first verified retrieval time remain in
private job provenance alongside the actual byte hash. An identical retry does
not rewrite that evidence. An HTML page may resolve exactly one linked PDF/image. Ambiguous/text-only pages
return `menu_file_link_required`; ask for the actual file instead of pretending an
HTML page was processed. Redirects, DNS/private destinations, size and type rules
remain enforced by the existing safe fetcher.

## Cancel and retry

POST `/venues/:venueId/menus/jobs/:jobId/cancel` or `/retry` with a fresh
`{commandId}`. Repeating the **same** command repairs delivery without repeatedly
adding attempts. The whole-menu Cancel control uses
`POST /venues/:venueId/menus/upload-groups/:groupId/cancel` with `{commandId}`:
unfinished members are cancelled together, preserving completed work and avoiding
new sibling dispatch. Read the returned states before showing cancellation.
Cancelling a missing member also dispatches any newly ready uploaded siblings;
repeating that command repairs a failed Queue send.

Cancellation invalidates the lease/token and fences later draft persistence.
Already reviewed dishes are preserved. A remote OCR/model request already in
flight may finish; cancellation does not promise immediate provider termination
or refund. Cancelled redeliveries ACK without requiring an extraction archive.
Partial results wait for explicit Retry; duplicate delivery does not silently
restart them. Successful processing clears stale error fields while retaining
the private attempt reports as historical evidence.

## Manual Add Dish and private photos

PUT `/venues/:venueId/drafts/:draftId` using a client UUID and:

```json
{
  "commandId": "<new UUID; reuse only for an identical retry>",
  "expectedVersion": 0,
  "fields": {
    "name": "Fictional soup",
    "category": "Soup",
    "description": null,
    "priceAmount": "8.50",
    "priceCurrency": "USD",
    "ingredients": {"status":"proposed","items":["Carrot"]},
    "allergens": {"status":"unknown","items":[]},
    "photoId": null
  }
}
```

Fields can be incomplete/null while saving. This PUT replaces the complete field
snapshot: use GET `/venues/:venueId/drafts/:draftId` on resume and send all retained
fields back with the returned `draft_version`. Stale versions and conflicting
command reuse return 409. Save/event/projection/receipt/outbox commit together.
Manual drafts have no fabricated extraction job or source span.

After creating the draft, POST raw JPEG/PNG bytes to
`/venues/:venueId/drafts/:draftId/photos` with `Content-Type` and
`Idempotency-Key`. The response supplies `photo.id`; save it in the next draft
version. GET `/venues/:venueId/drafts/:draftId/photos/:photoId` requires the same
restaurant permission and verifies the stored bytes against their digest.
Another draft's photo ID cannot be attached. Re-uploading identical bytes reuses
metadata. Replacing/removing a photo changes the saved reference, not historical
evidence. The original stays private and is not automatically an approved T0/2.5D
asset or a public URL.

## Review and publish

POST the existing `/venues/:venueId/drafts/:draftId/approve` with
`{commandId,expectedVersion:0,expectedDraftVersion:<current>,confirmed:true}`
for a manual draft. Name/category/price/currency must be present. Ingredients
and allergens retain explicit unknown/proposed/confirmed states; only confirmed
values enter approved facts. Unknown allergens remain `null` in public content;
an empty unknown list never becomes an allergen-free claim. Missing ingredients
or other required public content still produce an incomplete dish placeholder.

For an extraction-backed draft with a registered review session, approval also
requires `extractionId`, `expectedReviewVersion` (zero before any correction),
`expectedDraftVersion` and `confirmed:true`. The session must belong to that job.
Rejected/incomplete candidates cannot be approved. Approval freezes the current
corrected facts; later review edits do not change that approved revision. A job
retry increments draft versions, so a stale screen must reload before approval.

Approval creates an immutable dish revision snapshot through the existing
command/event/outbox path; it does **not** publish a menu. Legacy text-only edits
preserve enriched facts, and legacy event/receipt replay remains supported.
The bundle producer uses the approved snapshot, keeps unverified facts hidden,
and still requires independently approved images and menu publication. AI Draft/
Suggest UI controls need their own reviewed integration; saving this work never
invokes a model or invents a suggestion.

## Independent draft and photo verification (#161)

Migration `20261113010000` adds private draft/photo verification metadata. It is
not part of the earlier hosted acceptance below and requires a separate staging
migration/release. There is no new `dish_current` flag or publication bypass.

POST `/venues/:venueId/drafts/:draftId/verify` accepts
`{commandId,expectedVersion:<current draft_version>,verified:true}`. Only current
owner/editor staff can verify a pending draft. A stale version returns 409.
Verification records its own contiguous `owner_draft_verification` event stream,
bound to the reviewed content version; it does not advance the content version.
Manual edits and extraction retries clear verification. Replaying a command is
effect-free and returns its historical receipt, not a fresh draft read.

POST `/venues/:venueId/drafts/:draftId/photos/:photoId/approve` or `/reject` with
`{commandId}` independently changes the photo status. Approval validates the
source and copied destination SHA-256/size before committing the private
`menu-assets/` reference. Only after commit may the original staging object be
deleted. Replaying approval does not repeat that storage effect. Verification is
separate from the existing approval/publication commands above; it never certifies
food facts or makes an unapproved dish publicly eligible.

Scheduled retention remains off until configured. `MENU_STAGING_RETENTION_DAYS`
controls promoted originals (explicit zero permits immediate cleanup),
`MENU_STAGING_REJECTED_RETENTION_DAYS` controls rejected originals, and
`MENU_STAGING_ORPHAN_GRACE_DAYS` controls orphan uploads. Omitted rules stay off;
use `MENU_STAGING_CLEANUP_DRY_RUN=true` before enabling deletion. The cleanup uses
the ingestion bucket, exact tenant/draft/hash keys, tenant-scoped transactions,
draft/photo locks and paginated R2 listings. Pending/unverified work, corrupt or
missing promoted copies, malformed keys and failed lookups are retained.

The #105/#161 dashboard pages are **synthetic preview screens**. Their labels
and local state transitions do not establish connected API persistence; Ehab's
screen integration and authenticated hosted acceptance remain separate work.

## Acceptance record

Rollback: once enriched revision events/receipts or manual drafts exist, prefer a
forward correction. The preceding Worker cannot interpret every new event or
enforce the new manual/current-review approval rules. Do not treat an old-Worker
rollback as transparent; isolate workspace writes and review operations first.

Verified on 2026-11-12:

- Supabase staging migration `20261112010000` applied. Both new tables force
  tenant RLS; runtime gets SELECT/INSERT only, and anon/authenticated roles cannot
  read them. Existing ten migration entries were checked before the forward change.
- [Main release #149](https://github.com/vivienk/peekaplate/pull/149) merged as
  `fad0eb0870ade177a98ba035fac8cdb9e0964f40`. Exact-main staging API deployment
  is Worker version `58034c48-e720-4d13-b5e4-28af5621b150`; existing remote vars
  and secrets were preserved. No Pages, Python/container or production deployment.
- Develop implementation: 1,405 unit tests (four optional skips), 74 script tests,
  310 SQL assertions and 130 database/Worker cases. The narrow main release has
  1,220 unit, 74 script, 225 SQL and 104 database/Worker cases. These include actual
  local Chromium-to-Worker/private-database draft/photo/denial checks. The clock
  regression passed five repeated browser runs in 9.4 seconds; both PR CI suites
  passed. Two pinned Sol reviews cleared the implementation and release isolation.
- Seven hosted HTTP checks passed: health, three anonymous workspace denials,
  allowed local/staging preflight and blocked unapproved origin. R2 managed public
  access remains disabled, with no custom domains or bucket CORS. Existing menu
  and observation Queues and their DLQs remain paused.
- **Authenticated workspace acceptance PASS**, superseding the initial NOT RUN
  record in PR150. There were **53 hosted workspace HTTP checks** (16 server-side,
  37 from real Chromium at `http://127.0.0.1:5174`), **29 browser assertions** and
  three independent read-only Supabase postconditions. The browser phases took
  **49.615 seconds** of active runtime, excluding email/interaction waiting.
- Covered incomplete draft save/reload, photo upload/attachment/reload/byte readback,
  duplicate receipts, stale saves, cross-draft photo rejection, PDF upload/hash and
  11-page rejection, group resume/cancel, immutable originals, review corrections,
  stale-review denial and current-version approval. Supabase confirms that the
  approved price remains 9.00 after a later working-review correction to 9.50.
  An independent remote R2 read matches the browser-uploaded PDF's SHA-256.
- After restoring viewer permission, the same browser JWT receives 403 for draft,
  photo, review and job reads. Both test sessions ended, the temporary local test
  page was removed, and the original Auth sources/dev server were preserved.
  Labelled synthetic audit rows and private objects remain as evidence; no menu
  was published. All normal Queues/DLQs remain paused. The cancelled PDF delivery
  may remain until normal handling or expiry; no unrelated backlog was purged.

See the [sanitized acceptance results](evidence/owner-menu-staging-2026-11-12.json)
for every status, assertion, phase timing and cleanup boundary. The earlier
dashboard `SET ROLE` probe is not required: the successful deployed API calls
exercise the actual restricted runtime connection without expanding operator access.

## Fresh-link verification

The earlier `otp_expired` blocker came from the QA verification workflow, not a
required Auth configuration change. Gmail grouped the repeated messages and hid
the newest link under **Show trimmed content**, while an older link remained
visible. Refresh the conversation, check the newest delivery time and expand
that message before using its link once. The verifier preserves the complete
link's original verification type and keeps credentials in memory. A fresh link
then passed with the genuine dedicated staging identity, both server-side and
from the real local console browser origin. No password, account, email template,
redirect allowlist or expiry setting was changed.

The backend acceptance gate is cleared. Ehab can connect and test the actual
S06–S09 controls using the contracts above. That real owner-screen journey,
auth #143/#146 dashboard integration, new provider accuracy tests and production
acceptance remain separate. This run reused retained genuine extraction output;
it did not launch another OCR/model job. Keep normal delivery paused outside a
controlled synthetic test window.
