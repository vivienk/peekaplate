# 0017 — Quest discovery and unpaid pickup requests

Status: Proposed · 2026-11-14 · User-requested implementation; release review pending

## Context

The user requested Quest visitors to discover Noka Ramen, Son & Garden and Farmhouse Kitchen on a map, browse dishes and submit orders without payment. This extends the original single-venue browsing scope. It does not replace ADR 0006 POS outcomes or claim paid sales.

## Decision

Keep discovery behind DEV/PR-preview or explicit VITE_DINING_ENABLED. Quest home opens the directory; phone and direct venue/menu routes retain their entry. A shareable experience=quest query enables desktop review. Public addresses/coordinates come from the named brands' official sites; these directory entries convey neither publication approval nor ordering authority.

The receiving backend is separately disabled by default. An operator must bind each slug to a real venue/menu and a reviewed catalog for its current published revision. Server reads lock the registry/catalog/current publication. Unknown, withdrawn or disabled locations cannot receive new requests. Catalog data cannot be supplied by the browser. Requests accept identities and bounded quantities, not prices. The server prices the request in integer cents.

A guest command UUID provides high-entropy idempotency identity scoped to the resolved venue. A new order begins at expected version zero, creates version one, and atomically writes event, projection, command result and outbox. Pure replay reconstructs the order without effects. The response is submitted/unpaid, never paid or restaurant-accepted. An authenticated, membership-checked staff inbox API receives requests. Restaurant acceptance UI, POS dispatch and payments are not implemented by this slice.

## Consequences and verification

Preview has no receiving API and must show unavailable, not a fabricated receipt. Operator activation requires a migrated database, rate-limiter binding, trusted API routing/CORS, reviewed menus and staff receiving integration. No live credentials, owner bindings or published Noka menu IDs are inferred from public websites. Tests cover contracts, pricing, duplicates, rollback, membership, cart retry and browser transitions; PostgreSQL/RLS/concurrency and physical Quest acceptance are distinct gates. This proposal must not be treated as approval to merge or deploy production.
