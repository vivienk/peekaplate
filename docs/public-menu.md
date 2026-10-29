# Public menu handoff and token

Status: local implementation slice for S3-RES-02. This is not a staging or production deployment record.

## Boundary

`GET /public/venues/:venueId/menus/:menuId` is anonymous. It returns only the active `published` projection joined to the exact approved revision and its immutable T0 bundle pointer. Missing, draft, unbundled and withdrawn menus all return the same `404 {"error":"not_found"}` shape. Responses use `Cache-Control: no-store` because each response contains a short-lived menu token.

The typed response is `PublicMenuResponseSchema` in `packages/contracts/src/index.ts`. It contains:

- venue, menu, menu-revision and publication identities;
- publication and approved content/asset hashes;
- the availability version and explicit `T0` tier;
- an HTTPS immutable bundle URL supplied by the approved upstream handoff;
- a 30-minute bearer token for observation ingestion.

The immutable JSON bundle is the versioned content payload; this endpoint is the small active-publication pointer described by the implementation plan. The pointer response does not duplicate dish content. The producer contract below now fixes the diner-facing minimum without allowing the browser to supply authority.

## Diner bundle contract

The immutable bundle is UTF-8 JSON served with `Content-Type: application/json`. `PublicMenuContentBundleSchema` in `packages/contracts/src/index.ts` is the authoritative version 1 shape; all objects are strict and reject unknown fields. Array order is display order.

| Location | Exact fields |
| --- | --- |
| Root | `schema_version: 1`; UUID strings `venue_id`, `menu_id`, `menu_revision_id`; `restaurant`; ordered `categories` |
| `restaurant` | trimmed `name`; `logo`, which is either an image object or `null` |
| Category | UUID `category_id`; trimmed `name`; ordered `dishes` |
| Complete dish | UUID `dish_id` and `dish_revision_id`; `complete: true`; trimmed `name`; `description`; decimal-string `price.amount`; three-letter uppercase `price.currency`; ordered `ingredients`; unique approved `allergens` and `dietary` codes; required T0 `images.card` and `images.detail` |
| Incomplete dish | only UUID `dish_id`, UUID `dish_revision_id` and `complete: false` |
| Ingredient | UUID `ingredient_id`; trimmed `name`; `description` string or `null` |
| Image | immutable HTTPS `url`; positive integer `width` and `height`; non-empty `alt` text |

`PublicMenuDeliverySchema` validates the fetched content together with `PublicMenuResponseSchema` and rejects any mismatch in venue, menu or menu-revision identity. The bundle is created before publication and is revision-scoped, so it does not contain the later-generated publication ID. The response `publicationId` remains the sole publication identity and maps to `publication_revision_id` in `observation.v2`; dish events copy `dish_id` and `dish_revision_id` from the selected bundle item.

`PublicMenuDeliverySchema` performs shape and identity validation only; it does not prove hash integrity. Before parsing or display, the DIN-03 adapter must verify the producer-defined hash input against `response.bundle.contentHash`. The producer and consumer must agree whether that input is exact UTF-8 bytes or a canonical serialization; until that rule is recorded and tested, a schema-valid fetch is not approved-content evidence.

Allergen and dietary values are explicit restaurant assertions, never inferred. The version 1 closed code lists are:

| Type | Exact codes |
| --- | --- |
| Allergen | `milk`, `egg`, `fish`, `crustacean shellfish`, `tree nut`, `peanut`, `wheat`, `soy`, `sesame` |
| Dietary | `vegan`, `vegetarian`, `gluten-free` |

Codes are stable contract identifiers rather than display labels or icon names. The diner maps them to the approved presentation; renaming a label does not change the wire value. Unknown or duplicate codes fail validation. Version 1 still contains no 2.5D field, and an unapproved spatial format is rejected as an unknown field. T0 card and detail images remain mandatory.

Only the revision referenced by the current approved publication may be displayed. A content-incomplete dish carries no partial name, price, ingredient, dietary, allergen or asset claims. A withdrawn dish is omitted from the next publication bundle. Draft, rejected, reviewer and source-evidence fields never enter the public bundle. Bundle and image URLs are public, immutable HTTPS objects; changing any content requires a new revision and hashes rather than overwriting an existing URL.

### Publication change and queued observations

Every queued observation keeps its original event ID, `publication_revision_id`, dish identity and original publication token relationship. It is never relabelled to a newer publication.

- While the original token remains valid, the diner may send queued events for that publication.
- Before expiry, the diner re-reads the public endpoint. If it returns the same publication, the new token may resume that publication's queue.
- A `404` or a different `publicationId` stops creation of old-publication events. Unsent old events may use only a token bound to their original publication. If that token expires, the events remain unchanged in the bounded outbox while the client requests renewal for the original allowed exposure; they are never relabelled or sent with the new publication's token. The normal 24-hour/size limits and terminal ingest receipts still govern removal.
- On a different publication, the diner fetches the new immutable bundle and validates the complete response/content pair with `PublicMenuDeliverySchema`. Only then does it replace the displayed menu atomically and begin a new publication-bound event stream. It must never mix old content with the new token. A failed content fetch or validation shows the retryable menu error state rather than continuing collection against stale content.

Jeffin's DIN-03 adapter owns runtime parsing and the fixture/live mapping. Ehab's re-read/outbox path owns the pre-expiry check, original-event preservation and publication transition. Harshita's DIN-03 surface owns the loading/error/menu-replacement states. RES-02 owns this shared contract and the server-side original-publication token-renewal boundary; DIN-03 must not ship renewal by substituting a current-publication token. The current public-read endpoint does not yet implement that renewal operation, so this remains a named backend dependency rather than completed behavior.

### CORS ownership

This contract does not approve deployment origins. An authorized deployment administrator must record the exact staging and production diner origins and configure both the Worker response and immutable-object host with a bounded allowlist and `Vary: Origin`. Repository CODEOWNERS are `@vivienk` and `@hemu77` (Sai Hemanth Kilaru); one of them must confirm the environment-level allowlist.

PR preview origins are intentionally excluded for now. Preview pages are static, carry `connect-src 'none'`, and have no API, database or analytics connection. Do not use `*`, the whole `pages.dev` domain or an unchecked reflected origin. Enabling API-connected previews requires a separately reviewed preview API boundary and an explicit origin pattern.
## Upstream producer contract

The forward migration creates `app_private.public_menu_bundle`, keyed by `(tenant_id, menu_id, menu_revision_id)` and foreign-keyed to `menu_review_subject`. Rows are append-only and tenant-scoped. The restricted runtime role has `SELECT` only: it cannot manufacture or replace an approved bundle. RES-01/VIS-03 must write the bundle row through its separately reviewed privileged ingestion path before owner approval/publication can become publicly readable.

Required upstream values are the canonical tenant, menu and menu-revision UUIDs plus an HTTPS URL for the immutable reviewed bundle. The content and asset-manifest hashes are not browser inputs; public reads obtain them from the immutable approval joined to that same revision.

## Menu token

The Worker signs an `ES256` JWT with the protected private JWK in `MENU_TOKEN_SIGNING_JWK`. `MENU_TOKEN_ISSUER` is the trusted HTTPS Worker origin (loopback HTTP is allowed only in local mode), and `GET /.well-known/jwks.json` exposes only the matching public key. The secret is configured by an authorized operator and is never stored in Git or returned by the JWKS endpoint. The audience is `peekaplate-observations`; this algorithm, issuer and discovery shape matches the DATA-01 remote-JWKS verifier. The strict claims are:

- `venue`: server-derived venue UUID;
- `publication`: the active publication UUID;
- `scope`: exactly `observations`;
- `iat` and `exp`: exactly 30 minutes apart;
- `jti`: a fresh UUID used for token-scoped rate limiting.

The token travels only in `Authorization: Bearer <menu_token>` when the observation endpoint is integrated. QR navigation uses `/venues/:venueId/menus/:menuId`; an optional `?src=qr` records only `entry_source` and is never part of menu identity or authorization. It is not restaurant authority for staff commands. Withdrawal blocks new public reads immediately; already issued tokens may remain cryptographically valid until expiry. The diner re-reads the public endpoint on load and before token expiry. That current-publication GET refreshes only the token for the publication it returns; it cannot authorize an old queue after replacement or withdrawal. The separately defined RES-02 renewal operation must either verify the original allowed exposure and issue a token for that same original publication, or return a bounded terminal rejection. Its eligibility policy for replaced and withdrawn publications, request proof and errors are not yet specified or implemented. Until they are, the client preserves unchanged old events subject to its normal 24-hour/size bounds and must not claim post-expiry delivery support. The API intentionally does not distinguish missing, draft and withdrawn content. The diner may show one menu-unavailable state for HTTP 404, while transport/offline failure remains a separate retryable state.

## Verification boundary

Unit tests validate the response, HTTPS-only bundle pointer, strict unknown-field rejection, signing-key failure, issuer/audience, exact claims and 30-minute lifetime. HTTP tests prove anonymous success, malformed-scope rejection, indistinguishable missing/withdrawn behavior and fail-closed dependency handling. The disposable PostgreSQL integration test covers draft `404`, approval and publication, restricted-role public read, signed claims, withdrawal and fresh-fetch `404`. pgTAP verifies RLS and that the runtime role cannot insert or mutate bundle handoffs.

Local fixtures use only synthetic UUIDs, hashes and `example.test` URLs. They do not certify hosted assets, operator secret setup, provider bindings or production release readiness.

## Observation field mapping

For `observation.v2`, `publication_revision_id` is copied from the public response `publicationId`. Dish events copy `dish_id` and `dish_revision_id` from the selected immutable bundle item. `menuRevisionId` identifies the approved menu content revision but is not substituted for publication authority. The legacy `publicationHash`, `dishRevisionHash` and `displayedTier` fields belong to the earlier dish-intent contract and are not added to `observation.v2`; the current bundle already fixes T0 and the server retains the approved hashes.
