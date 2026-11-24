# 0018 — Restaurant totals in completed production batches

Status: Proposed · November 21, 2026 · Accountable owner: data/product

## Context

A newly published restaurant may get only one eligible menu visit or dish open during a five-minute interval. Sai requested that the production dashboard display verified counts at that volume. ADR 0006 currently suppresses behavioral cells below ten eligible sessions. The exception needs accountable approval before activation.

## Decision

Allow exact venue-wide counts of captured menu sessions and rendered dish opens, including one, in completed and immutable production report batches. The chart and table repeat the same opening total with its exact UTC interval. Require the existing signed production venue/publication scope, current owner permission, canonical provenance, and current-day PostHog match.

Retain suppression for dish-level counts, rates, timing, and their small complements. Do not return raw observations, identifiers, or an individual activity timeline. Comparison, 2.5D and order measures without supported evidence remain unavailable. The earlier staging and local contracts retain their existing floors.

Supported 2.5D preview counts use only rendered, non-sample previews for the exact approved publication dish revision. Comparisons started count the distinct rendered start involving each dish; two pair events in a three-dish comparison and a replacement reuse one start. Each displayed count requires ten distinct contributing sessions. Suppress the restaurant preview total when a contributing dish group is protected. Order counts require separately verified POS or ticket linkage.

## Consequences

A small total can reveal that a visit happened. An owner who knows who was present may infer which visit contributed. When the San Francisco day report is enabled, its start stays anchored to local midnight and its end advances only at settled cutoffs. The earlier same-day totals remain visible during quiet intervals. Comparing saved snapshots can reveal changes between cutoffs. Do not combine the exception with arbitrary date filters, narrower drill-downs, a mutable intrabatch counter, or AI input. Record data/product approval before setting the production reporting flag.

## Verification

Verify that a single eligible event appears as 1 only under its authorized production restaurant and interval. Test stale publication revisions, another owner, zero events, one save within ten eligible visits, and a late arrival into an already released batch. Exercise the production source and current dashboard on two independent published links.
