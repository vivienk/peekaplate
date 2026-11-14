# PeekaPlate Pilot Order-Outcome Data Agreement (`S6-DATA-14.1`)

**Version:** `v0.1 — Draft`  
**Status:** Drafted (Pending Product Review/Approval by Vivien and Security Review/Approval by Sai)  
**Effective Date:** `[PENDING APPROVAL — NOT EFFECTIVE]`  
**Pilot Lead / Owner:** Teeyansh  
**Jurisdiction / Pilot Region:** San Francisco Bay Area, California (starting jurisdiction)

> **Important Notice — Not Legal Advice:** This document is a short operational pilot agreement and data-processing terms draft for PeekaPlate's P0 pilot. It is **not** legal advice and is **not** a standalone general privacy policy. PeekaPlate makes no legal determination herein regarding statutory applicability; applicability and final wording must be confirmed by Security (Sai) and/or qualified outside counsel before any real pilot owner uploads a file.

> **Mandatory Pre-Pilot Gate (Status Separation):**
> - **Implemented in Code (PR #166):** Server-side agreement gate (`v0.1`), owner deletion intake, operator fenced purge, independent checker verification route (`POST /internal/venues/:venueId/orders/deletions/:requestId/verify`), orphan-cleanup retries, and post-restore reconciliation (`migrations/20261113120000_pilot_order_agreement_and_deletion.sql` + `migrations/20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql`).
> - **Not Yet Merged / Deployed / Verified in Staging:** PR #166 is open against `develop`. Staging bindings (`OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, `AUTHORIZED_DELETION_OPERATOR_IDS`, `AUTHORIZED_DELETION_CHECKER_IDS`) are **not** provisioned, and staging E2E deletion/restore drills have **not** run.
> - **NOT CLEARED FOR REAL DATA:** Legal review is deferred for synthetic-only P0. No real pilot owner may upload a file and no real diner data may be processed under this agreement until:
>   1. **S6-DATA-14.1** (this agreement) receives formal Product (Vivien) and Security (Sai) sign-off and open policy/governance items (backup checker, Sai's SLA/report-source confirmation, `pilot_withdrawal` re-acceptance rule) are resolved.
>   2. Both migrations and staging bindings are deployed and **S6-DATA-14.2** (including two-person verification and backup/restore reconciliation) is verified in staging.
>   3. Server-side agreement acceptance enforcement is deployed and verified in staging (`POST /venues/:venueId/orders/agreement-acceptance` + `POST /venues/:venueId/orders/import`).
>
> Synthetic-only testing remains permitted.

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

### 7. Original CSV Retention & Purpose (`Decision 2`)

- **Approved P0 policy (`S6-DATA-14 Decision 2`, reconciled 2026-11-13):** For P0, the **original uploaded CSV file** is retained with **no automatic expiry** (`DEFAULT_RETENTION_CONFIG.enableRawCsvPurge = false`, and `handleScheduled` does not enable raw-CSV purging), subject to post-owner-testing review (owned by Adam).
- **Effective status (`v0.1 — Draft`):** **NOT YET EFFECTIVE** for real pilot owners (mandatory pre-pilot gate remains closed). Runtime behavior keeps `enableRawCsvPurge = false`. Any future time-based expiry (such as a 90-day raw-CSV purge) would require formal Product (Vivien) and Security (Sai) approval before enabling `enableRawCsvPurge`.
- **Important distinction:** Retaining the original CSV with no automatic P0 expiry **does not** change the 90-day import eligibility window in Section 6; orders older than 90 days at import time are still quarantined and not imported.
- **Scope boundary:** This P0 CSV retention policy does **not** apply to diner behavioral data, PostHog, R2 behavioral archives, or canonical behavioral facts (governed separately with a 13-month retention target under a manual P0 exception; see Part 3.H).
- **Reason for retention:** Supports re-processing after fixes, owner reporting (canonical PostgreSQL facts), and the planned P1 order conversion metric (only after matching and metric contracts are approved). Owners retain deletion rights under Section 11.A.

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
- **Withdrawal vs. Re-Acceptance (Unresolved Policy Decision — Adam / Vivien):** Under the current implementation, `app_private.pilot_order_agreement_acceptances` is append-only per `(tenant_id, agreement_version)`. Completing a verified `pilot_withdrawal` deletion purges order data without revoking the venue's stored `v0.1` acceptance. Whether `pilot_withdrawal` should terminate the agreement and require fresh acceptance before any future import remains an **unresolved policy decision owned by Adam and Vivien**.
- **Backup & Release-Gate Notice:** Automated application deletion covers live R2 objects and live PostgreSQL tables. Database backups/PITR snapshots are managed by the database provider outside application control (see Part 4 for backup/restore reconciliation). **This agreement is a draft and is NOT CLEARED FOR REAL DATA** until staging verification, backup-restore reconciliation, and Product/Security approvals are complete.

#### B. Owner-Scoped Diner Behavioral Data Deletion (`S5-DATA-09` / 13-Month Manual P0 Exception)
- This agreement does not redefine diner behavioral-event retention. Stored diner behavioral events have a **13-month** retention target governed under a **manual P0 expiry and deletion exception (`S5-DATA-09`)** (no automated expiry or deletion job exists in the repository; subject to named operator/checker, schedule, and post-owner-testing review).
- **Retained identifiers & deletion scope:** Diner behavioral observations retain visit and event identifiers (such as ephemeral `session_id` and event IDs) in stored records (`app_private.observation_index`, R2 behavioral archives, and PostHog/exports). On a restaurant owner's request, PeekaPlate can manually locate and delete that restaurant's stored diner behavioral events **by restaurant/venue or time window** (and by retained visit/event identifiers where present in stored records) under `S5-DATA-09`.
- Diner consent withdrawal stops future collection only; manual deletion across PostgreSQL, R2 behavioral archives, and PostHog/Supabase exports is handled separately from `S6-DATA-14.2`.

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
> - **Deletion requests:** You may request deletion of your restaurant's order data under `S6-DATA-14.2` (and separately request manual deletion of your restaurant's stored diner behavioral events under `S5-DATA-09`; behavioral visit and event identifiers are retained for up to 13 months under a manual P0 exception).
> - **Reference:** `[Link to PeekaPlate Pilot Order-Outcome Data Agreement v0.1]`

---

## Part 3: Implementation Alignment, California Privacy Review & Blockers

### A. Alignment Verified Against PR #120 (`S5-DATA-07`)

Verified directly in the repository:
- **Schema & extra-column enforcement** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts)): `parseOrderOutcomeCsv` rejects any column outside `ALL_ALLOWED_CSV_HEADERS` with `unexpected_header`. `OrderTokenIdentifierSchema` rejects `@` and 10+ consecutive digits in `order_id` and `order_line_id`.
- **90-day import window** ([order-outcome.ts](../packages/contracts/src/order-outcome.ts), [service.ts](../backend/src/order-ingestion/service.ts)): `DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS = 90` anchored on `ordered_at`; older rows quarantine as `too_old`.
- **No automatic expiry for P0** ([service.ts](../backend/src/order-ingestion/service.ts), [index.ts](../backend/src/index.ts)): `DEFAULT_RETENTION_CONFIG.enableRawCsvPurge` is `false`, and `handleScheduled` does not pass `enableRawCsvPurge: true`.

### B. Signing / Acceptance Enforcement Status

- **Server-Side Acceptance Gate (Implemented in Code; Not Yet Deployed/Verified in Staging):**
  - `app_private.pilot_order_agreement_acceptances` ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)) stores tenant-scoped, append-only acceptance records `(tenant_id, agreement_version, accepted_by, accepted_at)` with `FORCE ROW LEVEL SECURITY` and a `SECURITY DEFINER` trigger verifying `app.tenant_id`, `app.actor_id`, and `owner` membership in `app_private.staff_membership`.
  - `POST /venues/:venueId/orders/agreement-acceptance` ([index.ts](../backend/src/index.ts), `acceptPilotOrderAgreement` in [service.ts](../backend/src/order-ingestion/service.ts)) records idempotent owner acceptance for `PILOT_ORDER_AGREEMENT_VERSION` (`v0.1`).
  - `importOrderOutcomes` ([service.ts](../backend/src/order-ingestion/service.ts)) checks `app_private.pilot_order_agreement_acceptances` inside the authorized tenant transaction and fails closed with `403 agreement_not_accepted` if missing or if the required version has changed. Acceptance for one venue never authorizes another venue.
  - **Post-`pilot_withdrawal` Re-Acceptance (Unresolved Policy Decision — Adam / Vivien):** Because `app_private.pilot_order_agreement_acceptances` is append-only per `(tenant_id, agreement_version)`, completing a `verified` deletion with `reason = 'pilot_withdrawal'` purges the venue's order data while leaving its `v0.1` acceptance row intact. Whether `pilot_withdrawal` should revoke acceptance and require re-acceptance before another import is **unresolved** and owned by **Adam and Vivien** (with **Sai** for security/enforcement alignment); do not silently alter `pilot_withdrawal` semantics without their decision.
- **Upload UI Status:** No order-CSV upload UI exists in `frontend/console/src/` yet. Do **not** expose an upload flow as ready for real owners until staging verification and backup-restore reconciliation are complete. When built (aligning with `S4-DES-03`), the Part 2 wording must integrate into the Console upload screen and call `POST /venues/:venueId/orders/agreement-acceptance` (a UI checkbox alone is never sufficient).

### C. S6-DATA-14.2 & S5-DATA-09 Status

- **S6-DATA-14.2 Status (Implemented in Backend/Migration; Staging & Backup Gates Remaining):**
  - `POST /venues/:venueId/orders/deletion-requests` ([index.ts](../backend/src/index.ts), `submitOrderDataDeletionRequest` in [service.ts](../backend/src/order-ingestion/service.ts)) records an owner's deletion request (`status = 'requested'`, HTTP `202`) using a bounded reason enum (`pilot_withdrawal`, `data_cleanup`, `retention_policy_request` — no free text; `account_closure` remains excluded until the pending account-closure decision is approved) and immediately blocks new imports for that venue (`409 deletion_in_progress`).
  - An authorized internal operator executes `deleteVenueOrderData` ([service.ts](../backend/src/order-ingestion/service.ts)) with an explicit non-empty `authorizedOperatorIds` allowlist, writes an immutable `in_progress` intent to the external R2 deletion ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json`) before any destructive operation, deletes R2 source CSVs (`order-imports/<venueId>/...`) and PostgreSQL order-outcome tables (`order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, `order_outcome_import_batches`) via the privileged `app_private.delete_venue_order_data(p_tenant_id, p_request_id, p_operator_id, p_execution_token)` `SECURITY DEFINER` function ([20261113120000_pilot_order_agreement_and_deletion.sql](../migrations/20261113120000_pilot_order_agreement_and_deletion.sql)), preserves `pos_dish_mappings` and `venue_tracking_activations`, and writes a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json`.
  - Direct `DELETE`, `UPDATE`, and `TRUNCATE` on `order_outcome_*` tables remain rejected by append-only triggers (which also reject GUC spoofing by `peekaplate_runtime`), and `peekaplate_runtime` has `DELETE`, `UPDATE` on `order_data_deletion_requests`, and `EXECUTE` on `delete_venue_order_data` revoked ([20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql](../migrations/20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql)).
  - Independent verification is implemented via `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` (`verifyVenueOrderDeletion` + `app_private.record_deletion_verification`), durable orphan-cleanup retries run in `handleScheduled` (`retryPendingOrphanCleanups`), and post-restore reconciliation is implemented in `reconcileOrderDeletionsAfterRestore` ([restore-reconciliation.ts](../backend/src/order-ingestion/restore-reconciliation.ts)).
  - **Remaining Operational & Staging Gates:** **Manual deletion operator** (`Sai` — **Approved (Operational)**, staging allowlist/Hyperdrive provisioning pending), **Independent checker** (`Jeffin` — **Approved (Conditional — subject to availability confirmation)**; **Backup checker: Pending Adam's confirmation**; mandatory separation of duties), staging migration (`20261113120000` + `20261114010000`) and R2 end-to-end verification, and post-restore backup reconciliation verification (see Part 4).
- **S5-DATA-09 Status:** Separate manual behavioral-event deletion workflow (13-month retention target under manual P0 exception; visit and event identifiers retained; no automated workflow in repository); out of scope for `S6-DATA-14.2`.

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
  - [ ] Confirm original CSV retention policy (`Decision 2`, no automatic expiry for P0, `enableRawCsvPurge = false`) and decide whether `pilot_withdrawal` deletion requires fresh agreement acceptance before any subsequent import (with Adam)
  - [ ] Confirm limited purposes (re-processing after fixes, owner reporting from canonical PostgreSQL facts, P1 order conversion metric)
  - [ ] Approve owner-facing upload notice wording (Part 2)
- **Sai (Security):**
  - [ ] Confirm data-content & PII prohibition controls (schema allowlist, identifier checks, tenant RLS, private R2 isolation, operator-only access)
  - [ ] Confirm server-side agreement acceptance enforcement design (Part 3.B) and `S6-DATA-14.2` deletion-on-request dependency (Part 3.C)
  - [ ] Confirm behavioral deletion distinction (`S5-DATA-09`, 13-month manual P0 exception, visit/event identifiers retained)
  - [ ] Confirm California privacy review (CCPA/CPRA & CalOPPA applicability questions in Part 3.D) and whether outside-counsel sign-off is required before real owner uploads

### F. Governance & Decisions (Nov 13, 2026 Update Reconciled — No Fabricated Initials/Dates)

> **Approval-Evidence Caveat:** The supplied November 13, 2026 governance update records the operational decisions below as approved, but its copied table formatting did not preserve Vivien's and Sai's approval initials and dates. Do not treat an approved operational procedure as proof of technical implementation, staging verification, or external confirmation.

| Item | Status | Owner / Details & Boundaries |
| :--- | :--- | :--- |
| **Post-owner-testing retention review owner** | **Approved** | **Adam** |
| **Historical import eligibility & original CSV retention (`Decision 2`, Nov 11)** | **Approved (P0)** | **90-day historical import window** (`ordered_at`) and **no automatic expiry for original CSVs during P0** (`enableRawCsvPurge = false`). Adam's Nov 13 `S6-DATA-14-PROP-90-90` (90-day CSV expiry) is **not** implemented as approved P0 policy. |
| **Manual deletion operator** | **Approved (Operational)** | **Sai** — handles escalated/manual owner deletion requests and executes `deleteVenueOrderData`. (Staging `OPERATOR_HYPERDRIVE` and `AUTHORIZED_DELETION_OPERATOR_IDS` provisioning still pending.) |
| **Independent deletion checker** | **Approved (Conditional — subject to availability confirmation)** | **Jeffin** (`<>` Sai, never in `AUTHORIZED_DELETION_OPERATOR_IDS`). **Separation of duties is mandatory.** **Backup checker: Pending Adam's confirmation.** (Staging `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, and `AUTHORIZED_DELETION_CHECKER_IDS` provisioning still pending.) |
| **Order deletion SLA** | **Approved (Policy) — Sai's response outstanding** | **Acknowledge receipt within 5 business days; delete live data within 30 days; backups age out according to the provider's schedule.** Sai's operational response/confirmation remains outstanding. |
| **Account closure procedure** | **Approved (Policy) — Execution Path Conditional / Not Implemented in P0** | **No automatic deletion.** Notify owner they may export data or request deletion; if no response after 90 days, manual deletion is intended. **Schema boundary:** `order_data_deletion_requests.reason` excludes `account_closure` and `enforce_order_data_deletion_request_insert()` requires active owner membership, so operator-initiated deletion without an owner submission is **not implemented in P0** and requires a narrow future trigger/RPC extension. |
| **Pilot agreement (`S6-DATA-14.1`)** | **Conditional Approval (Implemented in PR #166; Not Deployed)** | Electronic versioned acceptance (`v0.1`) is implemented in PR #166 (`POST /venues/:venueId/orders/agreement-acceptance` + `importOrderOutcomes` gate), **not** yet merged, deployed to staging, verified in staging, or approved for real uploads. |
| **Agreement signing & signatory** | **Approved (P0)** | **Vivien** signs for PeekaPlate. Electronic owner acceptance (`POST /venues/:venueId/orders/agreement-acceptance`) is sufficient for P0; a separate signed document is required only if requested by an owner. |
| **Legal review** | **Deferred for synthetic-only P0 — NOT CLEARED FOR REAL DATA** | Synthetic-only testing is permitted. Real owner uploads and real diner data are **not** legally cleared; Vivien and Sai review diner notice wording and outside legal review is required before real diner data or real owner uploads. |
| **Jurisdiction & privacy laws** | **Approved Working Assumption (P0)** | Assume **California** restaurants and diners for P0; **CalOPPA** applies under the approved working assumption. **CCPA thresholds remain undecided** and must be revisited before real diner data or restaurants outside California. |
| **Diner-event expiry & deletion (`S5-DATA-09`)** | **Approved Manual P0 Exception (13 months)** | **13-month** retention target for diner behavioral events; manual P0 exception subject to named operator (**Sai**), conditional checker (**Jeffin**, backup **pending Adam**), schedule, and post-owner-testing review date (**Adam**). Visit and event identifiers are retained (not completely anonymous). **Automation does not exist.** |
| **Owner reports data source** | **Canonical PostgreSQL facts (Sai confirmation open)** | Owner reports are intended to read from PeekaPlate's canonical PostgreSQL facts (not PostHog as source of truth). **Sai must confirm** externally that all owner report paths read exclusively from PeekaPlate stored facts rather than PostHog. |
| **Post-`pilot_withdrawal` agreement re-acceptance** | **Unresolved (Decision owners: Adam / Vivien)** | Currently `pilot_order_agreement_acceptances` is append-only per `(tenant_id, agreement_version)`, so a verified `pilot_withdrawal` deletes order data without revoking stored `v0.1` acceptance. Whether `pilot_withdrawal` should require fresh acceptance before another import is undecided. |

### G. Version & Change History

| Version | Date | Author | Summary |
| :--- | :--- | :--- | :--- |
| `v0.1 — Draft` | 2026-11-13 | Teeyansh | Initial draft of S6-DATA-14.1 pilot agreement, matching upload wording, PR #120 alignment check, server-side acceptance gate (`pilot_order_agreement_acceptances`), S6-DATA-14.2 deletion workflow (`delete_venue_order_data`), pending decisions table, and operational runbook. |
| `v0.1 — Draft (Rev 2)` | 2026-11-14 | Teeyansh | Reconciled Decision 2 (2026-11-11, no P0 expiry) vs. Adam's pending `S6-DATA-14-PROP-90-90` (90/90) proposal, added the 9-domain retention decision register, and reconciled Adam's Nov 13 operational decisions (Sai/Jeffin, 5d/30d SLA, 90d account-closure procedure, Vivien signatory, California/CalOPPA P0 assumption, manual diner-event exception, and Sai PostHog-vs-facts confirmation). |
| `v0.1 — Draft (Rev 3)` | 2026-11-14 | Teeyansh | Addressed PR #166 review feedback: unified Jeffin's checker status as conditional (availability + backup pending Adam), documented post-`pilot_withdrawal` re-acceptance as unresolved (Adam/Vivien), added 9-step failed-deletion recovery runbook and staging infrastructure prerequisites (`OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`), corrected diner anonymity wording to 13-month manual P0 exception with retained visit/event identifiers, and reconciled Decision 2 / real-data deferral. |

### H. Retention Policy Decision Register (9 Separate Domains — Do Not Conflate)

| Domain | What Is Retained | Storage Location | Retention Clock & Deletion Trigger | Owner & Approver (Date) | Authorized Executors | Exceptions & Outstanding Decisions |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Historical import eligibility** | Import acceptance cutoff (`ordered_at` within 90 days of import) | Parser & ingestion (`packages/contracts/src/order-outcome.ts`, `service.ts`) | Not a storage clock; rows > 90 days quarantine as `too_old` | Owner: Teeyansh; Approver: Hemu/Vivien (P0 interim, 2026-11-07) | Ingestion Worker (`importOrderOutcomes`) | Interim P0 policy; review after owner testing |
| **2. Original CSV in R2** | Raw uploaded `pilot_order_outcome.v1` CSV | R2 `peekaplate-staging-assets` (`order-imports/<tenant_id>/<batch_id>/source.csv`) | **Decision 2 (Approved P0):** No automatic expiry (`enableRawCsvPurge = false`). Manual deletion via `S6-DATA-14.2` | Owner: Adam (post-testing review); Approver: Vivien (**Pending**), Sai (**Pending**) | `peekaplate_deletion_operator` (`deleteVenueOrderData`); scheduled orphan cleanup (`handleScheduled`, orphans > 2h only) | Post-owner-testing review owned by Adam |
| **3. Derived canonical order rows** | Accepted order lines, batch metadata, checksum conflicts | PostgreSQL `app_private.order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_conflicts` | **UNRESOLVED** (no time-based auto-expiry); deleted only on owner request (`S6-DATA-14.2`) | Owner: Teeyansh; Approver: Vivien (**Pending**), Sai (**Pending**) | `peekaplate_deletion_operator` (`delete_venue_order_data`) | Time-based expiry unresolved |
| **4. Quarantined order rows** | Rejected/quarantined CSV rows (`too_old`, `before_tracking_start`, etc.) | PostgreSQL `app_private.order_outcome_quarantine` | **UNRESOLVED** (no time-based auto-expiry); deleted on owner request (`S6-DATA-14.2`) | Owner: Teeyansh; Approver: Vivien (**Pending**), Sai (**Pending**) | `peekaplate_deletion_operator` (`delete_venue_order_data`) | Time-based expiry unresolved |
| **5. Database backups & restored copies** | Managed Supabase PostgreSQL PITR / snapshots & R2 backups | Managed Supabase & Cloudflare R2 backup layers (outside app runtime) | **UNRESOLVED** (managed provider retention window not verified in repo); post-restore reconciliation via `reconcileOrderDeletionsAfterRestore` | Owner: Sai / Infra; Approver: Sai (**Pending**) | `peekaplate_deletion_operator` (`reconcileOrderDeletionsAfterRestore`) | Provider backup retention periods & staging restore drill remain **Pending** |
| **6. Behavioral observations (browser & index)** | Diner `observation.v2` events (visit/event identifiers such as ephemeral `session_id` retained; no diner PII) | Browser outbox (`indexedDB` / `localStorage`, 24h max age, 500 events / 1 MiB); PostgreSQL `app_private.observation_index` | Browser outbox: 24h max age or immediate clear on withdrawal. PostgreSQL: **13 months (Manual P0 Exception under `S5-DATA-09`; no auto-expiry)** | Owner: Vivien / Adam; Operator: Sai; Checker: Jeffin (conditional) | Diner browser (`clearLivePipeline`); manual `S5-DATA-09` operator (unimplemented) | Visit/event identifiers retained; review after owner testing (Adam) |
| **7. R2 archival of behavioral data** | Raw accepted/quarantined behavioral observation batches | R2 `peekaplate-staging-assets` (`OBSERVATION_ARCHIVE_BUCKET`) | **13 months (Manual P0 Exception under `S5-DATA-09`; no auto-expiry)** | Owner: Sai / Vivien; Operator: Sai; Checker: Jeffin (conditional) | None automated | Shares staging bucket with order imports; manual P0 exception |
| **8. PostHog data & Supabase export** | Allowlisted `observation.v2` properties (event identifiers retained, `person_profiles: 'never'`) | PostHog US project `675372` (staging) & PostgreSQL `posthog_exports` (hourly staging export) | **13 months (Manual P0 Exception; `docs/posthog-export.md` short-retention proposal is not an automated deletion job)** | Owner: Jeffin / Sai; Approver: **Pending** (before real diner data) | None automated | Deletion across PostHog + Supabase copies unimplemented; not owner-report source of truth |
| **9. Canonical behavioral facts & derived outputs** | Aggregated session/dish facts, `owner_observation_v1`, `comparison_report.v1` | PostgreSQL `app_private.observation_facts` & report views/functions | **13 months (Manual P0 Exception under `S5-DATA-09`; no auto-expiry)** | Owner: Vivien / Sai; Approver: **Pending** | None automated | Cohort suppression (< 10 sessions) is statistical privacy, not deletion/withdrawal |

---

## Part 4: Operational Runbook — Owner-Scoped Order-Data Deletion (`S6-DATA-14.2`)

1. **Submitting a Deletion Request:**
   - An authenticated venue owner submits `POST /venues/:venueId/orders/deletion-requests` with `{ "requestId": "<uuid>", "reason": "pilot_withdrawal" | "data_cleanup" | "retention_policy_request" }` (no free-text reason accepted; `account_closure` is excluded until Part 3.F is approved).
   - The endpoint immediately persists `status = 'requested'` (HTTP `202`) in `app_private.order_data_deletion_requests` and blocks any new `importOrderOutcomes` for that venue (`409 deletion_in_progress`).
   - Off-platform owner requests (e.g., email/support) must be routed to the **Manual deletion operator** (*Sai — Approved (Operational)*); no automated support-inbox integration exists.
2. **Identity & Venue Ownership Verification:**
   - The API verifies the caller's Supabase JWT (`services.verify`) and checks `app_private.staff_membership` (`permission = 'owner'`) for `venueId` inside a `SET LOCAL` transaction.
   - `enforce_order_data_deletion_request_insert()` trigger in PostgreSQL independently enforces `app.tenant_id`, `app.actor_id`, `owner` membership, and initial `status = 'requested'`.
3. **Authorized Operator Execution & Allowlist Enforcement:**
   - Execution is **not** exposed as a self-serve HTTP endpoint. Only an authorized internal operator (`operatorId`) runs `deleteVenueOrderData` with a server-controlled `authorizedOperatorIds` allowlist (`ReadonlySet<string>`).
   - `deleteVenueOrderData` fails closed with `403 forbidden` unless `authorizedOperatorIds` is non-empty, `operatorId` is a canonical UUID, and `authorizedOperatorIds.has(operatorId)`. It also requires an existing owner-submitted request (`404 deletion_request_not_found` otherwise).
   - **Allowlist & Identity Blocker:** No personal operator UUIDs are hardcoded in the repository, and no production/staging operator identities are provisioned yet. **Sai** is the **Approved (Operational)** manual deletion operator; before real pilot uploads are enabled, Sai's authenticated UUID must be provisioned in the server-controlled `AUTHORIZED_DELETION_OPERATOR_IDS` / `authorizedOperatorIds` configuration. If the allowlist is empty or unprovisioned, deletion execution remains blocked.
   - **Separation from Independent Checker:** **Jeffin** is the **Independent checker — Approved (Conditional — subject to availability confirmation)**; a **backup checker** is **Pending Adam's confirmation**. Separation of duties is **mandatory**: the checker must never be the requester or the executing operator, and must never be added to `authorizedOperatorIds` merely to verify deletion results.
4. **Exact Storage & Database Deletion Steps:**
   - *Phase 1 (Audit & Fenced Lease):* Acquire `pg_advisory_xact_lock('order_lifecycle:' || venueId)`, lock the `app_private.order_data_deletion_requests` row `FOR UPDATE`, return immediately if already `completed`, reject concurrent executions with `409 deletion_in_progress` if an active `'executing'` lease (`execution_lease_expires_at > now()`) is held, otherwise claim `status = 'executing'` with a fresh `execution_token` (`uuid`), `execution_started_at`, and `execution_lease_expires_at` (5-minute default lease) and collect `storage_key`s from `app_private.order_outcome_import_batches`. This works identically over both direct `pg.Client` sessions and Hyperdrive transaction-mode pooling without session-level locks.
   - *Phase 1b (Durable External Intent):* Write `order-deletion-ledger/<venueId>/<requestId>/intent.json` with `{ requestId, venueId, operatorId, status: "in_progress", intentRecordedAt }` to R2 **before** any destructive operation using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`, so retries never overwrite the original intent; fails closed with `502 deletion_storage_failed` if the intent cannot be persisted).
   - *Phase 2 (R2 Storage & Heartbeat Fencing):* List all objects under `order-imports/<venueId>/` in private R2 storage, union with DB `storage_key`s strictly matching that prefix, and delete each object while renewing `execution_lease_expires_at` conditionally (`WHERE execution_token = $token AND status = 'executing'`). If the lease was lost to a replacement worker, execution aborts immediately with `409 deletion_lease_lost`.
   - *Phase 3 (Fenced PostgreSQL Deletion):* Verify `status = 'executing'` and `execution_token` still match, call `app_private.delete_venue_order_data(venueId, requestId, operatorId, executionToken)` (`SECURITY DEFINER`, owned by privileged role, `EXECUTE` revoked from `PUBLIC` and `peekaplate_runtime`) which re-verifies `execution_token` inside PostgreSQL, enables transaction-local deletion inside a `BEGIN ... EXCEPTION WHEN OTHERS` block that always resets `app.order_data_deletion_active = 'off'`, and deletes `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`, and `order_outcome_import_batches` for `venueId`, then marks `order_data_deletion_requests.status = 'completed'` with `executed_by = operatorId`, clears `execution_token`/`execution_lease_expires_at`, and records exact counts and `completed_at`.
   - *Phase 4 (R2 Deletion Ledger Completion):* Write a separate immutable completion receipt at `order-deletion-ledger/<venueId>/<requestId>/completed.json` with `operatorId`, exact counts, and `completedAt` using atomic create-only conditional write (`onlyIf: { etagDoesNotMatch: '*' }`). Even if the process crashes between Phase 3 DB commit and Phase 4, `intent.json` from Phase 1b is already durable in R2 and `completed.json` is written on retry.
   - *Preserved non-order tables:* `pos_dish_mappings` (venue menu-to-POS configuration) and `venue_tracking_activations` (server-controlled activation timestamp) are intentionally preserved. No derived order-outcome reports, exports, or caches exist.
5. **Two-Person Deletion Verification Procedure:**
   Every executed order-data deletion requires two distinct people:
   - **Operator** (*Sai — Approved (Operational)*):
     1. Receives and validates the owner deletion request (`app_private.order_data_deletion_requests` row or escalated owner request).
     2. Confirms restaurant/venue identity (`venueId`) and deletion scope (all order-outcome R2 objects and derived order-outcome DB rows for that venue).
     3. Executes the authorized deletion via `deleteVenueOrderData` using an operator identity included in the server-controlled `authorizedOperatorIds` allowlist.
     4. Records the deletion outcome and audit details (`requestId`, `venueId`, `operatorId`, object/row counts, `completedAt`, and R2 ledger keys).
   - **Independent Checker** (*Jeffin — Approved (Conditional — subject to availability confirmation); Backup checker: Pending Adam's confirmation*):
     1. Must be a **different person** from the operator who executed the deletion (and must **not** be added to `authorizedOperatorIds` solely to perform verification).
     2. Independently verifies that the requested restaurant's original CSV objects under `order-imports/<venueId>/` in R2 are removed (zero remaining objects).
     3. Independently verifies that the requested restaurant's derived order data (`order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_quarantine`, `order_outcome_conflicts`) is removed (`0` rows for `venueId`).
     4. Confirms other restaurants' data remains untouched (and `pos_dish_mappings` / `venue_tracking_activations` are preserved as expected).
     5. Verifies the deletion audit entry in `app_private.order_data_deletion_requests` (`status = 'completed'`, matching `executed_by`, counts, and `completed_at`) and the R2 ledger (`order-deletion-ledger/<venueId>/<requestId>/intent.json` and `completed.json`).
     6. Records the independent verification result in the canonical verification record (see Section 5a below; `app_private.order_data_deletion_requests` is immutable once `completed` and cannot be updated with checker results).
   - **5a. Independent Verification Record & Least-Privilege Access (*Proposed — Pending Sai/Vivien Approval*):**
     - **Evidence Contract (Four Distinct Signals):**
       1. *Deletion execution status (execution claim only):* `app_private.order_data_deletion_requests` (`status = 'completed'`, `executed_by`, counts, `completed_at`). This row is **immutable once `completed`** via `enforce_order_data_deletion_request_lifecycle()` and has **no** checker-verification columns. A `completed` execution status is **not** independent proof that deletion succeeded.
       2. *R2 deletion evidence:* Full paginated listing of `order-imports/<venueId>/` confirming `0` remaining objects, plus parsed `order-deletion-ledger/<venueId>/<requestId>/intent.json` and `completed.json` matching the PostgreSQL execution audit.
       3. *PostgreSQL deletion evidence:* `0` rows for `venueId` across `order_outcome_import_batches`, `order_outcome_lines`, `order_outcome_quarantine`, and `order_outcome_conflicts`, with `pos_dish_mappings` and `venue_tracking_activations` preserved.
       4. *Independent checker sign-off:* Jeffin's separate `PASS`/`FAIL` verification record linked by `requestId` and `venueId`.
     - **1. Proposed ClickUp Verification Record (*Not yet configured or approved*):**
       - *Location:* One ClickUp task/comment per deletion request (`app.clickup.com/90141746115`), linked by `requestId` and `venueId`.
       - *Required fields:* `requestId`, `venueId`, `operatorId` (Sai), `checkerId` (Jeffin, `<> operatorId`), `verifiedAt` (UTC ISO-8601), `outcome` (`PASS` or `FAIL`), `r2Verification` (R2 evidence summary), `dbVerification` (PostgreSQL evidence summary), and `discrepanciesAndRemediation` (`none` or discrepancy + remediation reference). Never include CSV contents or diner personal data.
       - *Tamper-resistance caveat:* ClickUp tasks/comments preserve author attribution and timestamps, **but they are editable and are not an immutable audit store**. Immutable execution evidence remains `order-deletion-ledger/<venueId>/<requestId>/{intent,completed}.json` in R2 and `app_private.order_data_deletion_requests` in PostgreSQL.
     - **2. Read-Only R2 Verification Worker Endpoint (*Implemented in repo; `CHECKER_HYPERDRIVE` & `ORDER_DELETION_VERIFICATION_BUCKET` bindings pending staging provisioning*):**
       - In [backend/wrangler.jsonc](../backend/wrangler.jsonc), `ORDER_OUTCOME_ARCHIVE_BUCKET` and `ORDER_IMPORT_BUCKET` share `peekaplate-staging-assets` with `OBSERVATION_ARCHIVE_BUCKET` and `INGESTION_REPORTS_BUCKET`, and Cloudflare R2 API tokens support bucket-level rather than object-prefix restrictions. Therefore, Jeffin must **not** receive bucket-wide R2 credentials.
       - *Implemented endpoint:* `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` in [backend/src/index.ts](../backend/src/index.ts) backed by `verifyVenueOrderDeletion` and `OrderDeletionVerificationStorage` (`list` + `get` only; no `put` or `delete`), enforcing `AUTHORIZED_DELETION_CHECKER_IDS` (`checkerId <> requested_by` and `checkerId <> executed_by`), full cursor pagination across `order-imports/<venueId>/`, **zero** CSV body reads, and content validation of `intent.json` and `completed.json`. Fails closed with `503` if `CHECKER_HYPERDRIVE` or `ORDER_DELETION_VERIFICATION_BUCKET` is absent.
     - **3. PostgreSQL Roles `peekaplate_deletion_operator` & `peekaplate_deletion_checker` (*Roles & grants implemented in `20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql`; `LOGIN` credentials & Hyperdrive bindings pending provisioning*):**
       - `peekaplate_runtime` has `EXECUTE` on `app_private.delete_venue_order_data` and `UPDATE` on `app_private.order_data_deletion_requests` **revoked**.
       - `peekaplate_deletion_operator` (`NOLOGIN NOINHERIT`, `NOBYPASSRLS`) owns deletion execution and lifecycle updates; `peekaplate_deletion_checker` (`NOLOGIN NOINHERIT`, `NOBYPASSRLS`) has column-scoped `SELECT` only plus `EXECUTE` on `app_private.record_deletion_verification`. Separate `LOGIN` identities (`peekaplate_operator_login`, `peekaplate_checker_login`) and separate Hyperdrive bindings (`OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`) must be provisioned in staging/production without inheriting `peekaplate_runtime`.
       - Every verification query runs in a transaction with `SET LOCAL app.tenant_id = '<venueId>'` and a bounded `statement_timeout`. Jeffin must **never** be added to `authorizedOperatorIds`.
     - **4. Cross-Tenant Preservation Verification (Synthetic Staging Baseline Test):**
       - Create a `target` venue and a separate `control` venue in staging, and capture baseline aggregate counts (R2 objects under `order-imports/<venueId>/`, `order_outcome_*` row counts, `pos_dish_mappings`, and `venue_tracking_activations`) for both.
       - Execute deletion **only** for `target`, then verify: (a) `target` order data is `0`, (b) `target` preserved configuration (`pos_dish_mappings`, `venue_tracking_activations`) matches baseline, and (c) `control` venue R2 and database counts remain unchanged.
       - Return only aggregate counts or `PASS`/`FAIL` booleans; **never** expose control tenant IDs or row contents to the checker.
6. **Failed Deletion Recovery, Retry & Partial Deletion Handling:**
   - **1. What Causes a Deletion to Fail:**
     - *Phase 1b (`ledger_intent_failed`):* Creating `order-deletion-ledger/<venueId>/<requestId>/intent.json` fails -> transitions `executing -> failed` (`502 deletion_storage_failed`).
     - *Phase 2 (`r2_delete_failed`):* Any R2 `list` (including fail-closed truncated-without-cursor or repeated-cursor pagination) or `delete` fails -> transitions `executing -> failed` (`502 deletion_storage_failed`). PostgreSQL batch rows (`storage_key`s) are **not** deleted so retries still have all `storage_key`s.
     - *Phase 3 (`db_delete_failed`):* `app_private.delete_venue_order_data(...)` fails -> DB transaction rolls back, request transitions `executing -> failed` (`500 deletion_db_failed`).
     - *Phase 4 (`ledger_receipt_failed`):* Writing `completed.json` fails after Phase 3 DB purge -> request remains in `status = 'db_deleted'` (`502 deletion_storage_failed`).
     - *Lease loss (`409 deletion_lease_lost`):* Heartbeat renewal or Phase 3 fence check detects `execution_token` was superseded -> aborts before Phase 3 DB mutations.
     - *Verification failure:* Checker records `FAIL` (or `verifyVenueOrderDeletion` rejects `PASS` with `409 verification_precondition_failed` when `r2Remaining > 0`, `dbRemaining > 0`, or `!ledgerValid`) -> request remains in `awaiting_verification`.
   - **2. Why Imports Remain Blocked:**
     - `importOrderOutcomes` rejects imports whenever any `app_private.order_data_deletion_requests` row for `venueId` has `status <> 'verified'` (`409 deletion_in_progress`), **including `failed`, `db_deleted`, and `awaiting_verification`**.
     - `importOrderOutcomes` also captures `deletion_epoch` in Tx 1 and revalidates it in Tx 2 under `order_lifecycle:${venueId}` so concurrent in-flight imports are fenced out and clean up their uploaded R2 CSV.
     - Owners **cannot** cancel, delete, or reset a deletion request to bypass import blocking (`DELETE`/`TRUNCATE` are blocked by trigger; `peekaplate_runtime` has `UPDATE` revoked).
   - **3. Who Investigates a Failed Request:**
     - **Sai** (approved deletion operator) investigates `app_private.order_data_deletion_requests` (`status`, `error_code`, `execution_started_at`, `execution_lease_expires_at`) and R2/PostgreSQL/Worker logs, coordinating with **Jeffin** (conditional independent checker) when verification fails.
   - **4. Who Is Authorized to Perform Recovery:**
     - Only an **authorized deletion operator** (Sai, in `AUTHORIZED_DELETION_OPERATOR_IDS`, connecting via `OPERATOR_HYPERDRIVE` / `peekaplate_deletion_operator`). Never the venue owner, never `peekaplate_runtime`, and never the same person who will verify the request as checker.
   - **5. How the Deletion Is Retried or Reconciled:**
     - `enforce_order_data_deletion_request_lifecycle()` permits `failed -> executing` for `peekaplate_deletion_operator`.
     - After resolving the root cause (e.g., R2/DB transient outage) and waiting for any active lease (`execution_lease_expires_at`) to expire, the operator re-invokes `deleteVenueOrderData` with the **same `requestId` and `venueId`**:
       - From `failed`: transitions `failed -> executing`, clears `error_code`, claims a fresh `execution_token`, preserves existing `intent.json` (`putCreateOnly` ignores already-exists), re-runs R2 deletion + Phase 3 DB deletion + Phase 4 `completed.json` -> `awaiting_verification`.
       - From `db_deleted`: skips R2/DB purge and retries Phase 4 `completed.json` -> `awaiting_verification`.
       - If verification failed in `awaiting_verification` due to residual data or ledger mismatch, remediate via operator reconciliation/forward corrective migration before re-running verification.
   - **6. How the Independent Checker Verifies Completion:**
     - Once the request reaches `awaiting_verification`, the independent checker (Jeffin, `<> requested_by` and `<> executed_by`, or confirmed backup checker) calls `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` (`CHECKER_HYPERDRIVE` + `ORDER_DELETION_VERIFICATION_BUCKET`) with `outcome: "PASS"` and `evidenceRef`.
   - **7. How the Request Reaches `verified`:**
     - `verifyVenueOrderDeletion` independently confirms `r2RemainingObjectCount === 0`, `dbRemainingRowCount === 0`, and `ledgerValid === true`, then calls `app_private.record_deletion_verification(...)` (`peekaplate_deletion_checker`), transitioning `awaiting_verification -> verified` and unblocking future imports (subject to the unresolved `pilot_withdrawal` re-acceptance decision in Part 3.B).
   - **8. Audit Records Retained:**
     - `app_private.order_data_deletion_requests` (immutable once `verified`), `app_private.restore_reconciliation_runs`, and `order-deletion-ledger/<venueId>/<requestId>/{intent,completed,reconciled}.json` retain `requestId`, `venueId`, `requested_by`, `executed_by`, `verified_by`, bounded `reason`, `status`, object/row counts, `error_code`, `verification_outcome`, `verification_evidence_ref`, and timestamps. **Zero** CSV contents, order lines, or diner data are retained.
   - **9. If Recovery Cannot Be Completed:**
     - Imports remain **permanently blocked** (`409 deletion_in_progress`) for that venue — fail-closed by design.
     - Escalate to **Sai** (Security / Deletion Operator) and **Vivien** (Product) to diagnose the underlying R2/PostgreSQL/ledger discrepancy and execute a forward corrective migration or authorized operator reconciliation. Never bypass two-person verification or mark `verified` without independent evidence.
8. **Backup / Restore Handling & Reconciliation:**
   - Managed PostgreSQL/Supabase PITR snapshots and R2 backups are outside application runtime control. Before exposing restored database traffic, operators must activate `app_private.system_gates('order_imports_restore_freeze') = true` (which fails closed with `503 restore_reconciliation_pending`) and run `reconcileOrderDeletionsAfterRestore` ([backend/src/order-ingestion/restore-reconciliation.ts](../backend/src/order-ingestion/restore-reconciliation.ts), CLI entry point [scripts/reconcile-order-deletions-after-restore.mjs](../scripts/reconcile-order-deletions-after-restore.mjs)) using `OPERATOR_DATABASE_URL` (`peekaplate_deletion_operator`).
   - Reconciliation cursor-paginates `order-deletion-ledger/`, validates JSON schemas and `(venueId, requestId)` provenance, purges resurrected R2 CSVs and DB rows (including snapshots predating the deletion request row via `app_private.reconcile_venue_order_deletion`), keeps `intent_only` and anomalous venues blocked, writes `reconciled.json` + `restore_reconciliation_runs`, and lifts the global freeze only when zero anomalies occur. Staging restore drill sign-off remains *Pending*.
9. **Communicating Completion to the Owner:**
   - API callers receive HTTP `202` (`status: "requested"`) upon request submission. The approved policy SLA is **acknowledge receipt within 5 business days** and **delete live data within 30 days** (backups age out per provider schedule), with **Sai's operational response/confirmation still outstanding** along with manual notification templates/channels.
10. **Excluded Scope (`S5-DATA-09`):**
    - Diner behavioral events are **not** deleted by this workflow; they belong to `S5-DATA-09` (13-month retention target under a manual P0 exception; visit and event identifiers retained; manual deletion by restaurant/venue, time window, or retained identifiers; no automated workflow exists).
11. **Staging Infrastructure Dependencies & Pre-Pilot Verification Checklist:**
    - **Staging Configuration Status:** Staging bindings are **not** included in PR #166 (`backend/wrangler.jsonc` is unchanged). Without these bindings, `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` fails closed with **HTTP `503`**.
    - **Required Bindings & Secrets (Follow-Up Provisioning):**
      - `OPERATOR_HYPERDRIVE` (Hyperdrive binding -> `peekaplate_operator_login` with `peekaplate_deletion_operator` role; never `peekaplate_runtime`).
      - `CHECKER_HYPERDRIVE` (Hyperdrive binding -> `peekaplate_checker_login` with `peekaplate_deletion_checker` role; column-scoped `SELECT` + `record_deletion_verification` only).
      - `ORDER_DELETION_VERIFICATION_BUCKET` (read-only R2 binding `list` + `get` on `peekaplate-staging-assets` for the verification route).
      - `AUTHORIZED_DELETION_OPERATOR_IDS` (Worker secret: comma-separated canonical UUIDs for approved operators — Sai).
      - `AUTHORIZED_DELETION_CHECKER_IDS` (Worker secret: comma-separated canonical UUIDs for independent checkers — Jeffin + backup checker once named; disjoint from operators).
      - CLI restore-reconciliation env (injected at operator run time only, never bound to runtime Worker): `OPERATOR_DATABASE_URL`, `RECONCILIATION_OPERATOR_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
    - **Migration & Deployment Prerequisites:**
      - Apply both `migrations/20261113120000_pilot_order_agreement_and_deletion.sql` and `migrations/20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql` in staging before deploying the updated Worker.
      - Provision `peekaplate_operator_login` and `peekaplate_checker_login` PostgreSQL `LOGIN` roles (`NOINHERIT`, not members of `peekaplate_runtime`), bind Hyperdrives + `ORDER_DELETION_VERIFICATION_BUCKET`, and set operator/checker allowlist secrets.
    - **Validation & Rollback Considerations:**
      - Run synthetic staging E2E deletion (target vs. control venue), verify `intent.json` / `completed.json` ledger writes, verify `POST /internal/venues/:venueId/orders/deletions/:requestId/verify` `PASS`, and complete a post-restore reconciliation drill (`scripts/reconcile-order-deletions-after-restore.mjs`).
      - *Rollback:* `20261114010000_harden_s6_data_14_deletion_and_reconciliation.sql` intentionally blocks `-- migrate:down`; any schema rollback requires a forward corrective migration.
    - **Checklist:**
      - [x] Verify both migrations (`20261113120000` and `20261114010000`) and integration tests against real local PostgreSQL (and CI `database` job on PostgreSQL 16.11 + pgTAP).
      - [ ] Apply both migrations in staging and provision `OPERATOR_HYPERDRIVE`, `CHECKER_HYPERDRIVE`, `ORDER_DELETION_VERIFICATION_BUCKET`, `AUTHORIZED_DELETION_OPERATOR_IDS`, and `AUTHORIZED_DELETION_CHECKER_IDS`.
      - [ ] Verify synthetic staging E2E deletion, two-person verification (`POST /internal/.../verify`), cross-tenant preservation, and post-restore backup reconciliation drill.
      - [ ] Obtain Vivien (Product) and Sai (Security) formal approvals, confirm Jeffin's availability + Adam's backup checker, obtain Sai's SLA/owner-report-source confirmation, and resolve post-`pilot_withdrawal` re-acceptance (Adam/Vivien).
