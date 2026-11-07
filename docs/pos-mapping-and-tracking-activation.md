# POS Dish Mapping & Authoritative Tracking Activation (S5-DATA-07)

This document specifies the operational and administrative procedures for managing POS dish mappings and authoritative venue tracking activation under **S5-DATA-07: Controlled Pilot Order-Outcome Import**.

---

## 1. POS Dish Mapping Administrative Workflow

During the pilot phase, POS mappings are managed strictly through an authorized administrative workflow. In accordance with product requirements, no public or owner/editor UI or API endpoint is exposed for mapping management.

### Purpose
Restaurant POS export CSVs identify items by restaurant POS item codes (e.g., `POS-BURGER-101`, `POS-PIZZA-MARG`). PeekaPlate requires explicit, reviewed mappings to canonical PeekaPlate `dish_id` UUIDs before order lines can be resolved and accepted into `app_private.order_outcome_lines`.

### Required Permissions
- Modifying or approving a POS dish mapping requires an authorized staff member holding `owner` or `editor` permission in `app_private.staff_membership` for that venue (`tenant_id`).
- Staff holding `viewer` role or external actors cannot approve mappings.

### Operational Safeguards
1. **Runtime Privilege Boundary (Discretionary Access Control)**:
   The application runtime role (`peekaplate_runtime`) is granted strictly `SELECT` on `app_private.pos_dish_mappings`. `INSERT` and `UPDATE` are prohibited at the PostgreSQL table privilege level for runtime callers, ensuring that runtime connections cannot insert or mutate mappings even if `app.actor_id` were manipulated.
2. **Forced Row Level Security (RLS)**: `app_private.pos_dish_mappings` enforces `FORCE ROW LEVEL SECURITY`, preventing cross-tenant leakage.
3. **Reviewer Provenance Enforcement (`SECURITY DEFINER` Trigger)**:
   The trigger `app_private.enforce_pos_dish_mapping_review` verifies:
   - Trusted session actor context (`app.actor_id`) is strictly required; missing, empty, or non-UUID actor context is rejected.
   - The session actor must hold `owner` or `editor` permission in `app_private.staff_membership` for that `tenant_id`. Viewers and external callers cannot create or modify mappings.
   - When `review_status = 'approved'`, `reviewed_by` and `reviewed_at` must be non-null, and `reviewed_by` **must strictly match** the authenticated session actor (`session_actor::uuid`). Impersonation of another reviewer is blocked.
   - Unapproved (`pending` or `rejected`) mappings are forbidden from carrying reviewer credentials.
   - Modifying `dish_id` or `pos_item_code` on an approved mapping invalidates approval unless a fresh review timestamp and authorized reviewer are provided, preventing silent mutations.
4. **Ingestion Enforcement**:
   The ingestion engine queries `app_private.pos_dish_mappings` and strictly requires `review_status = 'approved'`. Unmapped items quarantine with `missing_pos_mapping`; pending or rejected mappings quarantine with `unreviewed_pos_mapping`.

### Administrative Procedure (SQL / Migration / Script)

To register and approve a mapping for Venue `<venue_id>`:

```sql
BEGIN;

-- Step 1: Set transaction-local tenant context and authenticated staff actor context
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-4000-8000-000000000001', true); -- Must be owner or editor

-- Step 2: Insert or update approved mapping (reviewed_by must match app.actor_id)
INSERT INTO app_private.pos_dish_mappings (
  tenant_id,
  pos_item_code,
  dish_id,
  dish_name,
  review_status,
  reviewed_by,
  reviewed_at
) VALUES (
  '00000000-0000-4000-8000-000000000801',
  'POS-PIZZA-MARG',
  '22222222-2222-4000-8000-000000000001',
  'Margherita Pizza',
  'approved',
  '00000000-0000-4000-8000-000000000001', -- Matches authenticated session actor
  now()
)
ON CONFLICT (tenant_id, pos_item_code) DO UPDATE
SET dish_id = EXCLUDED.dish_id,
    dish_name = EXCLUDED.dish_name,
    review_status = EXCLUDED.review_status,
    reviewed_by = EXCLUDED.reviewed_by,
    reviewed_at = EXCLUDED.reviewed_at;

COMMIT;
```

### PostgreSQL Execution Role & Privilege Boundary
- **Role Distinction**: The administrative script must be executed by an authorized database administrator role (e.g., `postgres`, deployment runner, or dedicated administrative role).
- **Runtime Privilege Isolation**: The application runtime role (`peekaplate_runtime`) has only `SELECT` privileges on `app_private.pos_dish_mappings`. It has no `INSERT` or `UPDATE` privileges, ensuring runtime callers cannot reach administrative mapping write paths.
- **Trigger-Enforced Authorization**: Even under administrative execution, the trigger `app_private.enforce_pos_dish_mapping_review()` mandates a valid `app.actor_id` UUID holding `owner` or `editor` status in `app_private.staff_membership` for that `tenant_id`, guaranteeing auditable provenance.

---

## 2. Server-Controlled Venue Tracking Activation

### Purpose
To prevent historical backdating or false correlation between historical order exports and live tracking, an explicit, server-controlled activation timestamp is required.

### Mechanics & Constraints
1. **Server-Controlled Timestamp**:
   - Activation is recorded in `app_private.venue_tracking_activations`.
   - The timestamp is generated by the server (`now()`).
   - The lifecycle trigger `app_private.enforce_venue_tracking_activation()` enforces that `activated_at` cannot deviate from server time by more than 5 seconds, rejecting any client-supplied, future, or backdated timestamps.
   - Updates and deletes on `app_private.venue_tracking_activations` are prohibited.
2. **Activation Point**:
   - Live tracking is automatically recorded upon live menu publication (`publishMenu` in `backend/src/publication-command.ts`).
   - Authorized administrative activation can also be executed via `recordVenueTrackingActivation(client, actorId, venueId, 'administrative')`.
3. **No Inference from Observations**:
   - Tracking activation is **never** inferred from `observation_index` or the arrival of observations.
   - Observations arriving after activation do not mutate or overwrite the activation timestamp.
4. **Fail-Closed on Missing Evidence**:
   - If a venue has no recorded tracking activation, `trackingStartedAt` is `undefined`, and all ingested order rows fail closed into `order_outcome_quarantine` with reason `missing_tracking_start_evidence`.
   - Orders timestamped prior to activation quarantine with reason `before_tracking_start`.

### Administrative Activation Procedure (Pre-existing Venues)

For venues that published live menus prior to this migration:
- PeekaPlate intentionally **does not invent** synthetic retroactive timestamps.
- Without an activation record, order outcome imports fail closed into quarantine with `missing_tracking_start_evidence`.
- To establish tracking activation for a pre-existing venue, an authorized administrator executes:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000801', true);
SELECT set_config('app.actor_id', '00000000-0000-4000-8000-000000000001', true);

INSERT INTO app_private.venue_tracking_activations (
  tenant_id,
  activated_at,
  activated_by,
  source
) VALUES (
  '00000000-0000-4000-8000-000000000801',
  now(),
  '00000000-0000-4000-8000-000000000001',
  'administrative'
) ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
```

---

## 3. Strict Decoupling of Eligibility and Visit Matching

- **Order Eligibility**:
  The tracking activation timestamp and historical window (default 90 days) establish whether an order outcome line is eligible for evaluation and acceptance into `app_private.order_outcome_lines`.
- **Visit Matching Boundary**:
  Eligibility **does not** imply an order-to-visit match.
  - `order_outcome_lines` contains only order outcome facts (`order_id`, `order_line_id`, `batch_id`, `ordered_at`, `menu_revision_id`, `dish_id`, `dish_revision_id`, `outcome_type`, `quantity`, `unit_price`, `currency`, `payload_checksum`).
  - No synthetic visit IDs, session IDs, or observation links are created.
  - Orders without matching observation evidence remain explicitly unlinked.
  - No causal claims, conversion metrics, or owner reports consume these tables until metric and matching contracts are formally reviewed and approved.
