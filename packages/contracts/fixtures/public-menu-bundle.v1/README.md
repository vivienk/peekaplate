# Public menu bundle v1 round-trip fixture

Synthetic data; not production evidence. Shared by the S4-RES producer, RES-02 and DIN-03 consumers to check the integrity rule.

## Rule

- Bundle bytes are the UTF-8 encoding of `canonicalJson(PublicMenuContentBundleSchema.parse(bundle))` (sorted keys, no whitespace, no trailing newline).
- `contentHash` is the lowercase hex SHA-256 of those exact bytes.
- A consumer hashes the fetched bytes and compares with `bundle.contentHash` from the public menu response **before** `JSON.parse`. It never re-serializes. `verifyPublicMenuContentBytes` in `@peekaplate/contracts` implements this.

## Files

| File | Content |
|---|---|
| `bundle.json` | Exact canonical bytes of a 3-dish bundle: 2 complete dishes, 1 incomplete placeholder. |
| `expected.json` | `{ "contentHash": "<sha256 of bundle.json>" }` |
| `tampered.json` | `bundle.json` with one price digit changed (`28.50` → `29.50`); must fail with `content_hash_mismatch`. |

## How it was generated

A one-off Vitest snippet built the object by hand with fixed UUIDs (`00000000-0000-4000-8000-0000000001xx`), parsed it with `PublicMenuContentBundleSchema`, and wrote `canonicalJson(parsed)` without a trailing newline. Biome excludes this directory (`biome.json`) so formatting never changes the bytes. Do not edit `bundle.json` by hand; regenerate it and update `expected.json` and `tampered.json` together.
