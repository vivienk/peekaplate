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

## Acceptance record

Before PR creation, hosted Supabase inspection confirmed the existing four
ingestion/review tables with forced RLS and the absence of the two new metadata
tables. This read-only check was not migration application or hosted acceptance.
Record the reviewed commit, final local/hosted commands/results and cleanup in
the PR before handoff. Synthetic transport fixtures prove APIs, not completion
of the still-unconnected S06–S09 screens. Keep normal Queue delivery paused
outside an explicitly approved test window.
