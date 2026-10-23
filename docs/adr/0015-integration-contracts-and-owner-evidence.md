# 0015 — Integration contracts and owner-evidence boundary

Status: Proposed · 2026-10-21, revised 2026-10-23 after Sai's review · Owner: Jeffin (S3-ARC-01) · Approver: Sai · PM boundary approval: Adam, Shirley, Vivien

Relates to [0002](0002-selective-event-sourcing.md), [0003](0003-intent-evidence.md), [0005](0005-tenancy-and-privacy.md), [0006](0006-orders-and-measurement.md), [0013](0013-posthog-export-boundary.md) and [0014](0014-team-analytics-access.md). It supersedes none of them.

## Context

Sprint 3 work needs shared, versioned data shapes before it can integrate: diner screens (S3-DIN-01/02), publication APIs (S3-RES-02), menu ingestion (S3-VIS-01), event capture (S3-DATA-01) and owner reporting (S3-DATA-02). The S3-DATA-01 event-field matrix (v0.1d) proposes event meanings and fields and lists the decisions this record must settle.

`packages/contracts` defines the staff dish-revision command/result, a v1 diner event limited to `dish_open` and `portion_compare`, and the team analytics query/response. `packages/analytics` sends consented, privacy-filtered `app_shell_viewed` observations directly to PostHog; its dish-event capture has no caller and makes bounded at-most-once attempts. ADR 0013 copies those observations hourly into `analytics_private.posthog_events`, and ADR 0014 lets collaborators inspect that copy. Neither provides restaurant-authorized evidence. No canonical observation endpoint, outbox, observation tables or owner-report API exist. The staging Worker has no Queue or R2 binding, and no menu token can be issued until publication exists (S3-RES-02).

Draft work disagreed with accepted decisions: a report query used five sessions instead of ADR 0006's ten, and a direct backend → Supabase ingestion route was proposed instead of ADR 0003's Queue and R2 boundary. Both are resolved below.

## Decision

**Contracts.** `packages/contracts` owns strict, versioned Zod schemas for six integration contracts: dish draft, source evidence (URL/PDF/photo), review and publication, approved asset, diner observation and owner report. Each includes its missing, rejected, withdrawn, loading and error states where they apply. A breaking change adds a new version; it never relabels an existing one. Unknown fields are rejected. No contract field grants restaurant authority. Each contract ships with valid examples and negative tests.

**Owner evidence.** Owner-facing metrics come only from validated canonical facts on the ADR 0003 path: browser outbox → ingest Worker → Queue receipt → R2 archive → canonical Supabase facts → backend membership check → owner report. A direct backend → Supabase route that skips Queue or R2 is not adopted; proposing it requires a superseding ADR that restates durability and recovery. The ADR 0013 export remains internal reconciliation only: the canonical path never writes to it and owner reports never read it.

**Event identity.** As in ADR 0003, the transport key is `(venue_id, event_id)`. The browser creates `event_id` once per observation and keeps it and the payload on every retry. `venue_id` is derived on the server from the signed menu token, never accepted from the browser. The same key with the same canonical checksum is a retry; the same key with a different payload is quarantined, never overwritten. Semantic keys prevent double counting of one opening, activation, comparison version or opportunity. Genuine repeated actions receive new action identities. When a consented PostHog copy is sent, it carries the same `event_id`. Reconciliation compares the matching consented cohort after consumer and export processing and explains any gaps; optional PostHog capture cannot guarantee that the two ID sets are always equal. PostHog's `(team_id, uuid)` collapse only removes repeated export copies; it does not prove browser-action idempotency.

**Storage.** Canonical observations go to new tables in the existing private `app_private` schema, created by forward migrations, protected by RLS and written only by the restricted runtime role.

- The canonical storage names are `app_private.observation_index` and `app_private.observation_conflict`.
  - The index is keyed by `(venue_id, event_id)` and holds the checksum, schema version, type, authorized references, client `occurred_at`, server `received_at`, R2 archive key and disposition.
  - The conflict table holds quarantined conflicting reuse.
- `observation_<family>_fact` is a naming pattern, not a finished schema. Jeffin and Louis pin the actual typed fact and view names and the field mapping in the contract and migration PR.
- Owner reports read bounded views over those facts, never the raw index. Tenant restrictions apply to the views and functions as well as their underlying tables.

Nothing is created or changed by hand in a hosted database.

**Privacy and reporting (D1 resolved).** Vivien confirmed that production keeps ADR 0006's floor: suppress behavioral cells below ten eligible sessions, including totals, filters, differences and drill-downs that could reconstruct them. Five-session fixtures are labelled internal and synthetic only; production boundary tests cover 9, 10 and 11 sessions. Lowering the floor would require a superseding ADR with a privacy rationale and accountable approval. Payloads exclude names, emails, full URLs, raw table labels, search text, fingerprints and credentials. PostHog receives only properties approved in the event-field matrix, behind the existing consent and Do Not Track/Global Privacy Control checks. Owner reports are served by the backend after verifying current restaurant membership. Analytics and collection failure never block the menu. Viewing, saving, comparing or opening ingredients is recorded as interest, never as an order or causal proof.

**Metrics (D7).** Use Vivien's session-based rates. For one dish, venue and reporting window:

- `X` is the set of eligible exposed visits.
- `O` is the set of visits with a successfully displayed readable detail; a successful detail display counts as an opening.
- `G` is the set of opened visits containing an opening with at least ten visible active seconds, or its qualifying linked displayed comparison.

The rates are:

- open rate = `|O ∩ X| / |X|`;
- engagement rate = `|G| / |O|`;
- Save rate = `|saved visits ∩ X| / |X|`, once Save scope is confirmed.

An anonymous visit is not a person. Save is separate: it never creates an opening or engagement on its own. Direct or comparison entry never invents a card exposure. Opening-action counts stay separate from visit-based rates. A zero denominator returns null with an explicit not-measurable status. The privacy floor applies to every rate. A median active time needs its visit/dish aggregation and incomplete-timing rules pinned first; the per-opening mean is not a substitute.

**Timing (D8).** A new visit starts after 30 minutes of inactivity. Active time pauses after 30 seconds without qualifying activity, and checkpoints are sent every five active seconds. Only visible, foreground detail or preview time counts; hidden, picker and menu time does not. The planned per-opening cap, pause/resume rules and timing coverage are kept. Checkpoints are cumulative: use the greatest valid value, never their sum.

**Versioning (D6).** New controls use `observation.v2`, whose event semantics Adam approved; this record provides the architecture approval. Historical v1 records (`dish_open`, `portion_compare`) stay distinct and are not relabelled, and no observation is sent twice under two versions.

**Route and receipt (agreed by Jeffin and Zhiliang; boundaries supported by Sai).** The ingest route is `POST /observations`. It is named for observations rather than events because AGENTS.md keeps staff domain events (`app_private.es_event`) and PostHog events separate from diner intent observations.

The menu token travels only as `Authorization: Bearer <menu_token>`, never in the JSON body or URL. The Worker verifies it and derives `venue_id` and the authorized publication context from it; a browser-supplied venue value never grants authority.

The body is a strict, bounded batch of `observation.v2` items. Each item has `schema_version`, `event_id`, `session_id`, `producer_id`, `local_sequence`, `occurred_at`, `type`, publication and content references, and only its type's fields. The response holds one receipt entry per item:

- `accepted` only after the Queue has durably accepted the item. This means durable Queue acceptance, not that a reportable database fact already exists. An identical retry of a previously accepted item is also `accepted`, with `reason_code=duplicate_same_payload`.
- `retry` for a Queue outage or other transient failure. The browser keeps the item and resends the same `event_id` and payload.
- `rejected` with a bounded reason code for permanent failures, which are never retried. The same `event_id` with a changed canonical payload is `rejected` with `reason_code=event_id_conflict`, and the item is quarantined.

**Outbox and failure handling:**

- **Accepted:** the browser removes only accepted IDs from its outbox.
- **Rejected:** a rejected item leaves the active retry queue through a bounded terminal disposition. It is never retried and never holds pending capacity indefinitely.
- **Uncertain or transient:** unknown delivery, timeouts and transient failures keep the same `event_id` and payload for a later retry.
- **Partial batches:** a partial failure returns mixed entries, never a blanket success.
- **Uncertain Queue sends:** an item whose Queue send was not confirmed is returned as `retry`, never `accepted`, even if the message may have been enqueued; the consumer deduplicates any second copy.
- **Oversized requests (`413`):** a request over 25 items or 32 KiB returns `413`.
  - The browser splits the batch in half and resends each half. Splitting stops at a single item, so it takes at most five levels.
  - A single item that still returns `413` leaves the active retry queue with the terminal local disposition `payload_too_large` and is never retried.
- **Invalid envelopes (`400`):** `400` is reserved for an envelope that cannot be read as a batch, such as malformed JSON or a missing item list. Per-item schema problems return `200` with `rejected` and `schema_invalid` instead.
  - On `400`, the browser does not resend that batch. Its items leave the active retry queue with the terminal local disposition `client_invalid`.
  - Only aggregate counts of `payload_too_large` and `client_invalid` are kept, never the raw payloads.
- **Duplicate IDs within one batch:**
  - The Worker enqueues each `event_id` at most once per request.
  - An identical repeat receives the same disposition as its first copy, with `reason_code=duplicate_in_batch`.
  - Copies of one `event_id` with different payloads in the same batch are all `rejected` with `event_id_conflict` and quarantined.

**Ingest limits (agreed by Jeffin and Zhiliang, review item 3).** These start from the implementation plan's collection table and are frozen before ingestion is connected:

- **Request:** at most 25 items and 32 KiB per request.
- **Browser outbox:**
  - at most 500 pending events or 1 MiB, retained for at most 24 hours, evicting the oldest predictably;
  - flushes on a 5-second timer, on a full batch and on visibility loss;
  - retries with exponential backoff and jitter, capped at 60 seconds.

  These are client safeguards; the server enforces its own limits independently.
- **Time:** an item is rejected with `too_old` when `occurred_at` is more than 24 hours old at first receipt, and with `future_time` when it is more than 5 minutes in the future. Queue work that was already accepted may finish later and is never reclassified as expired.
- **Rate limit:**
  - a token bucket keyed by the menu token's `jti`, at 60 requests per minute with a burst of 10; normal 5-second flushing is about 12 requests per minute;
  - IP address is not the key, because shared venue networks would cause false throttling and IP is an unnecessary privacy identifier;
  - a throttled request returns `429` with `Retry-After`. The browser keeps the whole batch with the same IDs and payloads and retries within the capped backoff. No receipt on a `429` implies Queue acceptance.
- **HTTP status codes:**
  - `200` with per-item receipts, including mixed results;
  - `400` for an invalid envelope;
  - `401` for a missing, invalid or expired token;
  - `403` for a token outside its venue, publication or scope;
  - `413` (`body_too_large`) for more than 25 items or more than 32 KiB;
  - `429` for rate limiting;
  - `503` when the Queue is wholly unavailable.

  A non-`200` response carries no per-item receipts and never implies Queue acceptance.
- **Rejected reason codes:** `schema_invalid`, `unknown_type`, `too_old`, `future_time`, `publication_not_allowed` and `event_id_conflict`. `duplicate_same_payload` and `duplicate_in_batch` accompany `accepted` or the first copy's disposition; they are not rejections.
- **Menu-token claims:** venue, publication, scope `observations`, `iat`, `exp` (30 minutes) and a unique `jti`. Renewal verifies the original allowed exposure and never relabels the publication of unsent events.

The endpoint can return `duplicate_same_payload` or `event_id_conflict` only when it already knows the earlier copy. A retry that arrives before the Queue consumer has indexed the first copy may be accepted and queued again, so these reason codes are best effort. The consumer is the final guarantee: it drops identical repeats and quarantines conflicting reuse in `app_private.observation_conflict`. The tests that expect `POST /events` to return 404 are replaced by tests of this route when it is implemented.

**Infrastructure.** Reuse the existing private staging R2 bucket for the archive. Create and bind a staging Queue with a dead-letter queue. The pipeline order is Worker → Queue → create-only R2 archive → idempotent Supabase facts → individual Queue acknowledgement. Vivien and Sai own the protected staging bindings, which are not complete yet. A local synthetic token and Queue harness can proceed meanwhile, without representing a published menu. Bindings, secrets and the menu-token signing key are configured by authorized operators through the protected setup, never committed to Git. The menu token cannot be issued until publication exists (S3-RES-02).

**Ownership.**

- **Ingest endpoint: Zhiliang (S3-DATA-01), approved by Sai.** Scope is the HTTP ingestion boundary only:
  - request and schema validation;
  - server-authorized venue context;
  - `(venue_id, event_id)` handling, plus duplicate and conflicting-reuse behavior;
  - consent and privacy checks;
  - receipts.

  It feeds the Queue and never writes to the ADR 0013 export tables.
- **Queue consumer: Teeyansh.** Archive to R2 first with a create-only key, then write the index and facts idempotently, then acknowledge the Queue. Failed batches go to the dead-letter queue.
- **Review:** Jeffin and Sai review the architecture and security of both.
- **Canonical migrations and tables: Jeffin.** Forward-only migrations in `migrations/` for the `app_private.observation_*` tables and report views, with RLS, restricted-role grants and pgTAP tests in `tests/db/`. Each migration is tested from an empty database and from the previous schema.
- **Owner-report API: Louis (S3-DATA-02).** Bounded, typed report endpoints over the canonical views. Each verifies current restaurant membership on the server before reading, and applies the suppression floor, including totals, filters and drill-downs that could reconstruct a suppressed cell.

**Merge order.**

1. This ADR and the contracts.
2. Migrations, views and the consumer, alongside the diner controls (S3-DIN-02) and ingest/capture (S3-DATA-01).
3. Connecting the approved controls to the complete, tested pipeline.
4. Live owner reports (S3-DATA-02), which follow validated facts.

Fixtures and report scaffolding continue in parallel throughout.

## Status of remaining work

**Resolved in review:**
- D1 (ten sessions), D5 (Queue and R2 path), D6, D7 and D8, the route, and the canonical index/conflict names;
- the ingest limits (review item 3, agreed with Zhiliang);
- `400`/`413` handling (above).

**D3/D4 scope:** the approved event rows are Adam's decisions in matrix v0.1d. Implement exactly those rows, with `dish_compared` replacing `portion_compare`. Restaurant Save/Discover stays out. Save never creates an opening or engagement on its own.

### Decision still needed for ADR acceptance

1. **Save/UI confirmation from Harshita (S3-DIN-02 DRI); Adam accepts the semantics.** For the Save controls as implemented, confirm:
   - the success transition: `dish_saved` or `dish_unsaved` fires only after the local storage write commits and the visible state changes, and never on render, a no-op or a failed or rolled-back write;
   - persistence: the storage mechanism, and whether Save survives a reload in the same browser;
   - unsave and Undo behaviour;
   - what the diner sees, and what is recorded, when browser storage is unavailable;
   - any Saved limit.

   Any remaining Save/selection disagreement, including the older "open OR Save" wording, is recorded rather than inferred as approval.

### Implementation and release prerequisites (later PRs, with owners)

These do not block accepting this record; each lands in its own PR or release gate.

| Prerequisite | Owner |
| --- | --- |
| `observation.v2` and the other contract schemas, with negative tests | Zhiliang, reviewed by Jeffin and Sai |
| Ingest endpoint on `POST /observations` | Zhiliang |
| Queue consumer: create-only R2 archive, idempotent facts, dead-letter queue | Teeyansh |
| Migrations, fact and view names, and the field mapping | Jeffin, with Louis |
| Owner-report API; median active-time aggregation and incomplete-timing rules | Louis, with Vivien |
| Protected staging secrets, Queue, dead-letter queue and R2 bindings | Vivien and Sai |
| Menu-token issuance | S3-RES-02 publication owners |
| Retention and pilot consent policy (ADR 0005's 30 days is still a proposal) | Vivien, with the venue |
| Hosted ingestion, recovery and reporting validation before release | Sai (release review) |
| Reviewer hours recorded per PR | Each owner |

## Consequences

Owner metrics stay restaurant-scoped and reproducible, while the team keeps PostHog for exploratory analysis. The Worker, Queue, R2 and Postgres path must still be built; PostHog does not replace it. Real collection and live reports wait for this ADR to be accepted, but synthetic work does not. Two destinations mean two retention and deletion responsibilities.

## Verification

Contracts: valid and invalid examples for all six, including unknown fields and injected authority. Observations: a Queue send failure returns `retry`, never `accepted`; an unconfirmed Queue send returns `retry`; duplicate and conflict receipt tests separate an already-indexed first copy (`duplicate_same_payload` or `event_id_conflict`) from the pre-index race, where another Queue-accepted receipt is valid and the consumer still deduplicates or quarantines; identical and conflicting duplicates within one batch; a rejected item leaves the outbox retry queue; a request over 25 items or 32 KiB returns `413` and is split down to single items, then marked `payload_too_large`; a `400` envelope is not resent and is marked `client_invalid`; Save emits only on a committed storage write with a visible state change; items exactly at and just beyond the 24-hour and 5-minute edges; a `429` returns `Retry-After`, keeps the whole batch and carries no acceptance; the rate limit applies per token `jti`, not per IP; a body or header venue is ignored in favour of the token; repeated send, partial receipt, offline reload, same ID with a different payload (quarantined), forged venue (rejected), and consent off or analytics disabled (no PostHog request; menu still usable). Consumer: a crash after the R2 write but before the acknowledgement creates no duplicate rows, and failed batches reach the dead-letter queue. False successes: pointer-down, render-only, failed detail, picker cancel and failed comparison produce no success event. Reconciliation: for a synthetic run, the matching consented cohort is compared after consumer and export processing, and every gap is explained. Reports: nine-session cells are suppressed while ten- and eleven-session cells are shown; a zero denominator returns not-measurable; checkpoint time uses the greatest valid cumulative value; suppressed cells cannot be reconstructed, another restaurant's data is denied and withdrawn content is not shown as current. Publication: unauthorized approval fails and two concurrent publishes cannot both succeed.
