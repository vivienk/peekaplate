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

The response deliberately does not invent dish, ingredient or allergen fields while the initial content policy remains unresolved. The immutable bundle is the versioned content payload; this endpoint is the small active-publication pointer described by the implementation plan.

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

The token travels only in `Authorization: Bearer <menu_token>` when the observation endpoint is integrated. It is not restaurant authority for staff commands. Withdrawal blocks new public reads immediately; already issued tokens may remain cryptographically valid until expiry. Renewal and historical-event rules remain part of the unresolved D4 release decision and must be enforced by the observation verifier before live collection.

## Verification boundary

Unit tests validate the response, HTTPS-only bundle pointer, strict unknown-field rejection, signing-key failure, issuer/audience, exact claims and 30-minute lifetime. HTTP tests prove anonymous success, malformed-scope rejection, indistinguishable missing/withdrawn behavior and fail-closed dependency handling. The disposable PostgreSQL integration test covers draft `404`, approval and publication, restricted-role public read, signed claims, withdrawal and fresh-fetch `404`. pgTAP verifies RLS and that the runtime role cannot insert or mutate bundle handoffs.

Local fixtures use only synthetic UUIDs, hashes and `example.test` URLs. They do not certify hosted assets, operator secret setup, provider bindings or production release readiness.
