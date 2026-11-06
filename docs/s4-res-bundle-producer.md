# S4-RES: Trusted Immutable Menu Bundle Producer — Contract & Kickoff Summary

**Task**: ClickUp [86bct99xa](https://app.clickup.com/t/86bct99xa) (S4-RES: Produce trusted immutable menu bundles for staging)  
**Author / Owner**: Marwan Ammar (`myler71`)  
**Base Commit**: `d6e5a16` (`origin/develop`, PR #76)  
**Branch**: `feat/s4-res-bundle-producer`  
**Related Documents**: [docs/public-menu.md](public-menu.md), [docs/operations.md](operations.md), [qa-reports/S4-RES-test-plan.md](../qa-reports/S4-RES-test-plan.md)  
**Status**: Contract & Design Base (Documentation only; no producer implementation in this slice)

---

## 1. Scope and Boundary

The S4-RES bundle producer builds a trusted, immutable **Bundle v1** JSON payload from approved dish revisions and approved T0 image assets using the agreed `PublicMenuContentBundleSchema`. 

Key boundaries defined by the task and accepted architecture:
1. **Reuse review pipeline**: The producer does NOT introduce automatic approval or automatic publication. Menu approval and publication remain distinct, human-authorized staff commands owned by RES-02 ([docs/public-menu.md](public-menu.md) lines 7-13, 83-88; [backend/src/publication-command.ts](../backend/src/publication-command.ts) lines 171-436).
2. **Immutable provenance**: The bundle captures exact UUIDs for venue, menu, menu revision, categories, dishes, dish revisions, and ingredients, along with immutable HTTPS image references and content digests.
3. **Strict exclusion**: Private extraction evidence, bounding boxes, OCR text, raw LLM outputs, reviewer identities, review notes, rejected candidates, pending drafts, stale revisions, and cross-tenant entities are strictly excluded from public bundles.
4. **Content integrity**: Incomplete entries contain ONLY identity UUIDs and `complete: false`. The producer never invents ingredients, prices, allergens, dietary claims, or synthetic food imagery ([AGENTS.md](../AGENTS.md) line 32).
5. **Format bounds**: Strictly Bundle v1 (T0 photo exposures). Optional 2.5D spatial/parallax formats (VIS-03 T1) and presentation layers are outside this journey and must be rejected as unknown fields ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 42-57; [docs/public-menu.md](public-menu.md) lines 63-64).

---

## 2. Authoritative Schema Locations and Bundle v1 Specification

The authoritative definitions for public menu delivery, publication, and Bundle v1 reside across contracts, migrations, backend command routes, and documentation.

### 2.1 Code and Schema References

| Component | Repository Path & Line Reference | Notes |
|---|---|---|
| `PublicMenuContentBundleSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 231-287) | Strict root object for the immutable diner bundle; includes category/dish/ingredient uniqueness refinements. |
| `PublicMenuIncompleteDishSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 176-179) | Strict object: `dish_id`, `dish_revision_id`, `complete: false`. |
| `PublicMenuCompleteDishSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 195-218) | Strict object: identity, name, description, price, ingredients, allergens, dietary, and images. |
| `PublicMenuDishSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 220-223) | Discriminated union on `complete` (`true` vs `false`). |
| `PublicMenuCategorySchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 225-229) | Strict object: `category_id`, `name`, ordered `dishes` (max 500). |
| `PublicMenuImageSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 158-163) | Strict HTTPS URL, positive width/height (max 16,384), non-empty `alt` (1-500 chars). |
| `PublicMenuIngredientSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 165-169) | Strict `ingredient_id`, `name` (1-160 chars), `description` (max 1000 chars, nullable). |
| `PublicMenuAllergenCodeSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 181-191) | Closed 9-code enum: `milk`, `egg`, `fish`, `crustacean shellfish`, `nuts`, `peanut`, `wheat`, `soy`, `sesame`. |
| `PublicMenuDietaryCodeSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (line 193) | Closed 3-code enum: `vegan`, `vegetarian`, `gluten-free`. |
| `PublicMenuBundleSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 147-151) | Pointer schema: HTTPS `url`, 64-hex `contentHash`, 64-hex `assetManifestHash`. |
| `PublicMenuResponseSchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 289-301) | Pointer response from `GET /public/venues/:venueId/menus/:menuId`. |
| `PublicMenuDeliverySchema` | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 303-323) | Super-refines response and bundle content, validating identical venue, menu, and menu-revision UUIDs. |
| Approval & Publication Schemas | [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 100-139) | `ApproveMenuRevisionSchema`, `MenuApprovalSchema`, `PublishMenuSchema`, `WithdrawMenuSchema`, `MenuPublicationSchema`. |
| Diner Contract Prose | [docs/public-menu.md](public-menu.md) (lines 32-66) | Authoritative contract specification for Bundle v1. |
| Publication Migrations | [migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql) | Tables: `menu_review_subject`, `menu_approval`, `menu_review_current`, `menu_publication_current`. |
| Bundle Storage Migration | [migrations/20261025130000_public_menu_bundle.sql](../migrations/20261025130000_public_menu_bundle.sql) | Table: `public_menu_bundle` linking revision to HTTPS URL. |
| Public Menu Read Route | [backend/src/public-menu.ts](../backend/src/public-menu.ts) (lines 86-133) | `readPublicMenu` query joining publication, approval, and bundle. |
| Publication Command Engine | [backend/src/publication-command.ts](../backend/src/publication-command.ts) (lines 171-436) | Owner commands: `approveMenuRevision`, `publishMenu`, `withdrawMenu`. |
| Diner Wire Types | [frontend/diner/src/menu/wire.ts](../frontend/diner/src/menu/wire.ts) (lines 1-32) | Consumer-side wire types (mirrors draft PR #43). |

---

### 2.2 Complete Bundle v1 Field Specifications and Constraints

Every object in Bundle v1 uses Zod `.strictObject()`; unknown fields are rejected:

#### Root Object (`PublicMenuContentBundleSchema`)
- `schema_version`: `1` (literal integer).
- `venue_id`: UUID string (lowercase canonical format).
- `menu_id`: UUID string (lowercase canonical format).
- `menu_revision_id`: UUID string (lowercase canonical format).
- `restaurant`: Strict object:
  - `name`: string, trimmed, 1 to 160 characters, no NUL characters (`postgresText`).
  - `logo`: `PublicMenuImageSchema` or `null`.
- `categories`: array of `PublicMenuCategorySchema`, 1 to 100 items. Array order is display order.
- **Cross-field validations (`.superRefine`)**:
  - `category_id` values must be unique across `categories`.
  - `dish_id` values must be unique across all categories in the menu.
  - Within each complete dish, `ingredient_id` values must be unique.

#### Category Object (`PublicMenuCategorySchema`)
- `category_id`: UUID string.
- `name`: string, trimmed, 1 to 160 characters, no NUL characters.
- `dishes`: array of `PublicMenuDishSchema`, 0 to 500 items. Array order is display order.

#### Dish Object (`PublicMenuDishSchema`)
Discriminated union on `complete`:

1. **Incomplete Dish (`PublicMenuIncompleteDishSchema`)**:
   - `dish_id`: UUID string.
   - `dish_revision_id`: UUID string.
   - `complete`: `false` (literal boolean).
   - **Strict constraint**: MUST NOT contain name, description, price, ingredients, allergens, dietary, or images. Any additional property triggers strict validation failure.

2. **Complete Dish (`PublicMenuCompleteDishSchema`)**:
   - `dish_id`: UUID string.
   - `dish_revision_id`: UUID string.
   - `complete`: `true` (literal boolean).
   - `name`: string, trimmed, 1 to 160 characters, no NUL characters.
   - `description`: string, trimmed, 1 to 4000 characters, no NUL characters.
   - `price`: Strict object:
     - `amount`: string matching `/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/` (canonical non-negative decimal string, up to 2 decimal places, max 8 whole digits; e.g. `"12.50"`, `"0.00"`).
     - `currency`: string matching `/^[A-Z]{3}$/` (ISO 4217 uppercase 3-letter code; e.g. `"USD"`, `"GBP"`).
   - `ingredients`: array of `PublicMenuIngredientSchema`, 0 to 100 items. Each item:
     - `ingredient_id`: UUID string.
     - `name`: string, trimmed, 1 to 160 characters, no NUL characters.
     - `description`: string, trimmed, max 1000 characters, or `null`.
   - `allergens`: nullable array of `PublicMenuAllergenCodeSchema`, max 9 items, unique items.
     - Tripartite semantics ([docs/public-menu.md](public-menu.md) line 61):
       - `null`: Allergen declaration is unavailable or unreviewed.
       - `[]`: Reviewed declaration confirmed zero allergens from the closed list.
       - Non-empty array: Reviewed declared allergens from the closed list.
       - *Note*: Neither `null` nor `[]` is a guarantee of allergen-free food.
     - Allowed values: `'milk'`, `'egg'`, `'fish'`, `'crustacean shellfish'`, `'nuts'`, `'peanut'`, `'wheat'`, `'soy'`, `'sesame'`. Display labels like `"Peanuts"` or `"tree nut"` are strictly rejected.
   - `dietary`: array of `PublicMenuDietaryCodeSchema`, max 3 items, unique items.
     - Allowed values: `'vegan'`, `'vegetarian'`, `'gluten-free'`. Display labels like `"Gluten-Free"` are strictly rejected.
   - `images`: Strict object containing exactly:
     - `card`: `PublicMenuImageSchema`.
     - `detail`: `PublicMenuImageSchema`.
     - *Note*: Required on every complete dish. Neither `card`, `detail`, nor `images` may be `null`.

#### Image Object (`PublicMenuImageSchema`)
- `url`: valid HTTPS URL string (`z.url().refine((v) => v.startsWith('https://'))`). Plain HTTP is strictly rejected.
- `width`: positive integer, max 16,384.
- `height`: positive integer, max 16,384.
- `alt`: string, trimmed, 1 to 500 characters, no NUL characters. Empty string is strictly rejected.

---

## 3. Hash, Canonicalization, Immutable Hosting, and RES-02 Handoff

### 3.1 Hash and Canonicalization Implementation Today

1. **Authoritative Canonical JSON Algorithm**:
   - Located at [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 889-956, `canonicalJson`), re-exported in `backend/src/consumer/canonical-json.ts` lines 36-43 (PR #40).
   - Implements recursive deterministic key sorting for objects (`Object.entries().sort(([a], [b]) => a.localeCompare(b))`).
   - Deterministically omits `undefined` object properties; serializes `undefined` array elements as `null`.
   - Normalizes numeric `-0` to `0`; rejects non-finite numbers (`NaN`, `Infinity`).
   - Detects circular references using `WeakSet`; caps complexity at 65,536 nodes.
2. **SHA-256 Digest**:
   - Located at [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) (lines 961-968, `sha256`), returns lowercase 64-character hexadecimal digest (`/^[a-f0-9]{64}$/`).
3. **Current Hash Usage in Publication Engine**:
   - In [backend/src/publication-command.ts](../backend/src/publication-command.ts) (lines 60-80), `publicationHash` is calculated as:
     `sha256(JSON.stringify({ schemaVersion: 1, menuId, menuRevisionId, contentHash, assetManifestHash }))`.
     *Note*: It currently invokes standard `JSON.stringify`, not `canonicalJson`.
4. **The Integrity Gap Identified in PR #43**:
   - [docs/public-menu.md](public-menu.md) (lines 48-49) explicitly notes:
     > "`PublicMenuDeliverySchema` performs shape and identity validation only; it does not prove hash integrity. Before parsing or display, the DIN-03 adapter must verify the producer-defined hash input against `response.bundle.contentHash`. The producer and consumer must agree whether that input is exact UTF-8 bytes or a canonical serialization; until that rule is recorded and tested, a schema-valid fetch is not approved-content evidence."

### 3.2 Immutable URL and CORS Story

1. **Immutable Bundle URL**:
   - Bundle files must be stored as immutable objects (e.g. Cloudflare R2 / S3 / CDN) served strictly over HTTPS.
   - Must be served with `Content-Type: application/json` and cache-friendly immutable headers (e.g. `Cache-Control: public, max-age=31536000, immutable`).
   - Content modification requires a brand-new menu revision ID, new URL, and new hashes; overwriting existing URLs is prohibited ([docs/public-menu.md](public-menu.md) line 65).
2. **CORS Configuration**:
   - The public menu Worker endpoint `GET /public/venues/:venueId/menus/:menuId` uses an environment-level diner origin allowlist with `Vary: Origin` ([backend/src/public-menu.ts](../backend/src/public-menu.ts); [docs/public-menu.md](public-menu.md) lines 80-82, 114-120).
   - Static PR previews are deliberately excluded (`connect-src 'none'`).
   - The immutable object host serving the bundle JSON and image files requires its own CORS headers (`Access-Control-Allow-Origin: <diner-origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: GET, HEAD`).
   - Approval of origin allowlists is owned by repository CODEOWNERS (`@vivienk` and `@hemu77`).

### 3.3 RES-02 Approval and Publication Handoff

The handoff contract from the bundle producer to RES-02 requires populating two database tables before staff commands can execute:

1. **Privileged Ingestion Write**:
   - Producer writes to `app_private.menu_review_subject` ([migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql) lines 2-21):
     - `tenant_id`: venue UUID
     - `menu_id`: menu UUID
     - `menu_revision_id`: revision UUID
     - `content_approval_id`: UUID
     - `content_hash`: 64-hex SHA-256 of the bundle content
     - `asset_approval_id`: UUID
     - `asset_manifest_hash`: 64-hex SHA-256 of the aggregate asset manifest
   - Producer writes to `app_private.public_menu_bundle` ([migrations/20261025130000_public_menu_bundle.sql](../migrations/20261025130000_public_menu_bundle.sql) lines 2-12):
     - `tenant_id`, `menu_id`, `menu_revision_id`, `bundle_url` (must match `^https://`).
   - *Security Note*: `peekaplate_runtime` has only `SELECT` privileges on both tables ([migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql) line 114; [migrations/20261025130000_public_menu_bundle.sql](../migrations/20261025130000_public_menu_bundle.sql) line 23). The producer must run via a privileged migration or ingestion pipeline role.
2. **Owner Approval Command (`POST /venues/:venueId/menus/:menuId/commands/approve`)**:
   - Payload: `ApproveMenuRevisionSchema` (`commandId`, `expectedVersion`, `menuRevisionId`, `contentApprovalId`, `assetApprovalId`).
   - Backend verifies `menu_review_subject` matches the exact approval IDs, creates a `menu_approval` record, and advances the review version ([backend/src/publication-command.ts](../backend/src/publication-command.ts) lines 171-255).
3. **Owner Publication Command (`POST /venues/:venueId/menus/:menuId/commands/publish`)**:
   - Payload: `PublishMenuSchema` (`commandId`, `expectedVersion`, `approvalId`).
   - Backend reads `menu_approval`, computes `publicationHash`, and upserts `menu_publication_current` to `published` ([backend/src/publication-command.ts](../backend/src/publication-command.ts) lines 307-416).
4. **Public Anonymous Read (`GET /public/venues/:venueId/menus/:menuId`)**:
   - Returns `PublicMenuResponseSchema` joining active publication, approval, and bundle URL ([backend/src/public-menu.ts](../backend/src/public-menu.ts) lines 97-125).

---

## 4. Inputs Available to the Producer

The producer must reconcile three upstream inputs:

```
[RES-01 / Staff Review]            [RES-01.2 Review API]              [VIS-03 Asset Pipeline]
dish_current (Name, Desc)         candidate_review_current (Edits)    AssetManifest (T0 Card/Detail)
          \                                |                                 /
           \                               |                                /
            v                              v                               v
    +------------------------------------------------------------------------------+
    |                         S4-RES Bundle Producer                               |
    |  - Enforce PublicMenuContentBundleSchema strict typing                       |
    |  - Compute contentHash & assemble HTTPS asset URLs                           |
    |  - Write menu_review_subject & public_menu_bundle (Privileged)               |
    +------------------------------------------------------------------------------+
                                           |
                                           v
                              [RES-02 Staff Approval]
```

### 4.1 Approved Dish Revisions (`dish_current`)
- **Table**: `app_private.dish_current` ([migrations/20261014210000_staff_commands.sql](../migrations/20261014210000_staff_commands.sql) lines 10-20).
- **Fields**: `tenant_id`, `dish_id`, `version`, `revision_id`, `name`, `description`.
- **Contract Schema**: `DishRevisionSchema` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 85-91).
- **Gap**: Contains only name and description. It does not contain price, ingredients, allergens, dietary codes, or category hierarchy.

### 4.2 RES-01.2 Review & Correction Persistence (PR #73)
- **Source**: PR #73 (`feat/s3-res-01-2-review-api`, head commit `d341c86`, stacked on PR #58).
- **Tables**:
  - `app_private.extraction_review_session` (`migrations/20261030120000_review_candidate_persistence.sql` in PR #73): Immutable, append-only extraction result payload, source hash, job ID, and private artifact reference.
  - `app_private.candidate_review_current` (`migrations/20261030120000_review_candidate_persistence.sql` in PR #73): Keyed by `(tenant_id, extraction_id, candidate_id)`. Contains:
    - `review_status`: `'corrected'`, `'rejected'`, or `'incomplete'`.
    - `revision_id`: UUID (unique per tenant).
    - `corrected_fields`: JSON object containing corrections for `name`, `description`, `category`, `subcategory`, `price_text`, `price_amount`, `price_currency`, and `ingredients`.
    - `incomplete_fields`: array of field names marked incomplete.
    - `reviewed_by` (UUID), `reviewed_at` (timestamptz).
- **Contract Schemas**: `packages/contracts/src/review-persistence.ts` in PR #73 (`CandidateReviewRecordSchema`, `ResolvedCandidateFieldsSchema`).
- **Gaps**:
  - Every candidate review record carries `publishable: false`. The producer must respect that review state alone does not authorize publication.
  - Candidate corrections do not include fields for `allergens` or `dietary` codes.

### 4.3 VIS-03 Approved T0 Assets (PR #25)
- **Source**: PR #25 (`feat/s3-vis-03-asset-delivery`, `processing/src/peekaplate_processing/assets.py` and `schemas.py`).
- **Data Model**: `AssetManifest` (`schemas.py` lines 273-288 on branch `fork/feat/s3-vis-03-asset-delivery`):
  - `asset_id`: String pattern `^t0_[0-9a-f]{32}$`.
  - `tier`: Literal `'T0'`.
  - `source`: `AssetSource` (SHA-256, dimensions, path, `capture_evidence`, `captured_at`).
  - `dish`: `DishRef` containing `dish_id` (UUID) and `revision_id` (UUID).
  - `variants`: Exactly 4 `AssetVariant` records:
    - `card-480`: `webp` (width <= 480, height <= 480) and `jpeg`.
    - `detail-1280`: `webp` (width <= 1280, height <= 1280) and `jpeg`.
    - Each variant has: `name`, `format`, relative `path`, `sha256`, `size_bytes`, `width`, `height`, `quality`.
  - `review`: `ReviewState(status='needs_review', warnings=...)`.
  - `publication`: `PublicationState(eligible=False, reason='Human approval and backend publication are required.')`.
  - `measurements`: `total_variant_bytes`, `budget_status`.
- **Gaps**:
  - `AssetVariant.path` is a relative filename (e.g. `card-480.webp`). It must be resolved against an authoritative HTTPS asset base URL to form `PublicMenuImageSchema.url`.
  - `AssetManifest` contains no image `alt` text.

---

## 5. Traceability Matrix: S4-RES Acceptance Criteria

| AC ID | ClickUp Acceptance Criterion | Satisfying / Constraining Contract & Code | Gap / Ownership |
|---|---|---|---|
| **AC-S1** | Produce three permitted, approved dishes with exact source, revision, and asset provenance. | `PublicMenuContentBundleSchema` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 231-287); `dish_current` ([migrations/20261014210000_staff_commands.sql](../migrations/20261014210000_staff_commands.sql) line 10); `AssetManifest` (`schemas.py` line 273 in PR #25). | Need pipeline linking dish revisions, candidate review corrections, and T0 assets into a single menu revision bundle. **Owner: Marwan (S4-RES)**. |
| **AC-S2** | Demonstrate immutable bytes/hash round-trip, repeat-build idempotence, and new version/hash when approved content changes. | `canonicalJson` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 889-956); `sha256` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 961-968); `publicationHash` ([backend/src/publication-command.ts](../backend/src/publication-command.ts) lines 60-80); [docs/public-menu.md](public-menu.md) lines 48-49. | Producer & DIN-03 must agree on hash algorithm (canonical JSON vs raw bytes). **Owners: Zhiliang (RES-02), Marwan (S4-RES), Harshita (DIN-03)**. |
| **AC-S3** | Enforce negative tests: invalid/duplicate IDs, unknown fields, missing assets, incomplete placeholders (IDs + `complete: false` only), stale/rejected/private/cross-tenant exclusion. | `PublicMenuContentBundleSchema.superRefine` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 243-286); `PublicMenuIncompleteDishSchema` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 176-179); RLS policies ([migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql) lines 91-112). | Implement automated unit/integration test suite exercising all negative validation and leakage cases. **Owner: Marwan (S4-RES)**. |
| **AC-S4** | RES-02 accepts URL/hash/revision handoff; DIN-03 consumes published output on staging; atomic replacement & withdrawal on fresh load. | Tables `menu_review_subject` and `public_menu_bundle` ([migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql); [migrations/20261025130000_public_menu_bundle.sql](../migrations/20261025130000_public_menu_bundle.sql)); `readPublicMenu` ([backend/src/public-menu.ts](../backend/src/public-menu.ts) line 86); `PublicMenuDeliverySchema` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) line 303); `toDish` ([frontend/diner/src/menu/adapter.ts](../frontend/diner/src/menu/adapter.ts) lines 44-82). | Staging bucket hosting with CORS; DIN-03 adapter integration with live bundle endpoint; replacement lifecycle verification. **Owners: Zhiliang (RES-02), Harshita (DIN-03), Marwan (S4-RES)**. |
| **AC-S5** | Record complete evidence: merged PR/CI, deployed frontend/Worker/schema versions, expected vs actual outcomes, fixture vs live provenance. | QA report standard demonstrated in `qa-reports/S3-VIS-03-test-report.md` on branch `fork/feat/s3-vis-03-asset-delivery`. | Execute test plan against staging, record actual outputs and commit/run hashes. **Owner: Marwan (S4-RES) & QA coordinator**. |
| **AC-S6** | Independent technical/security verification (Sai `@hemu77`), code review (Jeffin), and sign-offs (Shirley, Adam, Rania, Amr). | Contributor guide rules on independent review ([AGENTS.md](../AGENTS.md) lines 37-45). Authors cannot approve own work. | Independent reviews and stakeholder approvals before develop merge. **Owners: Sai, Jeffin, Shirley, Adam, Rania, Amr**. |

---

## 6. Open Questions for Cross-Team Alignment

The following questions must be agreed with Zhiliang (RES-02) and Harshita (DIN-03) before producer implementation:

1. **Canonical Bytes vs Raw UTF-8 Hashing**:
   - *Question*: Does `contentHash` represent the SHA-256 digest of the exact UTF-8 bytes uploaded to the object store, or `sha256(canonicalJson(bundle))`?
   - *Recommendation*: Use `sha256(canonicalJson(bundle))` for content hash verification so whitespace variations or formatting transformations by proxies do not invalidate cryptographic verification. If raw UTF-8 bytes are hashed, the producer must write canonically serialized bytes without formatting.
2. **Hash Verification Location in DIN-03**:
   - *Question*: Where does DIN-03 verify `contentHash`? Does `frontend/diner/src/menu/adapter.ts` verify the hash before parsing JSON, or does a network wrapper verify it? What error screen is displayed if hash verification fails?
3. **CORS Allowlist for Immutable Object Host**:
   - *Question*: What exact origin header allowlist will be applied to the bundle R2/S3 bucket on staging (e.g. `https://diner-staging.peekaplate.com`)? Will the bucket return `Vary: Origin`?
4. **Image Base URL and Variant Format Selection**:
   - *Question*: VIS-03 manifests produce both `webp` and `jpeg` formats for `card-480` and `detail-1280`. Which format should the producer embed into `PublicMenuImageSchema.url` for Bundle v1? What is the staging CDN/storage base URL (e.g. `https://assets.staging.peekaplate.com/`)?
5. **Image `alt` Text Sourcing**:
   - *Question*: Since `AssetManifest` has no `alt` text and `PublicMenuImageSchema` requires 1-500 chars of non-empty `alt`, how is `alt` text derived? Does it default to `"Photo of " + dish.name` or must it be an explicit reviewed field?
6. **Allergen and Dietary Sourcing**:
   - *Question*: In PR #73, candidate review corrections do not persist allergens or dietary codes. Where are approved allergen states (`null`, `[]`, or approved codes) and dietary codes captured prior to bundle production?
7. **Menu and Category Persistence**:
   - *Question*: Database tables currently exist for dishes (`dish_current`) and extraction review sessions (`candidate_review_current`), but there is no `menu` or `menu_category` database entity. Does the producer accept a menu manifest file/payload to construct the category hierarchy?
8. **Incomplete Placeholder Rendering in DIN-03**:
   - *Question*: `PublicMenuIncompleteDishSchema` requires strict `{ dish_id, dish_revision_id, complete: false }`. `frontend/diner/src/menu/adapter.ts` line 46 currently treats dishes without ingredients as incomplete placeholders even if marked complete. Once strict Bundle v1 is served, how does the diner UI render an incomplete placeholder that has no name or price?

---

## 7. Proposed Producer Interface and Module Placement (PROPOSAL ONLY)

*Note: This is an architectural proposal only. Implementation code is deferred to its own slice and spec.*

### 7.1 Module Placement
- Placement: `backend/src/bundle-producer/` (TypeScript service) or a standalone CLI script `scripts/produce-bundle.ts` for build-time generation.
- Shared contracts: Reuses `@peekaplate/contracts` (`PublicMenuContentBundleSchema`, `canonicalJson`, `sha256`).

### 7.2 Proposed TypeScript Interface

```ts
import type { PublicMenuContentBundle } from '@peekaplate/contracts';

export interface ProducerDishInput {
  dishId: string;
  dishRevisionId: string;
  complete: boolean;
  name?: string;
  description?: string;
  price?: {
    amount: string;
    currency: string;
  };
  ingredients?: Array<{
    ingredientId: string;
    name: string;
    description: string | null;
  }>;
  allergens?: Array<'milk' | 'egg' | 'fish' | 'crustacean shellfish' | 'nuts' | 'peanut' | 'wheat' | 'soy' | 'sesame'> | null;
  dietary?: Array<'vegan' | 'vegetarian' | 'gluten-free'>;
  assetManifestId?: string; // e.g. "t0_47d5c89419fee335933a1b3523bad850"
  altText?: string;
}

export interface ProducerCategoryInput {
  categoryId: string;
  name: string;
  dishes: ProducerDishInput[];
}

export interface ProducerBundleInput {
  venueId: string;
  menuId: string;
  menuRevisionId: string;
  restaurantName: string;
  restaurantLogoUrl?: string | null;
  categories: ProducerCategoryInput[];
  assetBaseUrl: string;
}

export interface ProducedBundleOutput {
  bundle: PublicMenuContentBundle;
  canonicalJson: string;
  contentHash: string; // 64-hex SHA-256
  assetManifestHash: string; // 64-hex SHA-256
}

export interface BundleStorageTarget {
  uploadBundle(key: string, content: string, contentType: string): Promise<string>; // returns public HTTPS URL
}
```
