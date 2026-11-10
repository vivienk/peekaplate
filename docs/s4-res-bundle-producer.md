# S4-RES: Trusted immutable menu bundle producer

**Task:** [S4-RES](https://app.clickup.com/t/86bct99xa) · **Branch:** `feat/s4-res-bundle-producer` · **Synced develop:** `93194f2`

## 1. Scope

The operator CLI produces strict Bundle v1 JSON from approved dish revisions, a restaurant-confirmed request and T0 manifests. It does not publish or upload. RES-02 approval, publication and withdrawal remain separate authorized commands. A T0 manifest alone is not approval. Request-file assertions must be confirmed by the restaurant. Private extraction and review fields are not serialized.

## 2. Bundle contract

The authoritative schema is `PublicMenuContentBundleSchema` in [contracts](../packages/contracts/src/index.ts). It accepts 0–100 ordered categories, each with 0–500 dishes. IDs are unique across the menu. An incomplete dish contains exactly `dish_id`, `dish_revision_id`, and `complete: false`; complete dishes include name, description, one scalar price, ingredients, allergens, dietary codes and two HTTPS images. Unknown fields are rejected. `allergens: null` means unavailable; `[]` means a reviewed empty declaration, not an allergen-free guarantee.

## 3. Integrity, IDs and handoff

Bundle bytes are UTF-8 of `canonicalJson(PublicMenuContentBundleSchema.parse(bundle))`, with no trailing newline. `contentHash` is SHA-256 of those exact bytes. Consumers must hash the fetched bytes against `response.bundle.contentHash` **before** parsing, not reserialize them. `verifyPublicMenuContentBytes` and the [synthetic fixture](../packages/contracts/fixtures/public-menu-bundle.v1/README.md) implement this rule; DIN-03 adoption remains open.

`derivedUuid(label, ...parts)` uses the first 16 SHA-256 bytes of `peekaplate:` + label + newline + newline-joined parts, setting version 8 and RFC variant bits. Menu revision ID uses label `menu-revision:v1` and canonical JSON of the bundle with `menu_revision_id` omitted. Ingredient IDs use `ingredient:v1`, dish revision, index and name. Content and asset approval IDs use `content-approval:v1` and `asset-approval:v1` with their respective hashes.

The asset manifest hash is SHA-256 of canonical `{schema_version:1, assets:[...]}`, sorted by dish ID, containing each complete dish's ID, revision ID, asset ID, and card/detail URL, digest and dimensions. **Asset URLs must be immutable.** If asset bytes change behind an unchanged URL, bundle bytes and revision ID do not change, but the asset hash does; admission rejects the conflicting existing handoff. Publish changed assets at new immutable URLs.

The bundle URL is `<bundle_base_url>/<venue_id>/<menu_id>/<menu_revision_id>.json`. Upload and hosting are operator responsibilities. `--admit` inserts `menu_review_subject` and `public_menu_bundle` in one transaction through a privileged connection; identical retries are accepted, conflicts roll back. The runtime role cannot insert either record. Admission is not staff approval or publication.

RES-02 routes are `POST /venues/:venueId/menus/:menuId/approvals`, `/publications`, `/withdrawals`, and `GET /public/venues/:venueId/menus/:menuId`. See [public-menu.md](public-menu.md).

## 4. Input and precedence

The strict request file supplies venue/menu IDs, restaurant identity, HTTPS base URLs, ordered categories and dishes, and restaurant-confirmed allergen declarations, dietary codes, image alt text and T0 asset IDs. These fields have no reviewed store yet; the operator must confirm their provenance. Unknown fields and duplicate category or dish IDs are rejected.

Name, description and revision come from tenant-scoped `dish_current`. Price, currency and ingredients come from the single accepted/edited draft linked to the dish. RES-01.2 corrections override those three fields when the extraction session's job and candidate match. A rejected candidate is omitted; an incomplete review or a corrected review with remaining incomplete fields becomes a placeholder. Missing dishes, ambiguous approved drafts or ambiguous candidate reviews fail the build. The loader reads a repeatable, read-only snapshot and explicitly filters by tenant even when the connection bypasses RLS.

The T0 reader requires a valid source SHA-256 and a nonblank capture-evidence reference, and uses `card-480` and `detail-1280` WebP variants with matching delivery filenames. The CLI verifies their file digests and sizes against the manifest. Capture evidence stays private; its presence does not prove photographic authenticity or human approval. A mismatched dish ID is an error; a stale dish revision yields a placeholder. Manifest approval is not inferred.

## 5. Completeness and diagnostics

Complete dishes require a valid nonblank description, representable price, valid ISO currency code, confirmed alt text and T0 asset for the current revision. Descriptions trimmed empty, longer than 4000 characters or containing NUL yield an identity-only placeholder with `description_missing`. Currencies missing or not matching `^[A-Z]{3}$` yield an identity-only placeholder with `currency_missing`. Ingredients must contain 1–100 nonblank names, each at most 160 characters after trimming and without NUL. A dish with missing or unrepresentable ingredients becomes an identity-only placeholder with `ingredients_missing`; diagnostics stay in the local handoff report, never the bundle. Price normalization uses decimal strings, not floating point: `12.5000` becomes `12.50`; more than two significant decimal places or eight integer digits is not representable. Multi-price dishes whose scalar price is absent become placeholders with `price_missing`.

## 6. Operator usage

```sh
pnpm produce:bundle --request <request.json> --t0-root <asset-root> \
  --database-url <privileged-db-url> --out work/menu-bundles
# After inspecting and uploading exact output bytes to the immutable HTTPS host:
pnpm produce:bundle --request <request.json> --t0-root <asset-root> \
  --database-url <privileged-db-url> --out work/menu-bundles --admit
```

`PEEKAPLATE_PRODUCER_DATABASE_URL` can supply the URL. Without `--admit` no database rows are written. Existing output files must match exactly and are never overwritten. Protect credentials from shell history and logs. The handoff report contains hashes, IDs, URL and diagnostics; it is not a substitute for approvals.

## 7. Remaining integration gates

- Deployment owner: choose HTTPS asset and bundle hosts and approved staging diner CORS origins; configure immutable hosting and verify byte-for-byte delivery.
- Harshita/Jeffin: adopt and test the shared byte verifier in DIN-03, including tamper failure and unavailable state.
- Confirm request-file allergens, dietary codes and alt with the restaurant until a reviewed store exists.
- Live DIN-03 rendering, atomic replacement, withdrawal, real content and independent stakeholder sign-offs remain staging gates. See [QA report](../qa-reports/S4-RES-test-plan.md).
