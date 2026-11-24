# S7-RES-09: Keep Automatic Menu Checks Behind the Owner Review Gate

## 1. Objective

Enforce and clarify the boundary between:

1. **Automatic menu checks** (extraction, completeness evaluation, confidence evaluation, and validation).
2. **Owner review and approval** (explicit human review, correction, and verification of dish details, ingredients, and allergens).
3. **Final menu publication** (explicit owner approval and publication of a prepared menu revision).

Automatic checks must never be interpreted as automatic owner approval or permission to publish.

Historical reference: [PR #161](https://github.com/vivienk/peekaplate/pull/161) (`feat(menu): implement independent dish and photo verification`).

---

## 2. Audit of Existing Implementation (PR #161 Baseline)

### What PR #161 Already Provided

- Added `dish_drafts.verification_status` (`'not_verified' | 'verified'`, default `'not_verified'`) and `dish_draft_photo.verification_status` (`'not_verified' | 'verified' | 'rejected'`, default `'not_verified'`) in `migrations/20261113010000_menu_verification_lifecycle.sql`.
- Added `POST /venues/:venueId/drafts/:draftId/verify` (`verifyOwnerDish` in `backend/src/owner-menu.ts`) with optimistic concurrency (`expectedVersion`), idempotency receipts, and event-sourced stream `owner_draft_verification`.
- Invalidated `verification_status` back to `'not_verified'` on manual draft edits (`saveOwnerDishDraft`), candidate review edits (`saveCandidateReviewCommand`), and extraction retries (`persistExtractedDrafts`).
- Enforced `verification_status === 'verified'` in `prepareOwnerMenu` (`backend/src/owner-prepare.ts`) and `approveDishDraftAtomic` (`backend/src/index.ts`).

### Gaps Identified for S7-RES-09

1. **`verifyOwnerDish` did not validate completeness or allergen resolution**: A direct API call could set `verification_status = 'verified'` on an incomplete dish or a dish with unresolved/proposed allergens (`allergens.status === 'proposed'`) or `candidate_review_current.incomplete_fields`.
2. **`approveDishDraftAtomic` silently dropped `proposed` allergens/ingredients**: `allergens.status === 'proposed'` or manual `ingredients.status === 'proposed'` was converted to `null` instead of rejecting with `draft_incomplete` (409).
3. **`prepareOwnerMenu` silently skipped `draft_incomplete` dishes**: If an active verified dish threw `draft_incomplete` during `approve(...)`, `prepareOwnerMenu` caught the error and continued preparing a partial menu with the remaining dishes.
4. **`approveMenuRevision` and `publishMenu` did not re-check active owner drafts**: If a dish was edited, un-verified, or re-extracted after `prepareOwnerMenu` or `approveMenuRevision`, a stale `menu_review_subject` or `menu_approval` could still be published.
5. **Frontend `dishStatus` treated `proposed` allergens as `Ready`**: In `frontend/console/src/owner/review/reviewDishes.ts`, a dish with `allergens.status === 'proposed'` could show `Ready` and allow menu verification if other fields were present.
6. **Step 1 onboarding wording**: `"Step 1 auto-verifies"` did not appear literally on `origin/develop` (`MenuProcessing.tsx` already stated that extraction prepares an unverified draft), and was refined to explicitly describe automatic completeness and confidence checks vs. owner review and approval before publication.

---

## 3. Automatic Checks vs. Owner-Controlled Decisions

| Stage | Actor / Mechanism | What It Establishes | Can It Approve or Publish? |
| --- | --- | --- | --- |
| Extraction & Automatic Checks | Ingestion worker / `MenuProcessing` / `reviewDishes` | Extraction finished (`needs_review`, `pending`, `not_verified`); missing fields and confidence/completeness warnings identified | **No** |
| Owner Dish Review & Verification | Owner via Screen 9 / Screen 10 (`PUT /drafts/:id`, `POST /drafts/:id/verify`) | Owner reviewed dish details, resolved proposed allergens/ingredients, and verified the current `draft_version` (`verification_status = 'verified'`) | **No** (does not publish) |
| Menu Preparation | `POST /venues/:venueId/prepared-menus/prepare` (`prepareOwnerMenu`) | All active drafts are `verified`, complete, and approved onto canonical `dish_current` revisions (`review_status = 'accepted'`); builds immutable `menu_review_subject` | **No** (does not publish) |
| Menu Revision Approval | `POST /venues/:venueId/menus/:menuId/approvals` (`approveMenuRevision`) | Owner explicitly approves the exact `menu_review_subject` while all active drafts remain `verified` and `accepted` | **No** (records `menu_approval`) |
| Publication | `POST /venues/:venueId/menus/:menuId/publications` (`publishMenu`) | Owner explicitly publishes the approved revision while all active drafts remain `verified` and `accepted` | **Yes** (`menu_publication_current.status = 'published'`) |

---

## 4. State-Transition Lifecycle

```text
[Extraction / Manual Save]
   |  extraction_status = 'needs_review'
   |  review_status = 'pending'
   |  verification_status = 'not_verified'
   v
[Owner Review & Resolution]
   |  (blocked if required fields missing, incomplete_fields non-empty,
   |   or allergens/ingredients status === 'proposed')
   |  POST /drafts/:draftId/verify { verified: true, expectedVersion }
   v
[Owner-Verified Draft] (verification_status = 'verified', review_status = 'pending')
   |  (any edit, candidate review edit, or extraction retry resets -> 'not_verified', draft_version + 1)
   |  POST /prepared-menus/prepare
   v
[Prepared Menu Subject] (drafts: review_status = 'accepted', menu_review_subject created)
   |  (any edit/unverify reopens draft -> 'pending' + 'not_verified', blocking approve/publish)
   |  POST /menus/:menuId/approvals
   v
[Owner-Approved Menu Revision] (menu_approval created)
   |  POST /menus/:menuId/publications
   v
[Published Menu] (menu_publication_current.status = 'published')
```

---

## 5. Backend Enforcement Details

1. **`backend/src/owner-menu.ts` (`verifyOwnerDish`)**: When `verified === true`, `assertDraftReadyForVerification` rejects with `409 draft_incomplete` if required fields (`name`, `category`, `priceAmount`, `priceCurrency` for manual; `name` for extracted) are missing, if `candidate_review_current` has `review_status IN ('rejected', 'incomplete')` or non-empty `incomplete_fields`, or if `allergens.status === 'proposed'` or manual `ingredients.status === 'proposed'`.
2. **`backend/src/index.ts` (`approveDishDraftAtomic`)**: Rejects `409 draft_incomplete` if `manual.allergens.status === 'proposed'`, `manual.ingredients.status === 'proposed'`, or extracted `corrected.allergens?.status === 'proposed'`.
3. **`backend/src/owner-prepare.ts` (`prepareOwnerMenu`)**: Removed the `draft_incomplete` catch-and-skip path so any incomplete active dish aborts preparation with `409 draft_incomplete`.
4. **`backend/src/publication-command.ts` (`approveMenuRevision`, `publishMenu`)**: Added `assertActiveOwnerDraftsApproved(client, venueId)` which rejects with `409 menu_not_verified` if any active `dish_drafts` row (`removed_at IS NULL AND review_status NOT IN ('rejected', 'superseded')`) is not `verification_status = 'verified' AND review_status = 'accepted' AND published_dish_id IS NOT NULL`, or has `incomplete_fields` / `incomplete` review status.

---

## 6. Acceptance & Security Test Coverage

### Mandatory Scenarios (`backend/src/s7-res-09-owner-review-gate.integration.ts` & Frontend Tests)

- **Scenario A (Complete, high-confidence dish)**: Extraction persists `needs_review` / `pending` / `not_verified`. Preparation and publication are rejected (`409 menu_not_verified`) until explicit owner verification, preparation, approval, and publication; published bundle contains the approved dish.
- **Scenario B (Incomplete dish)**: Missing required fields reject `verifyOwnerDish` (`409 draft_incomplete`) and block `prepareOwnerMenu` (`409 menu_not_verified`) even when a complete dish exists alongside it. After correction and explicit approval, publication succeeds.
- **Scenario C (Unresolved allergen information)**: `allergens: { status: 'proposed', items: [...] }` keeps frontend `dishStatus` as `Pending Review` (`isMenuReady === false`) and rejects backend `verifyOwnerDish` and `approveDishDraftAtomic` (`409 draft_incomplete`). After owner resolution (`confirmed` or `unknown`) and approval, publication succeeds.

### Additional Security & Regression Tests

- Direct HTTP `PUT /drafts/:draftId` with `verification_status: 'verified'` rejected (`400`).
- Direct HTTP `POST /prepared-menus/prepare` without owner verification rejected (`409`).
- Post-approval dish edit reopens draft (`pending`, `not_verified`) and blocks `publishMenu` on stale `approvalId` (`409 menu_not_verified`).
- Cross-restaurant authorization (`403`) enforced for foreign owners.

---

## 7. Remaining Limitations & Staging Boundary

- All verification in this change was performed locally against unit tests, TypeScript checks, and disposable Docker PostgreSQL integration tests (`scripts/test-db.mjs`).
- Live staging acceptance requires deploying to the staging environment and executing an authorized staging verification pass; local test results do not constitute live staging acceptance.
