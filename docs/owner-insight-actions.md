# Owner Insight Actions API

## Purpose

S5-DATA-10 provides versioned, authenticated API operations and tenant-scoped persistence for owner-selected actions associated with menu insights.

Stored fields include the opaque insight key, menu and exact revision, selected category, status, optional note, actor metadata, and timestamps. Diner-level event details and generated recommendation text are not stored.

## Authentication and authorization

All routes require a verified staff bearer token. The actor is derived from server-side token verification. Venue scope comes from the route and is checked against current server-side membership.

The current implementation permits venue owners only. Editors, viewers, missing memberships, and revoked memberships are denied. Browser-supplied venue or actor identifiers do not grant authority.

Authorization and the database operation execute in one transaction. The membership row is locked before tenant context is established. The action table uses forced row-level security and tenant-scoped policies.

Owner-only access is the conservative implementation assumption. The final owner/editor/viewer permission matrix remains a product-alignment item; editor access is not currently supported.

## Versioned contract

The shared contract is defined in `packages/contracts/src/owner-actions.ts`.

Supported categories:
- `price_adjustment`
- `item_rearrangement`
- `description_update`
- `promotion`

Supported statuses:
- `planned`
- `active`
- `archived`

Notes are optional or nullable and limited to 500 characters. Empty or whitespace-only notes and NUL characters are rejected.

## API routes

All routes are under `/venues/:venueId/owner-insight-actions`.

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/venues/:venueId/owner-insight-actions` | List actions | 200 |
| POST | `/venues/:venueId/owner-insight-actions` | Create an action | 201 |
| PATCH | `/venues/:venueId/owner-insight-actions/:actionId` | Update an action | 200 |

### List

Optional query parameters:
- `insightKey`: exact insight-key filter.
- `menuRevisionId`: exact menu-revision UUID filter.
- `limit`: 1 to 100, default 50.

The response uses `schemaVersion: 1` and an `actions` array. Each action includes its ID, venue, insight key, menu and revision, category, status, note, version, actor metadata, and timestamps.

### Create

Example request:

```json
{
  "commandId": "10000000-0000-4000-8000-000000000001",
  "insightKey": "dish.low_conversion",
  "menuId": "20000000-0000-4000-8000-000000000001",
  "menuRevisionId": "30000000-0000-4000-8000-000000000001",
  "category": "description_update",
  "note": "Review the item description"
}
```

The initial status is `planned`, and the initial version is `1`. The server supplies the actor, venue scope, and audit timestamps. These cannot be overridden by the client.

The exact `(tenant_id, menu_id, menu_revision_id)` relationship must exist in `app_private.menu_review_subject`.

### Update

Example request:

```json
{
  "commandId": "40000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "status": "active",
  "note": "Description revision is in progress"
}
```

At least one of `status` or `note` is required. `expectedVersion` must match the current record version. Sending `note: null` clears the note.

Successful updates increment the version and update actor and timestamp metadata. Stale versions return a conflict.

### Response example

```json
{
  "schemaVersion": 1,
  "action": {
    "actionId": "50000000-0000-4000-8000-000000000001",
    "venueId": "00000000-0000-4000-8000-000000000001",
    "insightKey": "dish.low_conversion",
    "menuId": "20000000-0000-4000-8000-000000000001",
    "menuRevisionId": "30000000-0000-4000-8000-000000000001",
    "category": "description_update",
    "status": "planned",
    "note": "Review the item description",
    "version": 1,
    "createdBy": "60000000-0000-4000-8000-000000000001",
    "updatedBy": "60000000-0000-4000-8000-000000000001",
    "createdAt": "2026-11-10T12:00:00.000Z",
    "updatedAt": "2026-11-10T12:00:00.000Z"
  }
}
```

Identifiers and timestamps are illustrative.

## Idempotency and concurrency

Create and update requests require a UUID `commandId`.

- Repeating the same command ID and request replays the stored result.
- Reusing a command ID with a different request returns `command_conflict`.
- A transaction-scoped advisory lock serializes receipt lookup and writes.
- The action mutation and receipt are committed atomically in `app_private.es_command`.
- Updates use `expectedVersion` to reject stale writes.

## Persistence and privacy

The forward-only migration creates `app_private.owner_insight_action_current`.

Database protections include:
- Composite `(tenant_id, action_id)` primary key.
- Composite tenant/menu/revision foreign key.
- Category, status, and note constraints.
- Forced row-level security using transaction tenant context.
- Runtime SELECT, INSERT, and UPDATE privileges only.
- No runtime DELETE privilege.
- Tenant-scoped reads and writes.

Actor IDs are retained as audit metadata without a membership foreign key that would prevent records surviving membership revocation.

Notes and command receipts are persisted data, not log fields. Do not add note bodies, diner payloads, or generated recommendation text to application logs.

## Insight identity limitation

The current `owner_report.v1` contract does not expose a durable insight identifier or report snapshot ID.

Consequently, `insightKey` is currently an opaque, validated, venue-scoped string. It is not a foreign key to a report insight, and this implementation cannot prove that it identifies a particular generated aggregate insight.

The shared owner-action contract establishes category and status vocabulary but does not establish report identity. UI integration must not assume semantic report linkage until a durable report-to-insight mapping is defined.

## Error responses

Errors use a JSON object containing an error code.

| HTTP | Error | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid route, query, or request fields |
| 400 | `invalid_json` | Malformed JSON body |
| 401 | `unauthorized` | Missing or invalid authentication |
| 403 | `forbidden` | Missing, revoked, read-only, or out-of-scope membership |
| 404 | `menu_revision_not_found` | Exact menu revision does not exist for the venue and menu |
| 404 | `not_found` | Action does not exist in the authorized venue |
| 409 | `command_conflict` | Idempotency key reused with a different request |
| 409 | `version_conflict` | Expected action version is stale |
| 415 | `unsupported_media_type` | Request is not JSON |
| 503 | `service_unavailable` | Required authentication or database dependency unavailable |

## Verification status

November 11 independent local verification on the reconciled develop candidate:

- PASS: pnpm exec vitest run backend/src/comparison-report.test.ts backend/src/owner-insight-actions.test.ts packages/contracts/src/owner-actions.test.ts backend/src/index.test.ts - 101 tests, 1.49 seconds.
- PASS: pnpm verify test:db - 298 pgTAP assertions, 114 real PostgreSQL/Worker integration tests; integration phase 24.39 seconds. The local authenticated Worker smoke test also passed.
- Additional HTTP cases prove competing updates produce one success and one version conflict, a previous update receipt does not revert later state, changed command payloads conflict, and an owner of two venues cannot list or update an action through the wrong venue.
- The full database run initially failed six comparison-reader cases at the existing five-second statement timeout. Materializing the requested tenant/time-window fact set once removed repeated view expansion. The same full runner now passes, and the eleven focused comparison cases include 1,000 unrelated synthetic observations.
- PASS: `pnpm check` - 1,397 unit tests (four optional skips), 74 script tests, strict types, lint, context and documentation links. Unit phase: 7.14 seconds.
- PASS: `pnpm verify build` - both frontends and staging Worker dry-run, approximately 6.84 seconds. No deployment.
- PASS: `pnpm exec playwright test --workers=2` - 137 Chromium cases in 1.3 minutes, including the previously reported menu-trigger consent case.
- PASS: `pnpm exec playwright test --config playwright.posthog.config.ts --workers=2` - nine SDK/privacy cases in 13.5 seconds. The private verification wrapper used the repository runner to preserve child failures and record failures in the ledger.
- Previous author counts and failures describe earlier revisions; the results above are the current independent run.

These checks use local disposable PostgreSQL and a running local Worker. They do not establish hosted Supabase/Hyperdrive behavior or a complete owner-dashboard workflow.

## Outstanding acceptance gates

- Hosted staging migration and deployment.
- Live staging authorization and cross-tenant verification.
- Release review of the eventual hosted migration and API deployment.
- Final product alignment on editor permissions.
- Durable report-to-insight identity and mapping.
- Full staging workflow verification.

Local database and Worker tests do not establish hosted staging behavior.
