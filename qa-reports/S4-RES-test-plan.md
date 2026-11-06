# S4-RES QA Test Plan: Trusted Immutable Menu Bundle Producer

**Date**: 2026-11-06  
**Base Commit**: `d6e5a16` (`origin/develop`, PR #76)  
**Branch**: `feat/s4-res-bundle-producer`  
**ClickUp Task**: [86bct99xa](https://app.clickup.com/t/86bct99xa) (S4-RES: Produce trusted immutable menu bundles for staging)  
**Author**: Marwan Ammar (`myler71`)  
**Design Reference**: [docs/s4-res-bundle-producer.md](../docs/s4-res-bundle-producer.md)  
**Status**: Ready for Implementation (QA-first test plan written prior to code; Actual and Status columns left empty until execution)

---

## 1. Environment and Execution Prerequisites

| Item | Value |
|---|---|
| OS | Windows 10.0.26200, x64 |
| Node.js | 24.16.0 |
| pnpm | 11.25.0 |
| Python / uv (for asset processing) | Python 3.12.13 via `uv` 0.11.30 |
| Database | Disposable PostgreSQL 16 via Docker (`pnpm verify test:db`) |
| Headless Browser | Playwright Chromium 390×844 mobile viewport (`prefers-reduced-motion: no-preference`) |
| Shared Contracts | `@peekaplate/contracts` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts)) |
| Data Provenance | Synthetic fixtures for local CI; staging deployment required for live/staging gates |

### 1.1 Scope and Verification Policy
Following PeekaPlate contributor guidelines ([AGENTS.md](../AGENTS.md) lines 21-23), this plan is written **before** any producer implementation is authored. Synthetic fixtures prove local contract compliance but do not prove production readiness. Tests requiring deployed Worker endpoints, Cloudflare R2 object storage, public CORS headers, or live diner frontend rendering are marked as `live` or `staging` and require staging deployment gating.

---

## 2. Acceptance Criteria Traceability

Traced directly to ClickUp task S4-RES ([86bct99xa](https://app.clickup.com/t/86bct99xa)):

| ID | ClickUp AC Summary | Acceptance Criterion Specification |
|---|---|---|
| **AC-S1** | Three permitted dishes with exact provenance | Producer builds an immutable Bundle v1 containing three permitted, approved dishes with verifiable source hashes, revision IDs, and T0 asset references using `PublicMenuContentBundleSchema` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 231-287). |
| **AC-S2** | Immutable round-trip & idempotence | Producer demonstrates deterministic byte/hash round-trip, repeat-build idempotence (identical input produces byte-for-byte identical output and SHA-256), and new version/hash when approved content changes. |
| **AC-S3** | Negative validations & strict exclusion | Producer strictly rejects invalid and duplicate IDs, unknown fields, missing assets, and malformed incomplete placeholders (which must contain ONLY identity UUIDs and `complete: false`). Strictly excludes stale, rejected, pending, private, and cross-tenant data. Prohibits invented ingredients, allergens, dietary claims, and synthetic food imagery. |
| **AC-S4** | RES-02 handoff & DIN-03 staging consumption | RES-02 accepts URL/hash/revision handoff into `menu_review_subject` and `public_menu_bundle`; DIN-03 consumes published output on staging origin; verify atomic replacement on new publication and withdrawal on fresh load. |
| **AC-S5** | Complete evidence recording | Full recording of merged PR/CI runs, deployed Worker/frontend/schema versions, expected vs actual outcomes, and strict labeling of synthetic fixture vs live provenance. |
| **AC-S6** | Independent technical & security reviews | Independent technical/security review by Sai (`@hemu77`), code review by Jeffin, and sign-offs by Shirley, Adam, Rania, and Amr. Authors cannot approve own work ([AGENTS.md](../AGENTS.md) lines 37-45). |

---

## 3. Test Cases Matrix

*Note: In accordance with QA-first planning rules, `Actual` and `Status` columns are left empty until implementation and execution.*

| ID | Traces to | Layer | Preconditions / Steps | Expected | Actual | Status |
|---|---|---|---|---|---|---|
| **S4-AUTO-1** | AC-S1 | unit | Run full contract unit tests: `pnpm --filter @peekaplate/contracts test` | All contract tests pass without regression; `PublicMenuContentBundleSchema` validates test bundle fixture. | | |
| **S4-AUTO-2** | AC-S3 | DB | Run database migration and pgTAP suite: `pnpm verify test:db` | All migrations up to `20261025130000_public_menu_bundle.sql` apply cleanly; RLS policies and append-only triggers pass 100%. | | |
| **S4-BLD-1** | AC-S1 | unit / integration | Supply 3 approved dishes: Dish 1 (Complete, Sesame Salad with allergens `['sesame']`, dietary `['vegan', 'gluten-free']`, T0 card/detail images), Dish 2 (Complete, Tomato Soup with reviewed allergens `[]`, dietary `['vegetarian']`, T0 card/detail images), Dish 3 (Incomplete placeholder, `complete: false`). Run bundle producer. | Bundle produces valid UTF-8 JSON conforming to `PublicMenuContentBundleSchema`. Exact `venue_id`, `menu_id`, `menu_revision_id`, `category_id`, `dish_id`, `dish_revision_id`, and HTTPS asset URLs match inputs. | | |
| **S4-HASH-1** | AC-S2 | unit | Produce bundle from S4-BLD-1. Compute SHA-256 digest using `sha256(canonicalJson(bundle))` ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 889-968) and compare with `bundle.contentHash`. | `contentHash` matches 64-hex lowercase pattern `^[a-f0-9]{64}$`; digest round-trips identically between canonical serializer and raw UTF-8 bytes. | | |
| **S4-IDEM-1** | AC-S2 | unit | Execute bundle producer twice with identical inputs into separate memory/file targets. | Byte-for-byte identical output (`bundle1 === bundle2`); matching SHA-256 content hashes. Zero timestamp or non-deterministic field leakage in bundle body. | | |
| **S4-VER-1** | AC-S2 | unit | Modify one attribute at a time and re-run producer: (a) Dish name; (b) Price amount (`"12.50"` -> `"13.00"`); (c) Ingredient list; (d) Allergen state (`null` -> `[]`); (e) Image URL; (f) New `dish_revision_id`. | Each modification produces a strictly different SHA-256 `contentHash` (`hashNew !== hashOriginal`). | | |
| **S4-NEG-1** | AC-S3 | unit | Pass malformed UUID strings for `venue_id`, `menu_id`, `menu_revision_id`, `category_id`, `dish_id`, `dish_revision_id`, or `ingredient_id` (e.g. non-UUID `"not-a-uuid"`, upper-case strings, strings with NUL byte `\u0000`). | Producer rejects input with Zod validation error; no bundle is generated. | | |
| **S4-NEG-2a** | AC-S3 | unit | Supply two categories with identical `category_id` in bundle categories array. | `PublicMenuContentBundleSchema.superRefine` rejects with error `"Category IDs must be unique"`. | | |
| **S4-NEG-2b** | AC-S3 | unit | Supply two dishes with identical `dish_id` across different categories or within the same category. | `PublicMenuContentBundleSchema.superRefine` rejects with error `"Dish IDs must be unique across the menu"`. | | |
| **S4-NEG-2c** | AC-S3 | unit | Supply two ingredients with identical `ingredient_id` within a single complete dish. | `PublicMenuContentBundleSchema.superRefine` rejects with error `"Ingredient IDs must be unique within a dish"`. | | |
| **S4-NEG-3a** | AC-S3 | unit | Inject unknown top-level field `extra_field: "test"` into root bundle object. | Zod `strictObject` throws `unrecognized_keys`; bundle rejected. | | |
| **S4-NEG-3b** | AC-S3 | unit | Inject unknown field into category, complete dish, incomplete dish, ingredient, or image object (e.g. `raw_ocr`, `confidence`, `bounding_box`, `2.5D_spatial`). | Zod `strictObject` throws `unrecognized_keys`; bundle rejected. | | |
| **S4-NEG-4a** | AC-S3 | unit | Complete dish with missing `images` property, `null` images object, or missing `images.card` or `images.detail`. | Validation failure; complete dishes strictly require both card and detail `PublicMenuImageSchema` objects. | | |
| **S4-NEG-4b** | AC-S3 | unit | Supply plain HTTP URL for image: `http://assets.example.test/dish.jpg`. | Zod URL refinement throws `"Public menu assets require HTTPS"`. | | |
| **S4-NEG-5a** | AC-S3 | unit | Supply incomplete dish with only `dish_id`, `dish_revision_id`, and `complete: false`. | Validation passes; `PublicMenuIncompleteDishSchema` accepts minimal identity shape. | | |
| **S4-NEG-5b** | AC-S3 | unit | Supply incomplete dish (`complete: false`) with partial fields (e.g. `name: "Soup"`, `price: {...}`, `ingredients: []`, or `images: {...}`). | Zod `strictObject` on `PublicMenuIncompleteDishSchema` rejects unexpected keys. | | |
| **S4-EXCL-1** | AC-S3 | integration / DB | Input database containing candidate reviews (`candidate_review_current`) in statuses: `rejected`, `incomplete`, and `pending`. | Producer includes only approved/corrected candidate items; rejected and unapproved candidates are completely omitted from bundle categories. | | |
| **S4-EXCL-2** | AC-S3 | integration | Review extraction session has bounding boxes (`BoxEvidence`), source text spans, reviewer UUIDs (`reviewed_by`), notes (`review_note`), and artifact references (`private_artifact_key`). Run producer. | Generated bundle JSON contains 0 private fields; regex search for reviewer UUID, notes, and coordinates returns zero matches. | | |
| **S4-EXCL-3** | AC-S3 | DB | Attempt to produce bundle for Tenant A using dish revisions or categories registered under Tenant B in PostgreSQL. | Query fails under RLS (`tenant_id = current_setting('app.tenant_id')`); cross-tenant content denied. | | |
| **S4-NOINV-1** | AC-S3 | unit | Attempt to include allergen display label (e.g. `"Peanuts"`, `"tree nut"`) or unapproved allergen code (`"mustard"`). | Validation fails; only the 9 approved closed-list codes are permitted ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) lines 181-191). | | |
| **S4-NOINV-2** | AC-S3 | unit | Complete dish with omitted or undefined `allergens` property. | Validation fails; `allergens` is required on complete dishes (must be explicit `null`, `[]`, or non-empty approved codes). | | |
| **S4-NOINV-3** | AC-S3 | unit | Complete dish with unapproved dietary code (e.g. `"halal"`, `"keto"`, or `"Vegetarian"`). | Validation fails; only `'vegan'`, `'vegetarian'`, `'gluten-free'` are permitted ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts) line 193). | | |
| **S4-RES02-1** | AC-S4 | API / DB | (1) Privileged role inserts produced bundle metadata into `app_private.menu_review_subject` and `app_private.public_menu_bundle`; (2) Authorized owner approves revision via `POST /venues/:venueId/menus/:menuId/commands/approve`; (3) Owner publishes menu via `POST /venues/:venueId/menus/:menuId/commands/publish`. | Both commands return 200 with idempotent receipts; `menu_publication_current` status is `'published'`. | | |
| **S4-RES02-2** | AC-S4 | API | Send anonymous `GET /public/venues/:venueId/menus/:menuId`. | Returns 200 `PublicMenuResponseSchema` with `bundle.url` matching bundle URL and `bundle.contentHash` matching produced hash. | | |
| **S4-DIN03-1** | AC-S4 | live / staging | **Requires Staging Deployment**: Fetch menu from staging public endpoint; fetch immutable bundle JSON from `bundle.url`. Validate with `PublicMenuDeliverySchema` and verify `response.bundle.contentHash == sha256(canonicalJson(bundle))`. Render menu via `frontend/diner/src/menu/adapter.ts`. | Bundle parses successfully; delivery schema passes; hash matches; 3 dishes render with correct cards, ingredients, and allergen/dietary chips. | | |
| **S4-REPL-1** | AC-S4 | browser / live | **Requires Staging Deployment**: Produce Menu Revision 2 (price update). Owner publishes Revision 2. Diner client performs periodic poll or reload. | Diner client detects new `publicationId`, fetches new bundle, verifies hash, and replaces displayed menu atomically without mixing old and new content. Queued observations retain original publication ID ([docs/public-menu.md](../docs/public-menu.md) lines 69-75). | | |
| **S4-WITH-1** | AC-S4 | API / browser | Owner issues `POST /venues/:venueId/menus/:menuId/commands/withdraw`. Perform fresh fetch on `GET /public/venues/:venueId/menus/:menuId`. | Public endpoint immediately returns 404 `{"error":"not_found"}`. Diner screen transitions to error / unavailable state; no cached publication served. | | |
| **S4-EVID-1** | AC-S5 | repo / CI | Generate QA execution evidence report documenting commit SHA, CI run URL, Docker PostgreSQL migration output, and Vitest results. | Report is committed to `qa-reports/` with PASS/FAIL/NOT RUN clearly stated; synthetic vs live provenance distinguished. | | |

---

## 4. Data Provenance and Gating

### 4.1 Synthetic Fixture Provenance (Local & CI)
The following fixtures are permitted for local unit and integration tests:
- **Synthetic Venue & Menu UUIDs**: RFC 4122 v4 UUIDs generated via `randomUUID()` or deterministic test seeds (`00000000-0000-4000-8000-000000000101`).
- **Synthetic Dishes**: Permitted test dishes (`Garden Bowl`, `Tomato Soup`, `Incomplete Placeholder`) modeled on [packages/contracts/src/index.test.ts](../packages/contracts/src/index.test.ts) (lines 205-258).
- **Synthetic Assets**: T0 images generated using VIS-03 fixture factory (`processing/tests/fixture_factory.py` on branch `fork/feat/s3-vis-03-asset-delivery`), producing deterministic JPEG/WebP variants and SHA-256 manifests.
- *Boundary Warning*: Synthetic test fixtures verify schema constraints, serialization, and database triggers only. They do NOT satisfy staging acceptance (AC-S4) or prove production delivery.

### 4.2 Live Staging Provenance (Deployment Gates)
The following test cases require a deployed environment and must remain `NOT RUN` / `BLOCKED` in local runs:
- `S4-DIN03-1` (Staging bundle fetch, CORS verification, and diner browser rendering).
- `S4-REPL-1` (Live atomic replacement across publication versions).
- `S4-WITH-1` (Live withdrawal verification on staging Worker).
- Deployment requirements:
  1. Staging Cloudflare Worker deployed with active publication migrations ([migrations/20261025120000_menu_publication.sql](../migrations/20261025120000_menu_publication.sql) and [migrations/20261025130000_public_menu_bundle.sql](../migrations/20261025130000_public_menu_bundle.sql)).
  2. Cloudflare R2 bucket provisioned for immutable bundle hosting with verified `Access-Control-Allow-Origin: https://diner-staging.peekaplate.com` and `Vary: Origin`.
  3. Valid ES256 menu signing key configured in Worker secrets.

---

## 5. Review and Sign-Off Gates

In accordance with PeekaPlate contributor guidelines ([AGENTS.md](../AGENTS.md) lines 37-45) and AC-S6:

| Role | Name / GitHub Handle | Gate / Verification Focus | Sign-Off Status |
|---|---|---|---|
| Technical / Security Verification | Sai Hemanth Kilaru (`@hemu77`) | RLS enforcement, cryptographic hash integrity, CORS security, cross-tenant isolation, no private evidence leakage. | `PENDING` |
| Code Review | Jeffin | Code structure, TypeScript contract alignment, error handling, DIN-03 adapter compatibility. | `PENDING` |
| Product & Strategy Sign-Off | Shirley | Menu completeness rules, incomplete placeholder presentation, allergen/dietary assertion policy. | `PENDING` |
| Engineering Sign-Off | Adam | Backend architecture alignment, event-sourcing invariants, migration immutability. | `PENDING` |
| Operations Sign-Off | Rania | Staging deployment, R2 bucket provisioning, CORS configuration, monitoring. | `PENDING` |
| Architecture Sign-Off | Amr | Selective event-sourcing boundaries, cross-module seams, ADR 0002 / ADR 0005 compliance. | `PENDING` |
