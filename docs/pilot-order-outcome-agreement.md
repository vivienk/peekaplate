# PeekaPlate Pilot Order-Outcome Data Agreement (`S6-DATA-14.1`)

**Version:** `v0.1 — Draft`  
**Status:** Drafted (Pending Product Review/Approval by Vivien and Security Review/Approval by Sai)  
**Effective Date:** `[PENDING APPROVAL — NOT EFFECTIVE]`  
**Pilot Lead / Owner:** Teeyansh  
**Jurisdiction / Pilot Region:** San Francisco Bay Area, California (starting jurisdiction)

> **Important Notice — Not Legal Advice:** This document is a short operational pilot agreement and data-processing terms draft for PeekaPlate's P0 pilot. It is **not** legal advice and is **not** a standalone general privacy policy. PeekaPlate makes no legal determination herein regarding statutory applicability; applicability and final wording must be confirmed by Security (Sai) and/or qualified outside counsel before any real pilot owner uploads a file.

> **Mandatory Pre-Pilot Gate:** The pilot must **not** start and **no real pilot owner may upload a file** until **all** of the following are complete:
> 1. **S6-DATA-14.1** (this agreement) is reviewed and approved by Vivien (Product) and Sai (Security), and pending privacy/operator decisions are resolved.
> 2. **S6-DATA-14.2** (delete one owner's order data on request) is verified in staging (including backup/restore reconciliation procedure).
> 3. Server-side agreement acceptance enforcement is deployed and verified in staging (`POST /venues/:venueId/orders/agreement-acceptance` + `POST /venues/:venueId/orders/import`).
>
> Synthetic and staging test data remain permitted.

---

## Part 1: Pilot Order-Outcome Data Agreement

### 1. Parties

- **PeekaPlate ("Provider"):** `[PeekaPlate Legal Entity Name]`, `[Business Address Placeholder]`
- **Pilot Restaurant Owner ("Owner"):** `[Restaurant / Venue Legal Name]`, Venue ID `[venue_id]`, represented by `[Authorized Pilot Owner Name & Title]`, `[Owner Contact Email]`

### 2. What the Owner Is Agreeing To

By signing or accepting this agreement, the Owner agrees to participate in PeekaPlate's controlled P0 order-outcome CSV import pilot (`pilot_order_outcome.v1`) under the terms below. The Owner confirms that they are an authorized pilot operator (`owner` role for the venue) and have authority to share the venue's non-personal order-outcome records with PeekaPlate for the pilot.

### 3. Pilot Scope & Exclusions

This agreement covers **only**:
- Owner-uploaded order-outcome CSV files formatted to `pilot_order_outcome.v1`
- Authorized pilot operators for the designated venue

This agreement **explicitly excludes**:
- POS connectors or automated POS integrations
- Diner personal data in the uploaded CSV file
- Diner behavioral data (governed separately; see Section 11 only for owner-requested behavioral deletion)
- Using imported order outcomes as proof of causation
- Displaying imported order outcomes in owner reports before the matching and metric contract is approved

### 4. What Data May Be Uploaded

The Owner may upload only CSV files conforming to the `pilot_order_outcome.v1` schema (up to 5 MiB and 1,000 data rows per batch) containing **only** the approved columns:
- Required base columns: `schema_version`, `order_id`, `order_line_id`, `ordered_at`, `outcome_type`, `quantity`
- Item identification columns: `pos_item_id` or `pos_item_code` (for reviewed POS dish mapping), or canonical `menu_revision_id`, `dish_id`, `dish_revision_id` (and optional `dish_name`)
- Optional pricing pair: `unit_price` and `currency` (both present or both omitted)

Extra or unapproved columns are **not accepted** and are rejected at upload/parse time.

### 5. Prohibited Data

The Owner **must not** upload any diner personal data in the CSV file, including but not limited to:
- Customer names, email addresses, phone numbers, or physical addresses
- Payment card numbers, loyalty IDs, or account identifiers
- Free-text customer notes or unapproved columns

PeekaPlate's parser rejects `@` characters and 10+ consecutive digits in `order_id` and `order_line_id` as an additional technical safeguard, but the Owner remains responsible for ensuring no personal data is included in any uploaded file.

### 6. 90-Day Import Eligibility Window (Decision 1)

- Orders with an `ordered_at` timestamp **older than 90 days** at the time of import are **not imported** into accepted order rows.
- Older rows are quarantined with reason `too_old` (and rows timestamped before the venue's recorded tracking activation are quarantined as `before_tracking_start` or `missing_tracking_start_evidence`).
- This 90-day import window is an interim P0 policy and will be reviewed after owner testing.

### 7. Original CSV Retention — No Automatic Expiry for P0 (Decision 2)

- For P0, the **original uploaded CSV file** is retained with **no automatic expiry** (automated raw-CSV purging is disabled).
- **Important distinction:** Retaining the original CSV without automatic expiry **does not** change the 90-day import eligibility window in Section 6; orders older than 90 days at import time are still quarantined and not imported.
- Reason for retention: supports re-processing after fixes, long-term analytics such as year-over-year comparison, and the planned P1 order conversion metric.
- This retention policy will be reviewed after owner testing.

### 8. What Data PeekaPlate Retains & Access Restrictions

For each uploaded batch, PeekaPlate retains in private, tenant-isolated storage and database tables:
- The original uploaded CSV (`order-imports/<tenant_id>/<batch_id>/source.csv` in private object storage)
- Derived batch metadata, accepted order-outcome rows, quarantined row diagnostics, and checksum conflict records in private tenant-scoped tables (`app_private.order_outcome_*`)

**Access Restrictions:** Access to the uploaded CSV and derived order-outcome records is limited strictly to **authorized pilot operators and PeekaPlate personnel** who need access to carry out the limited pilot purposes in Section 9.

### 9. Limited Purposes

PeekaPlate may use the retained original CSV and derived order-outcome rows **only** for:
1. **Re-processing after fixes**
2. **Owner reporting** (subject to Section 10)
3. **The P1 order conversion metric**, **only after its matching and metric contract is approved**

PeekaPlate will **not** use the uploaded CSV or derived order rows for marketing, advertising, model training, unrelated analytics, sale or rental of data, or general product development.

### 10. Reporting Limitation & No Causal Inference Claim

- **Reporting limitation:** Imported order outcomes will **not** be displayed in owner reports until the matching and metric contract is formally reviewed and approved.
- **No causal inference claim:** Imported order outcomes are **not** proof of causation. PeekaPlate does not claim that viewing a menu or dish caused an order, and does not guarantee any sales lift. Accepted order rows remain unlinked by default unless explicit matching evidence is established.

### 11. Deletion Requests (Order Data & Behavioral Data)

#### A. Owner Order Data Deletion (`S6-DATA-14.2`)
- An Owner may request deletion of their restaurant's order data (covering the original uploaded CSV in private R2 storage and derived order-outcome batches, accepted lines, quarantined rows, and conflict records in PostgreSQL).
- Deletion requests are auditable via `app_private.order_data_deletion_requests` (recording only request ID, tenant ID, requester actor ID, status, row/object counts, and timestamps — never deleted order contents or diner data) and executed through `POST /venues/:venueId/orders/deletion-requests`.
- **Backup & Release-Gate Notice:** Automated application deletion covers live R2 objects and live PostgreSQL tables. Database backups/PITR snapshots are managed by the database provider outside application control (see Part 4 for backup/restore limitations). **This agreement is a draft and cannot authorize real pilot uploads** until staging verification, backup-restore reconciliation, and Product/Security approvals are complete.

#### B. Owner-Scoped Diner Behavioral Data Deletion (`S5-DATA-09` / Decision 3 Clarification)
- This agreement does not redefine diner behavioral-event retention.
- However, on a restaurant owner's request, PeekaPlate can delete that restaurant's stored diner behavioral events **by restaurant or time window** (supporting either full restaurant-level deletion of stored diner behavioral events or deletion scoped to a requested time window).
- Stored owner-scoped behavioral data deletion is handled **manually under `S5-DATA-09`** (separate from order-file deletion under `S6-DATA-14.2`; no automated `S5-DATA-09` workflow exists in the repository).
- **No per-diner deletion:** Individual diner visits are anonymous and cannot be identified after the visit, so PeekaPlate cannot offer per-diner deletion. Diner consent withdrawal stops future collection only.

### 12. Acceptance / Signature

> **Note:** This document is a draft (`v0.1 — Draft`) and **cannot authorize real pilot uploads**. Electronic acceptance is recorded server-side via `POST /venues/:venueId/orders/agreement-acceptance` (`app_private.pilot_order_agreement_acceptances`); final signing mechanism and authorized signatory remain pending decision (see Part 3.F).

| Role | Details |
| :--- | :--- |
| **Authorized Pilot Owner** | Name: `________________________` Title: `________________` |
| **Restaurant / Venue** | Name: `________________________` Venue ID: `________________` |
| **Owner Signature & Date** | Signature: `____________________` Date: `________________` |
| **PeekaPlate Representative** | Name: `________________________` Title: `________________` |
| **PeekaPlate Signature & Date** | Signature: `____________________` Date: `________________` |

---

## Part 2: Owner-Facing Upload Step Wording

The following short notice is designed for the Console order-CSV upload step (aligning with `S4-DES-03` when implemented; no existing `S4-DES-03` copy was found in the repository):

> **Pilot Order CSV Upload Notice (`pilot_order_outcome.v1`)**
>
> - **Authorized operators only:** Upload is available only to authorized pilot operators for this restaurant who have accepted the **PeekaPlate Pilot Order-Outcome Data Agreement (`S6-DATA-14.1`)**. *(Checkbox / Gate: "I confirm I am an authorized pilot operator and have accepted the Pilot Order-Outcome Data Agreement.")*
> - **No diner personal data:** Do **not** include customer names, emails, phone numbers, addresses, payment details, loyalty IDs, or extra columns. Only approved `pilot_order_outcome.v1` columns are accepted.
> - **90-day import window:** Orders older than 90 days (based on `ordered_at` at upload time) are not imported and will be quarantined.
> - **Retention & purposes:** For P0, your original uploaded CSV is retained without automatic expiry solely for re-processing after fixes, owner reporting (once metric contracts are approved), and the P1 order conversion metric.
> - **Deletion requests:** You may request deletion of your restaurant's order data under `S6-DATA-14.2` (and separately request manual deletion of your restaurant's stored anonymous diner behavioral events under `S5-DATA-09`; per-diner deletion is not possible because individual visits are anonymous).
> - **Reference:** `[Link to PeekaPlate Pilot Order-Outcome Data Agreement v0.1]`

---

## Part 3: Implementation Alignment, California Privacy Review & Blockers

### A. Alignment Verified Against PR #120 (`S5-DATA-07`)

Verified directly in the repository:
- **Schema & extra-column enforcement** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts)): `parseOrderOutcomeCsv` rejects any column outside `ALL_ALLOWED_CSV_HEADERS` with `unexpected_header`. `OrderTokenIdentifierSchema` rejects `@` and 10+ consecutive digits in `order_id` and `order_line_id`.
- **90-day import window** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts), [service.ts](../backend/src/order-ingestion/service.ts)): `DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS = 90` anchored on `ordered_at`; older rows quarantine as `too_old`.
- **No automatic expiry for P0** ([service.ts](../backend/src/order-ingestion/service.ts), [index.ts](../backend/src/index.ts)): `DEFAULT_RETENTION_CONFIG.enableRawCsvPurge` is `false`, and `handleScheduled` does not pass `enableRawCsvPurge: true`.

### B. Signing / Acceptance Enforcement Status

- **Server-Side Acceptance Gate (Implemented):**
  - `app_private.pilot_order_agreement_acceptances` ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)) stores tenant-scoped, append-only acceptance records `(tenant_id, agreement_version, accepted_by, accepted_at)` with `FORCE ROW LEVEL SECURITY` and a `SECURITY DEFINER` trigger verifying `app.tenant_id`, `app.actor_id`, and `owner` membership in `app_private.staff_membership`.
  - `POST /venues/:venueId/orders/agreement-acceptance` ([index.ts](../backend/src/index.ts), `acceptPilotOrderAgreement` in [service.ts](../backend/src/order-ingestion/service.ts)) records idempotent owner acceptance for `PILOT_ORDER_AGREEMENT_VERSION` (`v0.1`).
  - `importOrderOutcomes` ([service.ts](../backend/src/order-ingestion/service.ts)) checks `app_private.pilot_order_agreement_acceptances` inside the authorized tenant transaction and fails closed with `403 agreement_not_accepted` if missing or if the required version has changed. Acceptance for one venue never authorizes another venue.
- **Upload UI Status:** No order-CSV upload UI exists in `frontend/console/src/` yet. Do **not** expose an upload flow as ready for real owners until staging verification and backup-restore reconciliation are complete. When built (aligning with `S4-DES-03`), the Part 2 wording must integrate into the Console upload screen and call `POST /venues/:venueId/orders/agreement-acceptance` (a UI checkbox alone is never sufficient).

### C. S6-DATA-14.2 & S5-DATA-09 Status

- **S6-DATA-14.2 Status (Implemented in Backend/Migration; Staging & Backup Gates Remaining):**
  - `POST /venues/:venueId/orders/deletion-requests` ([index.ts](../backend/src/index.ts), `submitOrderDataDeletionRequest` in [service.ts](../backend/src/order-ingestion/service.ts)) records an owner's deletion request (`status = 'requested'`, HTTP `202`) using a bounded reason enum (`pilot_withdrawal`, `data_cleanup`, `retention_policy_request` — no free text; `account_closure` remains excluded until the pending account-closure decision is approved) and immediately blocks new imports for that venue (`409 deletion_in_progress`).
  - An authorized internal operator executes `deleteVenueOrderData` ([service.ts](../backend/src/order-ingestion/service.ts)) with an explicit non-empty `authorizedOperatorIds` allowlist, writes an immutable `in_progress` intent to the external R2 deletion ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json`) before any destructive operation, deletes R2 source CSVs (`order-imports/<venueId>/...`) and PostgreSQL order-outcome tables (`order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, `order_outcome_import_batches`) via the privileged `app_private.delete_venue_order_data(p_tenant_id, p_request_id, p_operator_id, p_execution_token)` `SECURITY DEFINER` function ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)), preserves `pos_dish_mappings` and `venue_tracking_activations`, and writes a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json`.
  - Direct `DELETE`, `UPDATE`, and `TRUNCATE` on `order_outcome_*` tables remain rejected by append-only triggers (which also reject GUC spoofing by `peekaplate_runtime`), and `peekaplate_runtime` has no `DELETE` or `EXECUTE` privilege on `delete_venue_order_data`.
  - **Remaining Operational Gates:** Confirmed **Manual deletion operator** (`Sai` proposed, pending confirmation), confirmed **Independent checker** (`Jeffin` proposed, pending confirmation), staging migration/R2 end-to-end verification with real staging credentials, and post-restore backup reconciliation verification (see Part 4).
- **S5-DATA-09 Status:** Separate manual behavioral-event deletion workflow; out of scope for `S6-DATA-14.2`.

### D. California Privacy-Law Review Note (For Sai / Security & Outside Counsel)

Because the pilot is in the **San Francisco Bay Area, California**, two California privacy statutes are being evaluated as a starting point. **This note does not conclude that PeekaPlate is subject to either law.**

1. **CCPA / CPRA (Cal. Civ. Code § 1798.100 et seq.):**
   - *Why considered:* Applies to for-profit businesses doing business in California that meet at least one statutory applicability threshold (based on prior-year gross revenue, volume of California consumers' or households' personal information bought/sold/shared, or percentage of revenue derived from selling/sharing personal information, plus certain common-branding/joint-venture rules, as verified by counsel).
2. **CalOPPA (Cal. Bus. & Prof. Code §§ 22575–22579):**
   - *Why considered:* Applies broadly (without revenue/volume thresholds) to operators of commercial websites or online services that collect personally identifiable information (PII) from California residents, requiring a conspicuously posted privacy policy with specific disclosures (categories of PII/third-party sharing, review/change process if any, material change notice, effective date, and Do Not Track / third-party tracking disclosures).
3. **Open Factual/Legal Questions for Sai & Outside Counsel:**
   - What is PeekaPlate's legal entity status (for-profit vs. pre-incorporation/other) and do any CCPA/CPRA statutory thresholds or affiliate rules apply?
   - Does any data collected in the pilot (e.g., owner account/auth emails, staff records, or diner telemetry) constitute "personal information" or "PII" triggering CalOPPA privacy-policy posting requirements?
   - For order-outcome CSVs (which strictly prohibit diner PII), does PeekaPlate act as a B2B service provider or business, and is any contractual/privacy wording needed beyond this pilot agreement?
4. **Controls vs. Legal Applicability:** PeekaPlate's internal privacy/security controls (prohibiting diner PII in CSVs, strict header/token validation, tenant RLS, private R2 storage) are enforced regardless of whether statutory thresholds are met.

### E. Approval Tracking & Reviewer Checklist

| Reviewer | Domain | Drafted | Reviewed | Approved |
| :--- | :--- | :--- | :--- | :--- |
| **Vivien** | Product | Yes (`v0.1`) | Pending | Pending |
| **Sai** | Security | Yes (`v0.1`) | Pending | Pending |

**Reviewer Checklist:**
- **Vivien (Product):**
  - [ ] Confirm pilot scope & exclusions (CSV-only, no POS connectors, no causal claims, no reporting before metric contract approval)
  - [ ] Confirm 90-day import window (`ordered_at`) vs. no-automatic-expiry P0 retention of original CSV
  - [ ] Confirm limited purposes (re-processing after fixes, owner reporting, P1 order conversion metric)
  - [ ] Approve owner-facing upload notice wording (Part 2)
- **Sai (Security):**
  - [ ] Confirm data-content & PII prohibition controls (schema allowlist, identifier checks, tenant RLS, private R2 isolation, operator-only access)
  - [ ] Confirm server-side agreement acceptance enforcement design (Part 3.B) and `S6-DATA-14.2` deletion-on-request dependency (Part 3.C)
  - [ ] Confirm behavioral deletion distinction (`S5-DATA-09`, no per-diner deletion)
  - [ ] Confirm California privacy review (CCPA/CPRA & CalOPPA applicability questions in Part 3.D) and whether outside-counsel sign-off is required before real owner uploads

### F. Governance & Pending Decisions (Do Not Resolve Without Stakeholder Sign-Off)

Confirmed governance assignments are separated below from proposed assignments and open policy decisions:

| Item | Status | Owner / Notes |
| :--- | :--- | :--- |
| **Post-owner-testing retention review owner** | **Confirmed** | **Adam** |
| **Privacy approver** | **Confirmed for P0** | **None for P0**; revisit before real diner data |
| **Manual deletion operator** | **Proposed (Pending confirmation)** | **Sai (proposed)** — subject to confirmation; handles off-API / escalated owner deletion requests and executes `deleteVenueOrderData` |
| **Independent deletion checker** | **Proposed (Pending confirmation)** | **Jeffin (proposed)** — subject to confirmation; independently verifies deletion results (must remain a different person from the operator and must not be added to `authorizedOperatorIds`) |
| **Deletion SLA** | **Proposed / Pending** | Proposal awaiting Vivien and Sai confirmation (not approved policy) |
| **Account closure deletion trigger** | **Pending** | Proposal awaiting Vivien and Sai confirmation (not approved policy; `account_closure` remains excluded from `OrderDataDeletionReasonSchema`) |
| **Final signing mechanism & authorized signatory** | **Pending** | Decide whether electronic acceptance via `POST /venues/:venueId/orders/agreement-acceptance` is paired with a signed PDF/doc and who signs for PeekaPlate |
| **Applicable privacy obligations (CCPA/CPRA & CalOPPA)** | **Pending** | Security (Sai) and/or qualified outside counsel confirmation required |

### G. Version & Change History

| Version | Date | Author | Summary |
| :--- | :--- | :--- | :--- |
| `v0.1 — Draft` | 2026-11-13 | Teeyansh | Initial draft of S6-DATA-14.1 pilot agreement, matching upload wording, PR #120 alignment check, server-side acceptance gate (`pilot_order_agreement_acceptances`), S6-DATA-14.2 deletion workflow (`delete_venue_order_data`), pending decisions table, and operational runbook. |

---

## Part 4: Operational Runbook — Owner-Scoped Order-Data Deletion (`S6-DATA-14.2`)

1. **Submitting a Deletion Request:**
   - An authenticated venue owner submits `POST /venues/:venueId/orders/deletion-requests` with `{ "requestId": "<uuid>", "reason": "pilot_withdrawal" | "data_cleanup" | "retention_policy_request" }` (no free-text reason accepted; `account_closure` is excluded until Part 3.F is approved).
   - The endpoint immediately persists `status = 'requested'` (HTTP `202`) in `app_private.order_data_deletion_requests` and blocks any new `importOrderOutcomes` for that venue (`409 deletion_in_progress`).
   - Off-platform owner requests (e.g., email/support) must be routed to the **Manual deletion operator** (*Sai (proposed), pending confirmation*); no automated support-inbox integration exists.
2. **Identity & Venue Ownership Verification:**
   - The API verifies the caller's Supabase JWT (`services.verify`) and checks `app_private.staff_membership` (`permission = 'owner'`) for `venueId` inside a `SET LOCAL` transaction.
   - `enforce_order_data_deletion_request_insert()` trigger in PostgreSQL independently enforces `app.tenant_id`, `app.actor_id`, `owner` membership, and initial `status = 'requested'`.
3. **Authorized Operator Execution & Allowlist Enforcement:**
   - Execution is **not** exposed as a self-serve HTTP endpoint. Only an authorized internal operator (`operatorId`) runs `deleteVenueOrderData` with a server-controlled `authorizedOperatorIds` allowlist (`ReadonlySet<string>`).
   - `deleteVenueOrderData` fails closed with `403 forbidden` unless `authorizedOperatorIds` is non-empty, `operatorId` is a canonical UUID, and `authorizedOperatorIds.has(operatorId)`. It also requires an existing owner-submitted request (`404 deletion_request_not_found` otherwise).
   - **Allowlist & Identity Blocker:** No personal operator UUIDs are hardcoded in the repository, and no production/staging operator identities are provisioned yet. Sai is proposed as the **Manual deletion operator** (pending confirmation); before real pilot uploads are enabled, the confirmed operator's authenticated UUID must be provisioned in the server-controlled `authorizedOperatorIds` configuration. If the allowlist is empty or unprovisioned, deletion execution remains blocked.
   - **Separation from Independent Checker:** Jeffin is proposed as the **Independent checker** (subject to confirmation). Do **not** add the checker to `authorizedOperatorIds` merely because they verify deletion results, and do **not** treat the checker as an authorized deletion operator unless separately authorized.
4. **Exact Storage & Database Deletion Steps:**
   - *Phase 1 (Audit & Fenced Lease):* Acquire `pg_advisory_xact_lock('order_lifecycle:' || venueId)`, lock the `app_private.order_data_deletion_requests` row `FOR UPDATE`, return immediately if already `completed`, reject concurrent executions with `409 deletion_in_progress` if an active `'executing'` lease (`execution_lease_expires_at > now()`) is held, otherwise claim `status = 'executing'` with a fresh `execution_token` (`uuid`), `execution_started_at`, and `execution_lease_expires_at` (5-minute default lease) and collect `storage_key`s from `app_private.order_outcome_import_batches`. This works identically over both direct `pg.Client` sessions and Hyperdrive transaction-mode pooling without session-level locks.
   - *Phase 1b (Durable External Intent):* Write `order-deletion-ledger/<venueId>/<requestId>/intent.json` with `{ requestId, venueId, operatorId, status: "in_progress", intentRecordedAt }` to R2 **before** any destructive operation using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`, so retries never overwrite the original intent; fails closed with `502 deletion_storage_failed` if the intent cannot be persisted).
   - *Phase 2 (R2 Storage & Heartbeat Fencing):* List all objects under `order-imports/<venueId>/` in private R2 storage, union with DB `storage_key`s strictly matching that prefix, and delete each object while renewing `execution_lease_expires_at` conditionally (`WHERE execution_token = $token AND status = 'executing'`). If the lease was lost to a replacement worker, execution aborts immediately with `409 deletion_lease_lost`.
   - *Phase 3 (Fenced PostgreSQL Deletion):* Verify `status = 'executing'` and `execution_token` still match, call `app_private.delete_venue_order_data(venueId, requestId, operatorId, executionToken)` (`SECURITY DEFINER`, owned by privileged role, `EXECUTE` revoked from `PUBLIC` and `peekaplate_runtime`) which re-verifies `execution_token` inside PostgreSQL, enables transaction-local deletion inside a `BEGIN ... EXCEPTION WHEN OTHERS` block that always resets `app.order_data_deletion_active = 'off'`, and deletes `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, and `order_outcome_import_batches` for `venueId`, then marks `order_data_deletion_requests.status = 'completed'` with `executed_by = operatorId`, clears `execution_token`/`execution_lease_expires_at`, and records exact counts and `completed_at`.
   - *Phase 4 (R2 Deletion Ledger Completion):* Write a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json` with `operatorId`, exact counts, and `completedAt` using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`). Even if the process crashes between Phase 3 DB commit and Phase 4, `intent.json` from Phase 1b is already durable in R2 and `completed.json` is written on retry.
   - *Preserved non-order tables:* `pos_dish_mappings` (venue menu-to-POS configuration) and `venue_tracking_activations` (server-controlled activation timestamp) are intentionally preserved. No derived order-outcome reports, exports, or caches exist.
5. **Two-Person Deletion Verification Procedure:**
   Every executed order-data deletion requires two distinct people:
   - **Operator** (*Sai (proposed), pending confirmation*):
     1. Receives and validates the owner deletion request (`app_private.order_data_deletion_requests` row or escalated owner request).
     2. Confirms restaurant/venue identity (`venueId`) and deletion scope (all order-outcome R2 objects and derived order-outcome DB rows for that venue).
     3. Executes the authorized deletion via `deleteVenueOrderData` using an operator identity included in the server-controlled `authorizedOperatorIds` allowlist.
     4. Records the deletion outcome and audit details (`requestId`, `venueId`, `operatorId`, object/row counts, `completedAt`, and R2 ledger keys).
   - **Independent Checker** (*Jeffin (proposed), subject to confirmation*):
     1. Must be a **different person** from the operator who executed the deletion (and must **not** be added to `authorizedOperatorIds` solely to perform verification).
     2. Independently verifies that the requested restaurant's original CSV objects under `order-imports/<venueId>/` in R2 are removed (zero remaining objects).
     3. Independently verifies that the requested restaurant's derived order data (`order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`) is removed (`0` rows for `venueId`).
     4. Confirms other restaurants' data remains untouched (and `pos_dish_mappings` / `venue_tracking_activations` are preserved as expected).
     5. Verifies the deletion audit entry in `app_private.order_data_deletion_requests` (`status = 'completed'`, matching `executed_by`, counts, and `completed_at`) and the R2 ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json` and `completed.json`).
     6. Records the independent verification outcome (checker identity, timestamp, `requestId`, `venueId`, pass/fail status, and any findings).
6. **Retry, Partial Deletion & Failed Verification Handling:**
   - *Partial deletion — R2 failure:* If any R2 `list` or `delete` fails, the request is marked `status = 'failed'` (`error_code = 'r2_delete_failed'`) and returns `502 deletion_storage_failed`. PostgreSQL batch rows (`storage_key`s) are **not** deleted so retries still have all `storage_key`s.
   - *Partial deletion — DB failure:* If Phase 3 DB deletion fails, the DB transaction rolls back, the request is marked `status = 'failed'` (`error_code = 'db_delete_failed'`), and `deleteVenueOrderData` returns `500 deletion_db_failed`.
   - *Lease loss / concurrent worker:* If heartbeat renewal or the Phase 3 fence check detects that `execution_token` was superseded, execution aborts with `409 deletion_lease_lost` before Phase 3 DB mutations.
   - *Safe retry:* Retrying `deleteVenueOrderData` with the same `requestId` is idempotent: if `status = 'completed'` (including recovery from a crash between Phase 3 DB commit and Phase 4 `completed.json` write), it ensures `completed.json` exists via create-only write and returns `alreadyCompleted: true` with recorded counts.
   - *Failed independent verification:* If the independent checker finds remaining objects under `order-imports/<venueId>/`, remaining `order_outcome_*` rows for `venueId`, missing/mismatched audit or ledger records, or any cross-venue impact, the verification **fails**. Do **not** mark the deletion complete or re-enable uploads for the venue; escalate immediately, keep the venue blocked (`409 deletion_in_progress`), investigate and remediate (e.g., retry with the same `requestId` or apply a forward corrective fix), and repeat the full independent verification before closing the request.
7. **Audit Evidence Retained:**
   - `app_private.order_data_deletion_requests` and `order-deletion-ledger/<venueId>/<requestId>/intent.json` + `order-deletion-ledger/<venueId>/<requestId>/completed.json` retain `requestId`, `venueId`, `requested_by`, `executed_by` (`operatorId`), bounded `reason` enum, `status`, object/row counts, `error_code`, `requested_at`, and `completed_at`. Completed DB records are immutable via trigger. **Zero** CSV contents, order lines, or diner data are retained.
8. **Backup / Restore Handling & Limitations (Release Blocker):**
   - Managed PostgreSQL/Supabase PITR snapshots and R2 backups are outside application runtime control and **cannot** be selectively edited per tenant by this service.
   - **Limitation / Blocker:** If a PostgreSQL backup is restored to an earlier point in time, deleted `order_outcome_*` rows (and even the `completed` audit row if created after the snapshot) could be reintroduced. Because the R2 deletion ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json` and `order-deletion-ledger/<venueId>/<requestId>/completed.json`) lives outside PostgreSQL, post-restore operators must list `order-deletion-ledger/` in R2 and replay `app_private.delete_venue_order_data` for every venue deleted after the backup timestamp before re-enabling traffic. Managed backup retention windows and restore drill sign-off remain *Pending*.
9. **Communicating Completion to the Owner:**
   - API callers receive HTTP `202` (`status: "requested"`) upon request submission. Manual operator completion notification templates/channels and SLA remain *Pending* until the operator assignment and SLA are confirmed.
10. **Excluded Scope (`S5-DATA-09`):**
    - Diner behavioral events are **not** deleted by this workflow; they belong to `S5-DATA-09` (manual owner-scoped deletion on request, by restaurant or time window; no per-diner deletion).
11. **Pre-Pilot Staging Verification Checklist:**
    - [x] Verify migration `20261113120000_pilot_order_agreement_and_deletion.sql` and integration tests against real local PostgreSQL.
    - [ ] Apply migration `20261113120000_pilot_order_agreement_and_deletion.sql` in staging (`staging` credentials not present in local workspace) and run `pnpm test:db`.
    - [ ] Verify against staging R2 (`peekaplate-staging-assets`) that `POST /venues/:venueId/orders/deletion-requests` + operator `deleteVenueOrderData` deletes synthetic staging R2 objects and DB rows, preserves other venues, and writes `order-deletion-ledger/<venueId>/<requestId>/intent.json` and `order-deletion-ledger/<venueId>/<requestId>/completed.json`.
    - [ ] Obtain Vivien (Product) and Sai (Security) approvals, confirm the Manual deletion operator (Sai, proposed) and Independent checker (Jeffin, proposed), provision the confirmed operator's ID in `authorizedOperatorIds`, and complete post-restore backup reconciliation drill.
