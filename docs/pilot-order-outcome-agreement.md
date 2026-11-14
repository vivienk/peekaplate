# PeekaPlate Pilot Order-Outcome Data Agreement (`S6-DATA-14.1`)

**Version:** `v0.1 — Draft`  
**Status:** Drafted (Pending Product Review/Approval by Vivien and Security Review/Approval by Sai)  
**Effective Date:** `[PENDING APPROVAL — NOT EFFECTIVE]`  
**Pilot Lead / Owner:** Teeyansh  
**Jurisdiction / Pilot Region:** San Francisco Bay Area, California (starting jurisdiction)

> **Important Notice — Not Legal Advice:** This document is a short operational pilot agreement and data-processing terms draft for PeekaPlate's P0 pilot. It is **not** legal advice and is **not** a standalone general privacy policy. PeekaPlate makes no legal determination herein regarding statutory applicability; applicability and final wording must be confirmed by Security (Sai) and/or qualified outside counsel before any real pilot owner uploads a file.

> **Mandatory Pre-Pilot Gate:** The pilot must **not** start and **no real pilot owner may upload a file** until **all** of the following are complete:
> 1. **S6-DATA-14.1** (this agreement) is reviewed and approved by Vivien (Product) and Sai (Security), and pending privacy/operator decisions are resolved.
> 2. **S6-DATA-14.2** (delete one owner's order data on request) is verified in staging (including two-person verification and backup/restore reconciliation procedure).
> 3. Server-side agreement acceptance enforcement is deployed and verified in staging (`POST /venues/:venueId/orders/agreement-acceptance` + `POST /venues/:venueId/orders/import`). Acceptance counts as enforced only once versioned acceptance is deployed and verified in staging. An open PR is not live enforcement.
>
> Synthetic and staging test data remain permitted.

> **Visibility Boundary:** Parts 1 and 2 are owner-facing. Parts 3 and 4 are internal governance, implementation, and operational material.

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

- For P0, the **original uploaded CSV file** is retained with **no automatic expiry** (approved 2026-11-11; `DEFAULT_RETENTION_CONFIG.enableRawCsvPurge = false`, and `handleScheduled` does not enable raw-CSV purging). This will be reviewed after owner testing.
- **Important distinction:** Retaining the original CSV without automatic expiry **does not** change the 90-day import eligibility window in Section 6; orders older than 90 days at import time are still quarantined and not imported.
- **Scope boundary:** This applies only to the order CSV. It does not apply to diner behavioral data, PostHog, R2 behavioral archives, or canonical behavioral facts (each governed separately).
- Reason for retention: supports re-processing after fixes, long-term analytics such as year-over-year comparison, and the planned P1 order conversion metric.

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
- **No per-diner deletion:** PeekaPlate keeps visit and event identifiers but does not link them to a named person, so it does not offer per-diner deletion. Deletion is by restaurant or time window and covers only the events PeekaPlate can locate by those identifiers. Diner consent withdrawal stops future collection only.

### 12. Acceptance / Signature

> **Note:** This document is a draft (`v0.1 — Draft`) and **cannot authorize real pilot uploads**. Electronic acceptance is recorded server-side via `POST /venues/:venueId/orders/agreement-acceptance` (`app_private.pilot_order_agreement_acceptances`); final signing mechanism and authorized signatory remain pending decision (see Part 3.F). Acceptance counts as enforced only once versioned acceptance is deployed and verified in staging. An open PR is not live enforcement.

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
> - **Deletion requests:** You may request deletion of your restaurant's order data under `S6-DATA-14.2` (and separately request manual deletion of your restaurant's stored diner behavioral events under `S5-DATA-09`; deletion covers the events we can locate by restaurant or time window, and per-diner deletion is not offered because we do not link visits to a named person).
> - **Reference:** `[Link to PeekaPlate Pilot Order-Outcome Data Agreement v0.1]`

---

## Part 3: Implementation Alignment, California Privacy Review & Blockers

**Internal, not owner-facing.**

> Parts 1 and 2 are owner-facing. Parts 3 and 4 are internal governance, implementation, and operational material.

### A. Alignment Verified Against PR #120 (`S5-DATA-07`)

Verified directly in the repository:
- **Schema & extra-column enforcement** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts)): `parseOrderOutcomeCsv` rejects any column outside `ALL_ALLOWED_CSV_HEADERS` with `unexpected_header`. `OrderTokenIdentifierSchema` rejects `@` and 10+ consecutive digits in `order_id` and `order_line_id`.
- **90-day import window** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts), [service.ts](../backend/src/order-ingestion/service.ts)): `DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS = 90` anchored on `ordered_at`; older rows quarantine as `too_old`.
- **No automatic expiry for P0** ([service.ts](../backend/src/order-ingestion/service.ts), [index.ts](../backend/src/index.ts)): `DEFAULT_RETENTION_CONFIG.enableRawCsvPurge` is `false`, and `handleScheduled` does not pass `enableRawCsvPurge: true`.

### B. Signing / Acceptance Enforcement Status

- **Server-Side Acceptance Gate (Implemented in Code; Not Yet Deployed/Verified in Staging):**
  - Acceptance counts as enforced only once versioned acceptance is deployed and verified in staging. An open PR is not live enforcement.
  - `app_private.pilot_order_agreement_acceptances` ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)) stores tenant-scoped, append-only acceptance records `(tenant_id, agreement_version, accepted_by, accepted_at)` with `FORCE ROW LEVEL SECURITY` and a `SECURITY DEFINER` trigger verifying `app.tenant_id`, `app.actor_id`, and `owner` membership in `app_private.staff_membership`.
  - `POST /venues/:venueId/orders/agreement-acceptance` ([index.ts](../backend/src/index.ts), `acceptPilotOrderAgreement` in [service.ts](../backend/src/order-ingestion/service.ts)) records idempotent owner acceptance for `PILOT_ORDER_AGREEMENT_VERSION` (`v0.1`).
  - `importOrderOutcomes` ([service.ts](../backend/src/order-ingestion/service.ts)) checks `app_private.pilot_order_agreement_acceptances` inside the authorized tenant transaction and fails closed with `403 agreement_not_accepted` if missing or if the required version has changed. Acceptance for one venue never authorizes another venue.
  - **Re-upload after verified deletion:** Agreement acceptance is preserved across verified deletion (`pilot_order_agreement_acceptances` is append-only per `(tenant_id, agreement_version)`). The same venue may import again after verified deletion without accepting again, unless the agreement version changes.
- **Upload UI Status:** No order-CSV upload UI exists in `frontend/console/src/` yet. Do **not** expose an upload flow as ready for real owners until staging verification and backup-restore reconciliation are complete. When built (aligning with `S4-DES-03`), the Part 2 wording must integrate into the Console upload screen and call `POST /venues/:venueId/orders/agreement-acceptance` (a UI checkbox alone is never sufficient).

### C. S6-DATA-14.2 & S5-DATA-09 Status

- **S6-DATA-14.2 Status (Implemented in Backend/Migrations; Staging & Backup Gates Remaining):**
  - `POST /venues/:venueId/orders/deletion-requests` ([index.ts](../backend/src/index.ts), `submitOrderDataDeletionRequest` in [service.ts](../backend/src/order-ingestion/service.ts)) records an owner's deletion request (`status = 'requested'`, HTTP `202`) using a bounded reason enum (`pilot_withdrawal`, `data_cleanup`, `retention_policy_request` — no free text; `account_closure` is not a supported reason: the 90-day account-closure cleanup is a manual procedure that is not built; see Part 3.F) and immediately blocks new imports for that venue (`409 deletion_in_progress`).
  - An authorized internal operator executes `deleteVenueOrderData` ([service.ts](../backend/src/order-ingestion/service.ts)) with an explicit non-empty `authorizedOperatorIds` allowlist, writes an immutable `in_progress` intent to the external R2 deletion ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json`) before any destructive operation, deletes R2 source CSVs (`order-imports/<venueId>/...`) and PostgreSQL order-outcome tables (`order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, `order_outcome_import_batches`) via the privileged `app_private.delete_venue_order_data(p_tenant_id, p_request_id, p_operator_id, p_execution_token)` `SECURITY DEFINER` function ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)), preserves `pos_dish_mappings` and `venue_tracking_activations`, writes a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json`, and transitions the request through `db_deleted` to `awaiting_verification`.
  - Direct `DELETE`, `UPDATE`, and `TRUNCATE` on `order_outcome_*` tables remain rejected by append-only triggers (which also reject GUC spoofing by `peekaplate_runtime`), and `peekaplate_runtime` has `DELETE`, `UPDATE` on `order_data_deletion_requests`, and `EXECUTE` on `delete_venue_order_data` revoked ([20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql](../migrations/20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql)).
  - Independent verification is implemented via `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` (`verifyVenueOrderDeletion` + `app_private.record_deletion_verification`), durable orphan-cleanup retries run in `handleScheduled` (`retryPendingOrphanCleanups`), and post-restore reconciliation is implemented in `reconcileOrderDeletionsAfterRestore` ([restore-reconciliation.ts](../backend/src/order-ingestion/restore-reconciliation.ts)).
  - **Remaining Operational & Staging Gates:** **Manual deletion operator** (`Sai`, confirmed; staging `OPERATOR_HYPERDRIVE` / `AUTHORIZED_DELETION_OPERATOR_IDS` provisioning pending), **Independent checker** (`Jeffin`, primary independent deletion checker; **backup independent deletion checker: pending confirmation** — requires explicit consent and actual authenticated UUID), staging migration (`20261113120000` + `20261114020000`) and R2 end-to-end verification, and post-restore backup reconciliation verification (see Part 4).
- **S5-DATA-09 Status:** Separate manual behavioral-event deletion workflow; out of scope for `S6-DATA-14.2`.

### D. California Privacy-Law Review Note (For Sai / Security & Outside Counsel)

Because the pilot is in the **San Francisco Bay Area, California**, two California privacy statutes are being evaluated as a starting point. **California is the P0 pilot scope.** **This note does not conclude that PeekaPlate is subject to either law or claim legal clearance.**

1. **CCPA / CPRA (Cal. Civ. Code § 1798.100 et seq.):**
   - *Why considered:* Applies to for-profit businesses doing business in California that meet at least one statutory applicability threshold (based on prior-year gross revenue, volume of California consumers' or households' personal information bought/sold/shared, or percentage of revenue derived from selling/sharing personal information, plus certain common-branding/joint-venture rules, as verified by counsel). **CCPA thresholds remain undecided.**
2. **CalOPPA (Cal. Bus. & Prof. Code §§ 22575–22579):**
   - *Why considered:* Applies broadly (without revenue/volume thresholds) to operators of commercial websites or online services that collect personally identifiable information (PII) from California residents, requiring a conspicuously posted privacy policy with specific disclosures (categories of PII/third-party sharing, review/change process if any, material change notice, effective date, and Do Not Track / third-party tracking disclosures). **CalOPPA applicability also depends on the information actually collected.**
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
  - [ ] Confirm original CSV retention policy: `Decision 2` (2026-11-11, no automatic expiry for P0)
  - [ ] Confirm limited purposes (re-processing after fixes, owner reporting, P1 order conversion metric)
  - [ ] Approve owner-facing upload notice wording (Part 2)
- **Sai (Security):**
  - [ ] Confirm data-content & PII prohibition controls (schema allowlist, identifier checks, tenant RLS, private R2 isolation, operator-only access)
  - [ ] Confirm server-side agreement acceptance enforcement design (Part 3.B) and `S6-DATA-14.2` deletion-on-request dependency (Part 3.C)
  - [ ] Confirm behavioral deletion distinction (`S5-DATA-09`, no per-diner deletion)
  - [ ] Confirm California privacy review (CCPA/CPRA & CalOPPA applicability questions in Part 3.D) and whether outside-counsel sign-off is required before real owner uploads

### F. Governance & Decisions (Nov 13, 2026 Update Reconciled — No Fabricated Initials/Dates)

> **Approval-Evidence Caveat:** The supplied November 13, 2026 governance update records the operational decisions below as approved, but its copied table formatting did not preserve Vivien's and Sai's approval initials and dates. Do not treat an approved operational procedure as proof of technical implementation, staging verification, or external confirmation.

| Item | Status | Owner / Details & Boundaries |
| :--- | :--- | :--- |
| **Post-owner-testing retention review owner** | **Approved** | **Adam** |
| **Historical import eligibility & original CSV retention (`Decision 2`, Nov 11)** | **Approved (P0)** | **90-day historical import window** (`ordered_at`) and **no automatic expiry for original CSVs during P0** (`enableRawCsvPurge = false`). |
| **Manual deletion operator** | **Approved (Operational)** | **Sai** — handles escalated/manual owner deletion requests and executes `deleteVenueOrderData`. (Staging `OPERATOR_HYPERDRIVE` and `AUTHORIZED_DELETION_OPERATOR_IDS` provisioning still pending.) |
| **Independent deletion checker** | **Approved (Operational — Backup Pending Confirmation)** | **Jeffin** is the primary independent deletion checker (`<>` Sai, never in `authorizedOperatorIds`). **Backup checker: pending confirmation** (whether Teeyansh can serve as backup checker for Jeffin requires Teeyansh's explicit consent and actual authenticated UUID; he is not added and remains off `authorizedOperatorIds`). (Staging `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, and `AUTHORIZED_DELETION_CHECKER_IDS` provisioning still pending.) |
| **Order deletion SLA** | **Approved (Policy)** | **Acknowledge receipt within 5 business days; delete live data within 30 days; backups age out according to the provider's schedule.** |
| **Account closure procedure** | **Policy approved; execution path not built** | **No immediate automatic deletion.** Notify owner they may export data or request deletion; if no response within 90 days, operator manually performs deletion. **Schema boundary:** `order_data_deletion_requests.reason` supports `pilot_withdrawal`, `data_cleanup`, `retention_policy_request`; if an owner does not respond within 90 days, `enforce_order_data_deletion_request_insert()` currently requires active owner membership, so operator-initiated deletion without an owner submission would require a narrow future trigger/RPC extension (not implemented in P0). This is not a no-change item: until a path is built or the manual procedure has its own checklist and sign-off, the 90-day cleanup cannot be run. |
| **Pilot agreement (`S6-DATA-14.1`)** | **Conditional Approval** | Conditional on PR #166 being updated to reflect the approved Nov 13 decisions. |
| **Agreement signing & signatory** | **Approved (P0)** | **Vivien** signs for PeekaPlate. Electronic owner acceptance (`POST /venues/:venueId/orders/agreement-acceptance`) is sufficient for P0; a separate signed document is required only if requested by an owner. **Acceptance counts as enforced only once versioned acceptance is deployed and verified in staging. An open PR is not live enforcement.** |
| **Legal review** | **Deferred for P0** | Deferral covers synthetic-only testing and is **not** legal clearance for real data. Vivien and Sai review diner notice wording; legal review is still needed before real data. |
| **Jurisdiction & privacy laws** | **Approved Working Assumption (P0)** | California is the P0 pilot scope. **CalOPPA** is treated as applying under the working assumption, but applicability also depends on the information actually collected. **CCPA thresholds remain undecided**; revisit before real diner data or restaurants outside California. |
| **Diner-event expiry & deletion (`S5-DATA-09`)** | **Approved Manual P0 Exception** | Manual only; automated expiry and deletion do not exist. Conditions: operator Sai and checker Jeffin (backup checker pending confirmation); Jeffin's `S5-DATA-09` checklist in use; expiry schedule (13 months from event time, enforced by manual check) written down; review date after owner testing (owner: Adam). Because we keep visit and event identifiers, deletion covers only the events we can locate by restaurant or time window. |
| **Owner-report data source confirmation** | **Confirmed (Sai, Nov 13)** | Confirmed (Sai, Nov 13): owner reports query canonical PostgreSQL facts through `owner_observation_v1`, not PostHog. PostHog’s shorter retention does not decide owner-report history. The 13-month canonical retention still needs its manual enforcement checks. |

### G. Version & Change History

| Version | Date | Author | Summary |
| :--- | :--- | :--- | :--- |
| `v0.1 — Draft` | 2026-11-13 | Teeyansh | Initial draft of S6-DATA-14.1 pilot agreement, matching upload wording, PR #120 alignment check, server-side acceptance gate (`pilot_order_agreement_acceptances`), S6-DATA-14.2 deletion workflow (`delete_venue_order_data`), pending decisions table, and operational runbook. |
| `v0.1 — Draft (Rev 2)` | 2026-11-14 | Teeyansh | Added the 9-domain retention decision register and reconciled the Nov 13 operational decisions (Sai/Jeffin, 5d/30d SLA, 90d account-closure procedure, Vivien signatory, California/CalOPPA P0 assumption, manual diner-event exception, and Sai PostHog-vs-facts confirmation). |
| `v0.1 — Draft (Rev 3)` | 2026-11-14 | (revision for review) | Removed the incorrectly attributed 90/90 proposal (Decision 2 stands). Replaced "anonymous" wording with what we can locate. Recorded Sai's Nov 13 responses (operator/checker confirmed, owner-report source confirmed, legal review deferred for synthetic-only, California scope, manual exception conditions, acceptance enforcement condition). Marked account-closure execution as not built. Added runbook notes for failed requests and re-upload after deletion. Marked Parts 3 and 4 internal, reconciled migration filename `20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql`, and kept backup checker pending confirmation. |

### H. Retention Policy Decision Register (9 Separate Domains — Do Not Conflate)

| Domain | What Is Retained | Storage Location | Retention Clock & Deletion Trigger | Owner & Approver (Date) | Authorized Executors | Exceptions & Outstanding Decisions |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Historical import eligibility** | Import acceptance cutoff (`ordered_at` within 90 days of import) | Parser & ingestion (`packages/contracts/src/order-outcome.ts`, `service.ts`) | Not a storage clock; rows > 90 days quarantine as `too_old` | Owner: Teeyansh; Approver: Vivien & Sai (approved 2026-11-11) | Ingestion Worker (`importOrderOutcomes`) | Interim P0 policy; review after owner testing |
| **2. Original CSV in R2** | Raw uploaded `pilot_order_outcome.v1` CSV | R2 `peekaplate-staging-assets` (`order-imports/<tenant_id>/<batch_id>/source.csv`) | **Decision 2 (2026-11-11):** No auto-expiry (`enableRawCsvPurge = false`). Manual deletion via `S6-DATA-14.2` | Owner: Adam (post-testing review); Approver: Vivien & Sai (approved 2026-11-11) | `peekaplate_deletion_operator` (`deleteVenueOrderData`); scheduled orphan cleanup (`handleScheduled`, orphans > 2h only) | Reviewed after owner testing |
| **3. Derived canonical order rows** | Accepted order lines, batch metadata, checksum conflicts | PostgreSQL `app_private.order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_conflicts` | **UNRESOLVED** (no time-based auto-expiry); deleted only on owner request (`S6-DATA-14.2`) | Owner: Teeyansh; Approver: Vivien (**Pending**), Sai (**Pending**) | `peekaplate_deletion_operator` (`delete_venue_order_data`) | Time-based expiry unresolved |
| **4. Quarantined order rows** | Rejected/quarantined CSV rows (`too_old`, `before_tracking_start`, etc.) | PostgreSQL `app_private.order_outcome_quarantine` | **UNRESOLVED** (no time-based auto-expiry); deleted on owner request (`S6-DATA-14.2`) | Owner: Teeyansh; Approver: Vivien (**Pending**), Sai (**Pending**) | `peekaplate_deletion_operator` (`delete_venue_order_data`) | Time-based expiry unresolved |
| **5. Database backups & restored copies** | Managed Supabase PostgreSQL PITR / snapshots & R2 backups | Managed Supabase & Cloudflare R2 backup layers (outside app runtime) | **UNRESOLVED** (managed provider retention window not verified in repo); post-restore reconciliation via `reconcileOrderDeletionsAfterRestore` | Owner: Sai / Infra; Approver: Sai (**Pending**) | `peekaplate_deletion_operator` (`reconcileOrderDeletionsAfterRestore`) | Provider backup retention periods & staging restore drill remain **Pending** |
| **6. Behavioral observations (browser & index)** | Diner `observation.v2` events (ephemeral `session_id`, no PII) | Browser outbox (`indexedDB` / `localStorage`, 24h max age, 500 events / 1 MiB); PostgreSQL `app_private.observation_index` | Browser outbox: 24h max age or immediate clear on withdrawal. PostgreSQL: **UNRESOLVED** (manual `S5-DATA-09` only; no auto-expiry) | Owner: Vivien / Adam; Approver: **Pending** (before real diner data) | Diner browser (`clearLivePipeline`); manual `S5-DATA-09` operator (unimplemented) | Order-CSV retention does not apply here |
| **7. R2 archival of behavioral data** | Raw accepted/quarantined behavioral observation batches | R2 `peekaplate-staging-assets` (`OBSERVATION_ARCHIVE_BUCKET`) | **UNRESOLVED** (no auto-expiry implemented; manual `S5-DATA-09` only) | Owner: Sai / Vivien; Approver: **Pending** | None automated | Order-CSV retention does not apply here; shares staging bucket with order imports |
| **8. PostHog data & Supabase export** | Allowlisted `observation.v2` properties (no `session_id`, `person_profiles: 'never'`) | PostHog US project `675372` (staging) & PostgreSQL `posthog_exports` (hourly staging export) | **UNRESOLVED** (`docs/posthog-export.md`: short-retention proposal is not an automated deletion job) | Owner: Jeffin / Sai; Approver: **Pending** (before real diner data) | None automated | Deletion across PostHog + Supabase copies unimplemented |
| **9. Canonical behavioral facts & derived outputs** | Aggregated session/dish facts, `owner_observation_v1`, `comparison_report.v1` | PostgreSQL `app_private.observation_facts` & report views/functions | **UNRESOLVED** (no auto-expiry implemented; manual `S5-DATA-09` only) | Owner: Vivien / Sai; Approver: **Pending** | None automated | Cohort suppression (< 10 sessions) is statistical privacy, not deletion/withdrawal |

---

## Part 4: Operational Runbook — Owner-Scoped Order-Data Deletion (`S6-DATA-14.2`)

**Internal, not owner-facing.**

> Parts 1 and 2 are owner-facing. Parts 3 and 4 are internal governance, implementation, and operational material.

1. **Submitting a Deletion Request:**
   - An authenticated venue owner submits `POST /venues/:venueId/orders/deletion-requests` with `{ "requestId": "<uuid>", "reason": "pilot_withdrawal" | "data_cleanup" | "retention_policy_request" }` (no free-text reason accepted; `account_closure` is not a supported reason; see Part 3.F).
   - The endpoint immediately persists `status = 'requested'` (HTTP `202`) in `app_private.order_data_deletion_requests` and blocks any new `importOrderOutcomes` for that venue (`409 deletion_in_progress`).
   - Off-platform owner requests (e.g., email/support) must be routed to the **Manual deletion operator** (*Sai, confirmed*); no automated support-inbox integration exists.
2. **Identity & Venue Ownership Verification:**
   - The API verifies the caller's Supabase JWT (`services.verify`) and checks `app_private.staff_membership` (`permission = 'owner'`) for `venueId` inside a `SET LOCAL` transaction.
   - `enforce_order_data_deletion_request_insert()` trigger in PostgreSQL independently enforces `app.tenant_id`, `app.actor_id`, `owner` membership, and initial `status = 'requested'`.
3. **Authorized Operator Execution & Allowlist Enforcement:**
   - Execution is **not** exposed as a self-serve HTTP endpoint. Only an authorized internal operator (`operatorId`) runs `deleteVenueOrderData` with a server-controlled `authorizedOperatorIds` allowlist (`ReadonlySet<string>`).
   - `deleteVenueOrderData` fails closed with `403 forbidden` unless `authorizedOperatorIds` is non-empty, `operatorId` is a canonical UUID, and `authorizedOperatorIds.has(operatorId)`. It also requires an existing owner-submitted request (`404 deletion_request_not_found` otherwise).
   - **Allowlist & Identity Blocker:** No personal operator UUIDs are hardcoded in the repository, and no production/staging operator identities are provisioned yet. Sai is the confirmed **Manual deletion operator**; before real pilot uploads are enabled, Sai's authenticated UUID must be provisioned in the server-controlled `AUTHORIZED_DELETION_OPERATOR_IDS` / `authorizedOperatorIds` configuration. If the allowlist is empty or unprovisioned, deletion execution remains blocked.
   - **Separation from Independent Checker:** Jeffin is the primary **Independent deletion checker** (backup independent deletion checker: **pending confirmation**). Do **not** add the checker to `authorizedOperatorIds` merely because they verify deletion results, and do **not** treat the checker as an authorized deletion operator unless separately authorized.
4. **Exact Storage & Database Deletion Steps:**
   - *Phase 1 (Audit & Fenced Lease):* Acquire `pg_advisory_xact_lock('order_lifecycle:' || venueId)`, lock the `app_private.order_data_deletion_requests` row `FOR UPDATE`, return immediately if already `awaiting_verification` or `verified` (or skip to Phase 4 if `db_deleted`), reject concurrent executions with `409 deletion_in_progress` if an active `'executing'` lease (`execution_lease_expires_at > now()`) is held, otherwise claim `status = 'executing'` with a fresh `execution_token` (`uuid`), `execution_started_at`, and `execution_lease_expires_at` (5-minute default lease) and collect `storage_key`s from `app_private.order_outcome_import_batches`. This works identically over both direct `pg.Client` sessions and Hyperdrive transaction-mode pooling without session-level locks.
   - *Phase 1b (Durable External Intent):* Write `order-deletion-ledger/<venueId>/<requestId>/intent.json` with `{ requestId, venueId, operatorId, status: "in_progress", intentRecordedAt }` to R2 **before** any destructive operation using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`, so retries never overwrite the original intent; fails closed with `502 deletion_storage_failed` if the intent cannot be persisted).
   - *Phase 2 (R2 Storage & Heartbeat Fencing):* List all objects under `order-imports/<venueId>/` in private R2 storage, union with DB `storage_key`s strictly matching that prefix, and delete each object while renewing `execution_lease_expires_at` conditionally (`WHERE execution_token = $token AND status = 'executing'`). If the lease was lost to a replacement worker, execution aborts immediately with `409 deletion_lease_lost`.
   - *Phase 3 (Fenced PostgreSQL Deletion):* Verify `status = 'executing'` and `execution_token` still match, call `app_private.delete_venue_order_data(venueId, requestId, operatorId, executionToken)` (`SECURITY DEFINER`, owned by privileged role, `EXECUTE` revoked from `PUBLIC` and `peekaplate_runtime`) which re-verifies `execution_token` inside PostgreSQL, enables transaction-local deletion inside a `BEGIN ... EXCEPTION WHEN OTHERS` block that always resets `app.order_data_deletion_active = 'off'`, and deletes `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, and `order_outcome_import_batches` for `venueId`, then marks `order_data_deletion_requests.status = 'db_deleted'` with `executed_by = operatorId`, clears `execution_token`/`execution_lease_expires_at`, and records exact counts and `completed_at`.
   - *Phase 4 (R2 Deletion Ledger Completion):* Write a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json` with `operatorId`, exact counts, and `completedAt` using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`), then transition `db_deleted` -> `awaiting_verification`. Even if the process crashes between Phase 3 DB commit and Phase 4, `intent.json` from Phase 1b is already durable in R2 and `completed.json` is written on retry.
   - *Preserved non-order tables:* `pos_dish_mappings` (venue menu-to-POS configuration) and `venue_tracking_activations` (server-controlled activation timestamp) are intentionally preserved. No derived order-outcome reports, exports, or caches exist.
5. **Two-Person Deletion Verification Procedure:**
   Every executed order-data deletion requires two distinct people:
   - **Operator** (*Sai, confirmed*):
     1. Receives and validates the owner deletion request (`app_private.order_data_deletion_requests` row or escalated owner request).
     2. Confirms restaurant/venue identity (`venueId`) and deletion scope (all order-outcome R2 objects and derived order-outcome DB rows for that venue).
     3. Executes the authorized deletion via `deleteVenueOrderData` using an operator identity included in the server-controlled `authorizedOperatorIds` allowlist.
     4. Records the deletion outcome and audit details (`requestId`, `venueId`, `operatorId`, object/row counts, `completedAt`, and R2 ledger keys).
   - **Independent Checker** (*Jeffin, primary independent deletion checker; backup checker: pending confirmation*):
     1. Must be a **different person** from both the requester and the operator who executed the deletion (`checker <> requested_by` and `checker <> executed_by`, and must **not** be added to `authorizedOperatorIds` solely to perform verification).
     2. Independently verifies that the requested restaurant's original CSV objects under `order-imports/<venueId>/` in R2 are removed (zero remaining objects).
     3. Independently verifies that the requested restaurant's derived order data (`order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`) is removed (`0` rows for `venueId`).
     4. Confirms other restaurants' data remains untouched (and `pos_dish_mappings` / `venue_tracking_activations` are preserved as expected).
     5. Verifies the deletion audit entry in `app_private.order_data_deletion_requests` (`status = 'awaiting_verification'`, matching `executed_by`, counts, and `completed_at`) and the R2 ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json` and `completed.json`).
     6. Records the independent verification result (`PASS`/`FAIL`) via `POST /internal/venues/:venueId/orders/deletions/:requestId/verify`, which transitions `awaiting_verification -> verified` via `app_private.record_deletion_verification(...)` (immutable once `verified`).
   - **5a. Independent Verification Record & Least-Privilege Access:**
     - **1. Read-Only R2 Verification Worker Endpoint (*Implemented in repo; `CHECKER_HYPERDRIVE` & `ORDER_DELETION_VERIFICATION_BUCKET` bindings pending staging provisioning*):**
       - In [backend/wrangler.jsonc](../backend/wrangler.jsonc), `ORDER_OUTCOME_ARCHIVE_BUCKET` and `ORDER_IMPORT_BUCKET` share `peekaplate-staging-assets` with `OBSERVATION_ARCHIVE_BUCKET` and `INGESTION_REPORTS_BUCKET`, and Cloudflare R2 API tokens support bucket-level rather than object-prefix restrictions. Therefore, Jeffin must **not** receive bucket-wide R2 credentials.
       - *Implemented endpoint:* `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` in [backend/src/index.ts](../backend/src/index.ts) backed by `verifyVenueOrderDeletion` and `OrderDeletionVerificationStorage` (`list` + `get` only; no `put` or `delete`), enforcing `AUTHORIZED_DELETION_CHECKER_IDS` (`checkerId <> requested_by` and `checkerId <> executed_by`), full cursor pagination across `order-imports/<venueId>/`, **zero** CSV body reads, and content validation of `intent.json` and `completed.json`. Fails closed with **`503`** until its required staging bindings (`CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, `AUTHORIZED_DELETION_CHECKER_IDS`) are provisioned.
     - **2. PostgreSQL Roles `peekaplate_deletion_operator` & `peekaplate_deletion_checker` (*Implemented in `20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql`; `LOGIN` credentials & Hyperdrive bindings pending staging provisioning*):**
       - `peekaplate_runtime` has `EXECUTE` on `app_private.delete_venue_order_data` and `DELETE` / `UPDATE` on `app_private.order_data_deletion_requests` **revoked**.
       - `peekaplate_deletion_operator` (`NOLOGIN NOINHERIT`, `NOBYPASSRLS`) owns deletion execution and lifecycle updates; `peekaplate_deletion_checker` (`NOLOGIN NOINHERIT`, `NOBYPASSRLS`) has column-scoped `SELECT` only plus `EXECUTE` on `app_private.record_deletion_verification`. Separate `LOGIN` identities (`peekaplate_operator_login`, `peekaplate_checker_login`) and separate Hyperdrive bindings (`OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`) must be provisioned in staging/production without inheriting `peekaplate_runtime`.
       - Every verification query runs in a transaction with `SET LOCAL app.tenant_id = '<venueId>'` and a bounded `statement_timeout`. Neither Jeffin nor any backup checker may ever be added to `authorizedOperatorIds`.
     - **3. Cross-Tenant Preservation Verification (Synthetic Staging Baseline Test):**
       - Create a `target` venue and a separate `control` venue in staging, capture baseline aggregate counts, execute deletion **only** for `target`, and verify: (a) `target` order data is `0`, (b) `target` preserved configuration (`pos_dish_mappings`, `venue_tracking_activations`) matches baseline, and (c) `control` venue R2 and database counts remain unchanged (without exposing control tenant IDs or row contents to the checker).
6. **Retry, Partial Deletion & Failed Verification Handling:**
   - *Partial deletion — R2 failure:* If any R2 `list` (including truncated-without-cursor or repeated-cursor pagination) or `delete` fails, the request is marked `status = 'failed'` (`error_code = 'r2_delete_failed'`) and returns `502 deletion_storage_failed`. PostgreSQL batch rows (`storage_key`s) are **not** deleted so retries still have all `storage_key`s.
   - *Partial deletion — DB failure:* If Phase 3 DB deletion fails, the DB transaction rolls back, the request is marked `status = 'failed'` (`error_code = 'db_delete_failed'`), and `deleteVenueOrderData` returns `500 deletion_db_failed`.
   - *Lease loss / concurrent worker:* If heartbeat renewal or the Phase 3 fence check detects that `execution_token` was superseded, execution aborts with `409 deletion_lease_lost` before Phase 3 DB mutations.
   - *Partial deletion — R2 receipt write failure:* If Phase 4 `completed.json` write fails after Phase 3 DB purge, the request stays in `status = 'db_deleted'` (`error_code = 'ledger_receipt_failed'`) and returns `502 deletion_storage_failed`. Imports remain **blocked** (`db_deleted <> 'verified'`), and retrying with the same `requestId` skips R2/DB purge and retries `completed.json` before transitioning to `awaiting_verification`.
   - *Safe retry & in-flight import fencing:* `importOrderOutcomes` captures the venue's monotonic `deletion_epoch` (`app_private.order_data_deletion_gates`) in Tx 1 and revalidates it in Tx 2 under `order_lifecycle:${venueId}` so any in-flight import is fenced with `409 deletion_in_progress` (and cleans up its uploaded R2 CSV) even if deletion completes before Tx 2. Imports remain blocked in `awaiting_verification` until independent checker `PASS` transitions the request to `verified`.
   - *Failed independent verification:* If the independent checker records `FAIL` (or finds remaining R2 objects / DB rows / invalid ledger receipts, returning `409 verification_precondition_failed`), the request remains in `awaiting_verification` (`409 deletion_in_progress`), imports stay blocked, and verification must be repeated after remediation.
   - *Clearing a `failed` request:* Imports stay blocked while any request has `status <> 'verified'`, and the owner cannot independently cancel, delete, or reset a failed deletion request. The operator (**Sai**) reviews the request's `error_code`, fixes the underlying cause, and retries `deleteVenueOrderData` using the **same `requestId`**. The independent checker then verifies, and imports resume only after checker `PASS`.
   - *Re-upload after deletion:* Agreement acceptance is preserved after a verified deletion. The same venue may import again after verified deletion without accepting again, unless the agreement version changes.
7. **Audit Evidence Retained:**
   - `app_private.order_data_deletion_requests`, `app_private.restore_reconciliation_runs`, and `order-deletion-ledger/<venueId>/<requestId>/{intent,completed,reconciled}.json` retain `requestId`, `venueId`, `requested_by`, `executed_by`, `verified_by`, bounded `reason` enum, `status`, object/row counts, `error_code`, `verification_outcome`, `verification_evidence_ref`, and timestamps. Verified DB records are immutable via trigger. **Zero** CSV contents, order lines, or diner data are retained.
8. **Backup / Restore Handling & Reconciliation:**
   - Managed PostgreSQL/Supabase PITR snapshots and R2 backups are outside application runtime control. Before exposing restored database traffic, operators must activate `app_private.system_gates('order_imports_restore_freeze') = true` (which fails closed with `503 restore_reconciliation_pending`) and run `reconcileOrderDeletionsAfterRestore` ([backend/src/order-ingestion/restore-reconciliation.ts](../backend/src/order-ingestion/restore-reconciliation.ts), CLI entry point [scripts/reconcile-order-deletions-after-restore.mjs](../scripts/reconcile-order-deletions-after-restore.mjs)) using `OPERATOR_DATABASE_URL` (`peekaplate_deletion_operator`).
   - Reconciliation cursor-paginates `order-deletion-ledger/`, validates JSON schemas and `(venueId, requestId)` provenance, purges resurrected R2 CSVs and DB rows (including snapshots predating the deletion request row via `app_private.reconcile_venue_order_deletion`), keeps `intent_only` and anomalous venues blocked, writes `reconciled.json` + `restore_reconciliation_runs`, and lifts the global freeze only when zero anomalies occur. Staging restore drill sign-off remains *Pending*.
9. **Communicating Completion to the Owner:**
   - API callers receive HTTP `202` (`status: "requested"`) upon request submission. The approved policy SLA is **acknowledge receipt within 5 business days** and **delete live data within 30 days** (backups age out according to the provider's schedule); manual owner notification templates/channels remain pending operational setup.
10. **Excluded Scope (`S5-DATA-09`):**
    - Diner behavioral events are **not** deleted by this workflow; they belong to `S5-DATA-09` (manual owner-scoped deletion on request, by restaurant or time window; no per-diner deletion).
11. **Staging Infrastructure Prerequisites & Pre-Pilot Verification Checklist:**
    - **Implementation vs. Staging Status:** All database roles/triggers (`20261113120000` + `20261114020000`), backend endpoints, `handleScheduled` orphan-cleanup retries, and restore-reconciliation CLI/service are **implemented in code**. None of the new staging bindings below are **configured in staging**, **deployed to staging**, or **verified in staging** yet (`backend/wrangler.jsonc` is unchanged; `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` returns **`503`** until its required staging bindings are provisioned).
    - **Required Staging Bindings & Secrets (Follow-Up Provisioning):**
      - `OPERATOR_HYPERDRIVE` (Hyperdrive binding -> `peekaplate_operator_login` with `peekaplate_deletion_operator` role; never `peekaplate_runtime`).
      - `CHECKER_HYPERDRIVE` (Hyperdrive binding -> `peekaplate_checker_login` with `peekaplate_deletion_checker` role; column-scoped `SELECT` + `record_deletion_verification` only).
      - `ORDER_DELETION_VERIFICATION_BUCKET` (read-only R2 binding `list` + `get` on `peekaplate-staging-assets` for `POST /internal/venues/:venueId/orders/deletions/:requestId/verify`).
      - `AUTHORIZED_DELETION_OPERATOR_IDS` / `authorizedOperatorIds` (comma-separated canonical UUIDs for approved deletion operators — Sai).
      - `AUTHORIZED_DELETION_CHECKER_IDS` (comma-separated canonical UUIDs for independent checkers — Jeffin; backup checker pending confirmation; never in `authorizedOperatorIds`).
    - **Checklist:**
      - [x] **Implemented in code & verified locally/CI DB:** Both migrations (`20261113120000_pilot_order_agreement_and_deletion.sql` and `20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql`) and integration/pgTAP tests pass against PostgreSQL 16.11 (`pnpm verify test:db`).
      - [ ] **Configured & deployed in staging:** Apply both migrations (`20261113120000_pilot_order_agreement_and_deletion.sql` and `20261114020000_harden_s6_data_14_deletion_and_reconciliation.sql`) in staging, provision `OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, `AUTHORIZED_DELETION_OPERATOR_IDS`, and `AUTHORIZED_DELETION_CHECKER_IDS`, and deploy the Worker.
      - [ ] **Verified in staging:** Run synthetic staging E2E agreement acceptance enforcement (`POST /venues/:venueId/orders/agreement-acceptance` + `POST /venues/:venueId/orders/import`), synthetic E2E deletion (`target` vs. `control` venue), two-person verification (`POST /internal/venues/:venueId/orders/deletions/:requestId/verify`), and post-restore backup reconciliation drill (`scripts/reconcile-order-deletions-after-restore.mjs`).
      - [ ] **Approvals & pending human confirmations:** Obtain Vivien (Product) and Sai (Security) formal approvals, and resolve backup independent deletion checker confirmation (explicit consent + authenticated UUID if Teeyansh serves as backup for Jeffin).
