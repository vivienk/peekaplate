# PeekaPlate QA-02.2 — Owner-to-Diner Staging Preparation Guide

## Purpose

This folder contains preparation materials for QA-02.2, covering the first owner-to-diner staging journey.

The package includes three fictional dish examples, expected answers, test steps, security scenarios, and an execution evidence template.

This package does not demonstrate successful staging execution.

## Files in this preparation package

- QA_02_2_GUIDE.md — QA-02.2 scenarios and staging evidence template
- qa_02_2_dish_cases.json — Three fictional dish fixtures
- qa_02_2_expected_answers.json — Expected results for the test cases

## Relationship to PR #52

The original P0 v2 synthetic dataset from PR #52 is merged into develop. See the original dataset [GUIDE.md](GUIDE.md).

This QA-02.2 branch includes the original P0 v2 dataset, validators, and test suite through the merge from develop. The QA-02.2 staging scenarios are separate preparation materials.

Dataset validation results from merged PR #52 must not be represented as QA-02.2 staging results.

## Review and execution boundaries

- Product expectations: PENDING Adam/Shirley review
- Approved restaurant sources and T0 images: PENDING
- Application staging execution: NOT RUN
- Hosted privacy and authorization validation: NOT VERIFIED
- Independent evidence review: PENDING Sai

Do not use fictional fixture fields as restaurant-approved evidence.

---

## QA-02.2 — Owner-to-Diner Staging Journey Preparation

### Purpose

Prepare three reviewed dish examples, expected results, and test steps for the first owner-to-diner staging journey.

This is a preparation package, not proof of successful staging execution.

### Evidence and approval status

- Existing P0 v2 synthetic dataset: merged into develop via PR #52
- Event Matrix v0.1h: PROPOSED; product expectations require review
- Allergen terminology: use "nuts" instead of "tree nuts" per Adam's update
- Three restaurant-approved dish sources and T0 image assets: PENDING
- Adam and Shirley product review: PENDING
- Jeffin staging execution: NOT RUN
- Sai independent validation: PENDING

### Planned dish cases

1. QA-DISH-01 — Complete dish with approved source fields and T0 image
2. QA-DISH-02 — Incomplete dish with missing required information
3. QA-DISH-03 — Changed dish revision, publication replacement, and withdrawal

All three are fictional case templates until permitted sources and approved image assets are confirmed.

### Shared tracking acceptance — Consent and dual delivery (TRK)

These requirements apply to all QA-02.2 event-producing scenarios, including menu views, dish views, detail opens, Save, Unsave, Undo, and Saved screen views.

- **Approved live-mode consent:** Verify that the required tracking consent has been granted and applicable privacy signals permit tracking before expecting events.
- **Denied or withdrawn consent:** Browsing, menu viewing, and permitted UI actions must continue working, but disallowed tracking must not reach either PostHog or canonical ingestion.
- **Privacy signals:** Applicable privacy signals must suppress disallowed tracking in both destinations without breaking browsing.
- **PostHog SDK:** For each eligible UI action, record whether the expected event reaches PostHog through its SDK, including event identity and duplicate checks.
- **Canonical ingestion:** Independently verify the corresponding event reaches canonical ingestion, including event identity and duplicate checks. PostHog delivery alone does not prove canonical delivery.
- **Failure isolation:** Failure of PostHog must not block canonical ingestion or browsing. Failure of canonical ingestion must not block PostHog or browsing.
- **Pilot funnel:** Link the working pilot funnel check to the separate TRK acceptance work. Building or validating the funnel is outside this QA-02.2 preparation ticket.

**Separate execution evidence:**
- Consent mode and applicable privacy signals: NOT RUN
- PostHog SDK actual result: NOT RUN
- Canonical ingestion actual result: NOT RUN
- Duplicate capture check: NOT RUN
- Destination failure-isolation check: NOT RUN
- Linked TRK pilot funnel acceptance: BLOCKED — pending tracking integration

**Execution status:** NOT RUN / BLOCKED until tracking integration is available. Do not mark these requirements PASS based on documentation alone.


### Safety and isolation rules

- Missing ingredients must never imply allergen safety.
- AI-generated allergen flags are not restaurant-approved evidence.
- An incomplete dish must not be treated as a publishable complete dish.
- Restaurant A and Restaurant B must remain isolated.
- Fixture labels do not grant authorization.
- All unexecuted staging checks remain NOT RUN or BLOCKED.



### QA-DISH-01 — Complete Dish: Owner Approval to Diner Display

**Case status:** NOT RUN
**Fixture type:** Fictional synthetic example
**Restaurant:** Restaurant A (fictional)
**Dish ID:** qa-dish-01
**Source/page reference:** PENDING
**Original dish fields:** PENDING approved source
**T0 image reference:** PENDING approval
**Draft/revision identity:** PENDING staging assignment

#### Preconditions
- Restaurant A has an authorized owner account.
- Required dish information and a permitted T0 image are available.
- A saved dish draft is available for the owner to review.
- The diner has a QR link to use after explicit publication.

#### Test steps and expected results

| Step | Action | Expected result |
|---|---|---|
| 1 | Owner opens the dish draft | Original source fields are displayed |
| 2 | Owner corrects a dish field | Correction is saved only after a successful write |
| 3 | Owner reloads the draft | Saved correction remains visible |
| 4 | Owner explicitly approves the exact saved dish revision | Approved revision becomes eligible for publication |
| 5 | Owner explicitly publishes the approved revision and records the returned publication ID | Publication succeeds and the returned publication ID is captured as evidence |
| 6 | Diner opens the published menu through its QR link | Published, readable menu is displayed |
| 7 | Diner opens the complete dish detail | Correct approved fields and T0 image are displayed |
| 8 | Diner saves the dish | Saved state appears after successful storage |
| 9 | Diner reloads the page | Saved state is restored without a duplicate Save event |

#### Expected P0 events

All event expectations below are conditional on the consent and privacy requirements in **Shared tracking acceptance — Consent and dual delivery (TRK)**. Verify PostHog SDK and canonical ingestion separately; keep actual results NOT RUN/BLOCKED until tracking integration is available.
- menu_viewed: after the approved menu becomes readable
- dish_viewed: after the complete dish card is at least 50% visible continuously for 1 second
- dish_detail_opened: after readable detail is displayed
- dish_saved: only after successful storage and visible state change, with save_origin=direct

#### Evidence required
- Frontend and Worker commit IDs
- Schema version and staging environment
- Approved source and image references
- Browser or physical-phone screenshots
- Actual event results and failure owner

**Actual result:** NOT RUN
**Product review:** PENDING Adam/Shirley
**Independent validation:** PENDING Sai


### QA-DISH-02 — Incomplete Dish and Missing Information

**Case status:** NOT RUN
**Fixture type:** Fictional synthetic example
**Restaurant:** Restaurant A (fictional)
**Dish ID:** qa-dish-02
**Source/page reference:** PENDING
**Original dish fields:** PENDING approved source
**T0 image reference:** MISSING — negative test
**Draft/revision identity:** PENDING staging assignment

#### Purpose
Verify that a dish missing required information cannot accidentally become a complete, published diner dish.

#### Preconditions
- An authorized Restaurant A owner account is available.
- The dish draft is missing its required ingredient list.
- The T0 image is missing or unavailable.
- No allergen-safety conclusion is inferred from missing information.

#### Test steps and expected results

| Step | Action | Expected result |
|---|---|---|
| 1 | Owner opens the incomplete draft | Missing ingredients and image are identified |
| 2 | Owner attempts to approve the incomplete dish | Publication is blocked pending required information |
| 3 | Owner enters a correction | Correction is saved only after a successful write |
| 4 | Owner reloads the draft | Successfully saved correction persists |
| 5 | Owner rejects the draft | Rejected draft is not published |
| 6 | Diner opens the menu | Incomplete dish is not presented as a complete, interactive dish |
| 7 | Diner attempts to open incomplete dish detail | Detail access is blocked for an incomplete placeholder |
| 8 | Diner attempts to compare the incomplete dish | Comparison is unavailable for the incomplete placeholder |

#### Expected P0 events

All event expectations below are conditional on the consent and privacy requirements in **Shared tracking acceptance — Consent and dual delivery (TRK)**. Verify PostHog SDK and canonical ingestion separately; keep actual results NOT RUN/BLOCKED until tracking integration is available.
- No dish_viewed for an incomplete grey placeholder.
- No dish_detail_opened when readable detail was not displayed.
- No dish_compared when comparison was blocked.
- No Save success event for a failed or unavailable operation.
- A readable approved menu may still produce menu_viewed.

#### Allergen safety
- Missing ingredients do not mean the dish is allergen-free.
- Use the updated "nuts" terminology where applicable.
- AI-generated allergen flags are not authoritative restaurant evidence.

#### Evidence required
- Source and missing-field references
- Frontend and Worker commit IDs
- Schema version and staging environment
- Owner rejection and publication-block evidence
- Diner screenshots and actual emitted events
- Expected versus actual results and failure owner

**Actual result:** NOT RUN
**Product review:** PENDING Adam/Shirley
**Independent validation:** PENDING Sai



### QA-DISH-03 — Changed Revision, Publication Replacement, and Withdrawal

**Case status:** NOT RUN
**Fixture type:** Fictional synthetic example
**Restaurant:** Restaurant A (fictional)
**Dish ID:** qa-dish-03
**Source/page reference:** PENDING
**Original dish fields:** PENDING approved source
**T0 image reference:** PENDING approval
**Draft/revision identity:** PENDING staging assignment

#### Purpose
Verify that changing a dish creates a controlled revision, publication requires explicit approval, and withdrawn content is no longer available on a fresh diner load.

#### Preconditions
- Restaurant A has an authorized owner account.
- An approved dish revision is already published.
- A new draft revision is prepared with a changed field.
- The original and replacement revisions have distinct identities.
- The T0 image and source permissions require confirmation.

#### Test steps and expected results

| Step | Action | Expected result |
|---|---|---|
| 1 | Owner opens the published dish | Current approved revision is displayed |
| 2 | Owner edits a dish field | New draft revision is created or updated without silently replacing the published revision |
| 3 | Owner saves and reloads the draft | Successfully saved changes persist |
| 4 | Diner loads the menu before replacement | Current published revision remains visible |
| 5 | Owner explicitly approves the new revision | New revision becomes eligible for publication |
| 6 | Owner publishes the approved replacement | New revision replaces the previous published revision |
| 7 | Diner freshly reloads the menu | Newly published revision is displayed |
| 8 | Owner withdraws the dish | Dish is no longer available as published content on a fresh diner load |
| 9 | Diner freshly loads the menu again | Withdrawn dish is not presented as available |

#### Expected P0 events

All event expectations below are conditional on the consent and privacy requirements in **Shared tracking acceptance — Consent and dual delivery (TRK)**. Verify PostHog SDK and canonical ingestion separately; keep actual results NOT RUN/BLOCKED until tracking integration is available.
- menu_viewed only after an approved menu becomes readable.
- dish_viewed only for a complete eligible card satisfying the visibility threshold.
- dish_detail_opened only after readable detail is displayed.
- Events must reference the applicable publication revision.
- No successful diner interaction event is emitted for a blocked or failed interaction.
- No P0 event is invented solely for an owner revision or withdrawal action.

#### Revision and safety checks
- Preserve distinct draft and publication revision identities.
- Do not expose an unapproved draft to diners.
- Do not infer allergen safety from changed or missing ingredients.
- Use "nuts" instead of "tree nuts" in applicable approved allergen labels.
- Record stale-cache or stale-publication behavior as a failure if observed during fresh-load validation.

#### Evidence required
- Original source/page reference and approved T0 image
- Old and new draft/publication revision identifiers
- Frontend and Worker commit IDs
- Schema version and staging environment
- Owner save, approval, replacement, and withdrawal evidence
- Fresh-load diner screenshots
- Expected versus actual results and failure owner

**Actual result:** NOT RUN
**Product review:** PENDING Adam/Shirley
**Independent validation:** PENDING Sai



### QA-DINER-01 — Save, Unsave, Undo, and Storage Failure

**Case status:** NOT RUN
**Fixture type:** Fictional synthetic test case
**Reference:** Event Matrix v0.1h (PROPOSED)
**Product review:** PENDING Adam/Shirley

#### Purpose

Verify that diner Save, Unsave, and Undo actions produce the correct visible state and P0 events only after successful operations.

#### Test steps and expected results

| Step | Action | Expected result |
|---|---|---|
| 1 | Diner opens a complete published dish | Readable detail is displayed |
| 2 | Diner selects Save | Dish becomes saved after successful storage |
| 3 | Diner selects Unsave | Dish becomes unsaved after successful storage |
| 4 | Diner selects Undo | Dish becomes saved again after successful storage |
| 5 | Diner reloads the page | Saved state is restored without a duplicate Save event |
| 6 | Diner selects Unsave and lets the Undo toast expire | No additional event is emitted when the toast expires |
| 7 | Diner attempts Save while storage is blocked | No successful Save event is emitted |
| 8 | Diner attempts Unsave when the storage write fails | No successful Unsave event is emitted |
| 9 | Diner opens the Saved screen successfully | Readable Saved screen is displayed |
| 10 | Diner opens the Saved screen when storage cannot be read | Unavailable/error state appears; no shortlist_viewed event |

#### Expected P0 events

All event expectations below are conditional on the consent and privacy requirements in **Shared tracking acceptance — Consent and dual delivery (TRK)**. Verify PostHog SDK and canonical ingestion separately; keep actual results NOT RUN/BLOCKED until tracking integration is available.

- Successful direct Save: `dish_saved` with `save_origin=direct`
- Successful Unsave: `dish_unsaved`
- Successful Undo: `dish_saved` with `save_origin=undo`
- Successful readable Saved screen: `shortlist_viewed`
- Failed storage operations: no successful Save/Unsave event
- Reload restoring saved state: no duplicate Save event
- Undo toast expiry: no event

#### Additional checks

- Verify Save/Unsave surfaces: menu card, dish detail, compare view, and Saved screen.
- Search and ingredient interactions must not emit P0 events.
- Undo restoration must not be counted as a new direct Save adoption.
- Record the actual storage behavior instead of assuming success.

#### Evidence required

- Frontend and Worker commit IDs
- Staging environment and schema version
- Browser or physical-phone evidence
- Actual emitted events and storage results
- Expected versus actual results
- Failure owner for any discrepancy

**Actual result:** NOT RUN
**Independent validation:** PENDING Sai



### QA-SEC-01 — Restaurant Isolation and Authorization

**Case status:** NOT RUN
**Fixture type:** Fictional synthetic test case
**Product review:** PENDING Adam/Shirley
**Authentication setup:** BLOCKED pending staging identities

#### Purpose

Verify that restaurant owners can access only their authorized restaurant data, and that revoked or unauthorized users cannot access protected resources.

#### Preconditions

- Engineers provision disposable Restaurant A and Restaurant B identities.
- Each restaurant has separate draft and published dish records.
- A revoked owner identity and an outsider identity are available.
- Actual authorization is verified by the backend.
- Fixture labels alone do not grant access.

#### Test steps and expected results

| Step | Action | Expected result |
|---|---|---|
| 1 | Restaurant A owner opens Restaurant A draft | Authorized access succeeds |
| 2 | Restaurant A owner attempts to open Restaurant B draft | Access is denied |
| 3 | Restaurant A owner attempts to modify Restaurant B dish | Modification is rejected; Restaurant B data remains unchanged |
| 4 | Restaurant B owner opens Restaurant B draft | Authorized access succeeds |
| 5 | Revoke Restaurant A owner's access | Previously authorized owner loses access according to the verified revocation policy |
| 6 | Revoked owner attempts a protected operation | Request is rejected |
| 7 | Outsider attempts to access Restaurant A owner resources | Access is denied |
| 8 | Outsider attempts to access Restaurant B owner resources | Access is denied |
| 9 | Verify public diner menu access | Only explicitly published, publicly available information is accessible |
| 10 | Inspect rejected requests | No protected cross-restaurant data is returned or modified |

#### Security expectations

- Backend authorization must not rely on client-supplied restaurant labels.
- Restaurant A and Restaurant B data must remain isolated.
- Unapproved drafts must not be exposed through public diner routes.
- Revoked credentials must not retain unauthorized access.
- Rejected requests must not modify protected records.
- Record actual HTTP responses and authorization evidence during staging.

#### Evidence required

- Disposable identity references (no secrets)
- Frontend and Worker commit IDs
- Staging environment and authentication configuration
- Authorized and rejected request results
- Evidence that cross-restaurant records remain unchanged
- Expected versus actual results
- Failure owner for discrepancies

**Actual result:** NOT RUN
**Engineering provisioning:** BLOCKED
**Independent validation:** PENDING Sai



### QA-02.2 — Staging Execution and Evidence Template

**Preparation status:** IN PROGRESS
**Staging execution:** NOT RUN
**Product review:** PENDING Adam/Shirley
**Staging execution owner:** Jeffin (coordination pending)
**Independent reviewer:** Sai

#### Environment and build information

| Field | Value |
|---|---|
| Staging URL | PENDING |
| Frontend commit SHA | PENDING |
| Worker commit SHA | PENDING |
| Schema version | PENDING |
| Test date/time | NOT RUN |
| Browser and version | PENDING |
| Physical phone/device | PENDING |
| Test identity references | PENDING |
| Approved source references | PENDING |
| Approved T0 image references | PENDING |

#### Execution results

| Case ID | Expected result | Actual result | Status | Failure owner |
|---|---|---|---|---|
| QA-DISH-01 | Approved dish publishes and displays correctly | NOT RUN | NOT RUN | TBD |
| QA-DISH-02 | Incomplete dish cannot be published as complete | NOT RUN | NOT RUN | TBD |
| QA-DISH-03 | Approved revision replacement and withdrawal work | NOT RUN | NOT RUN | TBD |
| QA-DINER-01 | Save/Unsave/Undo and storage failures behave correctly | NOT RUN | NOT RUN | TBD |
| QA-SEC-01 | Restaurant isolation and authorization are enforced | NOT RUN | BLOCKED | TBD |

#### Evidence checklist

- [ ] Owner correction, save, and reload evidence
- [ ] Rejection and incomplete-dish evidence
- [ ] Explicit approval and publication evidence
- [ ] Revision replacement and fresh-load withdrawal evidence
- [ ] Diner QR, menu, and detail screenshots
- [ ] Save, Unsave, Undo, reload, and blocked-storage evidence
- [ ] Actual P0 event payloads
- [ ] Restaurant A/B isolation evidence
- [ ] Revoked-user and outsider-access evidence
- [ ] Browser and physical-phone evidence
- [ ] Expected-versus-actual discrepancies recorded
- [ ] Sai's independent review

#### Execution rules

- Use PASS only when actual staging evidence supports the expected result.
- Use FAIL when observed behavior contradicts the expected result.
- Use BLOCKED when a required environment, identity, source, asset, or dependency is unavailable.
- Use NOT RUN when the test has not been executed.
- Never mark a test PASS based only on synthetic data or documentation.
- Do not close staging execution based solely on preparation completion.

#### Review and handoff

- Adam and Shirley: review expected owner/diner behavior.
- Jeffin: coordinate staging execution when the environment is ready.
- Sai: independently validate collected evidence.
- Uneeza: maintain preparation cases, expected answers, and unresolved decisions.

**Overall staging result: NOT RUN**
