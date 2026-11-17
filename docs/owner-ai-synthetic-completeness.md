# Sealed scripted owner-AI scenario

This staging-only path verifies completeness of one operator-sealed synthetic scenario. It does not establish freshness of live diners, Queue delivery generally, or the entire observation pipeline. Reports retain `source: synthetic`; ordinary reports and missing, invalid or expired seals retain unknown freshness. Privacy suppression, current owner authorization, signed displayed-report references and provider limits remain unchanged.

## Operator authority and proof

`OWNER_AI_SYNTHETIC_COMPLETENESS_SEAL` is protected server configuration, accepted only by staging wiring. Browser requests cannot create a seal or submit metrics. The operator must first reconcile the **actual** authorized canonical ingress/Queue, create-only R2 archives, accepted index and typed facts against an immutable manifest of the complete scripted producer set. Counts alone, a quiet Queue, a local expected report, a recent timestamp or an arbitrary digest are insufficient. Reuse the canonical path in accepted ADR 0003; no direct fact insertion or historical receipt fabrication is authorized.

The operator closes all scripted producers and verifies every actual archive's identity, canonical checksum, publication and payload-to-typed-fact mapping. The private reconciliation artifact must explain all retries and gaps, establish no unresolved producer work and preserve actual server receipt times. Its SHA-256 is `archive_proof.reconciliation_sha256`. This digest is a trusted operator assertion about a real artifact; the API cannot infer archive verification from a hexadecimal string. No such hosted artifact or acceptance is established merely by this implementation.

The compact strict JSON seal contains:

- `version: 1`, `kind: sealed_scripted_scenario`, `venue_id`, `publication_revision_id`, `manifest_sha256`, `event_count` (1–1000).
- `index_sha256`, `facts_sha256`: use `syntheticEvidenceDigests` on rows returned by `SYNTHETIC_EVIDENCE_QUERY` for the exact venue and current half-open 24-hour window. The helper sorts event IDs and hashes canonical JSON. The index digest includes every full index row; the fact digest includes every envelope and complete typed detail row. The operator must compare this projection to the real archived payloads before sealing it.
- `producer_closed_at`, `sealed_at`, `expires_at`; expiry is at most 15 minutes after sealing. All events must already precede producer closure; actual receipts must precede archive verification.
- `archive_proof: {kind: operator_verified_create_only_r2, verified_at, reconciliation_sha256, index_sha256, facts_sha256}`. The proof's set hashes must equal the sealed hashes. Closure ≤ archive verification ≤ sealing ≤ report anchor ≤ actual validation clock < expiry.

Keep artifacts private and immutable. Do not configure the seal if archives are unavailable or producer closure is unproven. Revoke the configuration before archive deletion/retention changes or other invalidation. This short-lived attestation establishes archive verification **at `verified_at`**, not continuous R2 availability; runtime does not contact R2. Operators must accept that explicit boundary when enabling this scripted scenario.

## Runtime checks and clock

After current owner membership and tenant scope are established, report metrics, summary and evidence are read in one repeatable-read, read-only transaction. The verifier includes every in-window index row, including rejected or unprojected rows, rather than hiding extras through the reporting view. It requires the exact count and both set digests, accepted test-class envelopes, matching publication/tenant/event identities, exactly the correct typed family, deterministic archive keys, and no tenant conflicts. Missing/extra/late/changed facts, pending projections, wrong traffic or expired proof leave freshness unknown. Identical retries preserve the set. An event leaving the rolling window changes the set and invalidates it.

The existing GET window end, report generation and JWT issue time remain current. POST reconstructs the displayed report at its signed anchor, while seal expiry uses the **actual wall clock**, never that frozen anchor. A changed freshness state changes the report digest and rejects the old reference before any model request. The original 60-second reference expiry remains enforced. Only the sealed synthetic evidence scope may yield `is_stale: false`; this is no general pipeline watermark.

## Acceptance boundary

Unit tests cover exact success, missing/extra/conflicting/index/typed/proof/tenant/class/publication errors, clocks, expiry, current membership and reference expiry. The real PostgreSQL integration uses the existing consumer and an explicitly fake local R2 archive to exercise actual restricted-role SQL and exact retries; it is not hosted archive or provider evidence. Hosted positive acceptance still requires a valid authorized synthetic publication, canonical import, actual private archive reconciliation artifact, protected operator seal, usable privacy-safe dish evidence and approved provider-call budget. Without those proofs, abstention is the correct result.
