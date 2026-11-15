# Pilot Order Outcome Synthetic Handoff Fixture (v1)

This directory contains version-controlled synthetic data fixtures establishing the contract boundary between DATA-07 (Controlled Pilot Order-Outcome Import) and downstream consumers (DATA-08 / AI recommendation and evaluation workflows).

## Boundaries and Invariants

1. **Synthetic Identities Only**: All IDs (`tenant_id`, `batch_id`, `order_id`, `dish_id`, etc.) are purely synthetic test identifiers. Never populate this fixture with real customer orders, real POS identifiers, or private venue credentials.
2. **Unlinked Outcomes by Default**: Accepted import rows are persisted to `app_private.order_outcome_lines` and remain strictly **unlinked** (`linkage_status: "unlinked"`) until explicit matching diner exposure/session evidence is established by consumer workflows.
3. **No Inferred Conversions**: The presence of an accepted order outcome never automatically implies a diner conversion. Ingestion does not generate synthetic diner visits, observations, or conversion metrics.
4. **Quarantine Transparency**: Malformed rows, unreviewed POS mappings, or rows outside the active publication/tracking window are quarantined with full audit provenance in `app_private.order_outcome_quarantine`. Diagnostics never leak sensitive or prohibited values.
5. **No Production Metrics Contamination**: Imported pilot order outcomes are isolated from existing owner report views and interaction event streams until explicit matching evidence exists.
