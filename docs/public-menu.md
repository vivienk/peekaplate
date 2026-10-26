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

The immutable bundle is UTF-8 JSON served with `Content-Type: application/json` and browser-readable CORS for the approved diner origins. It has top-level restaurant identity and presentation (restaurant name and optional immutable logo), the exact `venueId`, `menuId`, `menuRevisionId` and `publicationId`, and an ordered category/dish collection. The response `publicationId` is the observation contract's `publication_revision_id`; there is no second browser-selected publication revision. Each complete dish supplies its canonical `dish_id` and `dish_revision_id`, price plus currency, category identity/name, ordered ingredient names, and T0 card/detail image variants with dimensions and alt text. Dietary values are limited to explicit approved `Vegan`, `Vegetarian` and `Gluten-free` values and are never inferred. Allergen values remain absent until the content-policy closed list is approved; arbitrary allergen strings are not allowed. An approved 2.5D asset is optional and must retain the T0 image fallback.

Only the current approved publication may appear. A content-incomplete dish carries only its IDs and `complete: false`; it exposes no partial price, ingredient, dietary, allergen or asset claims. A withdrawn dish is omitted from the next publication bundle. Draft, rejected, reviewer and source-evidence fields never enter the public bundle. Bundle and image URLs are public, immutable HTTPS objects; changing any content requires a new revision and hashes rather than overwriting an existing URL.
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

The token travels only in `Authorization: Bearer <menu_token>` when the observation endpoint is integrated. QR navigation uses `/venues/:venueId/menus/:menuId`; an optional `?src=qr` records only `entry_source` and is never part of menu identity or authorization. It is not restaurant authority for staff commands. Withdrawal blocks new public reads immediately; already issued tokens may remain cryptographically valid until expiry. The diner re-reads the public endpoint on load and before token expiry. If the same publication is still active, that read issues a fresh token and queued observations for that same publication may resume. If the read returns 404 or a different publication, the diner must stop collection and must not relabel old observations. An expired token cannot submit until a successful same-publication refresh; withdrawal never issues a replacement token. The API intentionally does not distinguish missing, draft and withdrawn content. The diner may show one menu-unavailable state for HTTP 404, while transport/offline failure remains a separate retryable state.

## Verification boundary

Unit tests validate the response, HTTPS-only bundle pointer, strict unknown-field rejection, signing-key failure, issuer/audience, exact claims and 30-minute lifetime. HTTP tests prove anonymous success, malformed-scope rejection, indistinguishable missing/withdrawn behavior and fail-closed dependency handling. The disposable PostgreSQL integration test covers draft `404`, approval and publication, restricted-role public read, signed claims, withdrawal and fresh-fetch `404`. pgTAP verifies RLS and that the runtime role cannot insert or mutate bundle handoffs.

Local fixtures use only synthetic UUIDs, hashes and `example.test` URLs. They do not certify hosted assets, operator secret setup, provider bindings or production release readiness.

## Observation field mapping

For `observation.v2`, `publication_revision_id` is copied from the public response `publicationId`. Dish events copy `dish_id` and `dish_revision_id` from the selected immutable bundle item. `menuRevisionId` identifies the approved menu content revision but is not substituted for publication authority. The legacy `publicationHash`, `dishRevisionHash` and `displayedTier` fields belong to the earlier dish-intent contract and are not added to `observation.v2`; the current bundle already fixes T0 and the server retains the approved hashes.
