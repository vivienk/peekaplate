# 0019 — Single-session production owner reporting

Status: Proposed · November 24, 2026 · Accountable owner: data/product

## Context

Sai requested that the production owner dashboard display real measurements from the first eligible event. ADR 0018 already allows this for venue-wide menu sessions and dish opens. Dish rows, rates, active time, comparisons, and 2.5D counts in the original daily report required ten eligible sessions.

## Decision

For the San Francisco day report, supersede ADR 0006 and ADR 0018's minimum-session and complementary suppression rules. Overview shows verified venue counts through the latest settled cutoff. Dish Performance and its CSV show eligible aggregate measurements from the previous completed day, including one eligible session or action. Calculate rates from their existing denominators. A missing denominator remains not measurable. Verified orders require linked order evidence.

The API still checks current owner membership, exact venue and publication revision, and the approved observation sources. Return aggregate counts, rates and timing. Keep visit identifiers and raw observations private. Binding and freshness rules for AI requests remain in force.

## Consequences

A count of one can reveal an individual action to an owner who knows which diner visited. Use the existing completed-day snapshots and retain the configured cutover. Staging, synthetic tools and the legacy five-minute rollback retain their existing rules. Record release approval for this disclosure change before activating the production day report.

## Verification

Read a completed day with one eligible visit that opened a dish, completed timing, saved it, rendered 2.5D and started a comparison. Check the dashboard and CSV values, a comparison participant with no card exposure, a dish with no eligible denominator, and access denial to a second owner. Recheck the sealed day after late activity and verify the old mode still respects the cutover.
