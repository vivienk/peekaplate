# 0020 — Today’s Dish Performance in production

Status: Proposed · November 25, 2026 · Accountable owner: data/product

## Decision

Show eligible current Pacific-day activity in the existing Dish Performance charts after it reaches
the same settled cutoff as Overview. Keep the existing metrics, provenance checks, tenant
authorization and freshness rules. One eligible visit or display action can contribute. Unavailable
denominators and verified orders without linked order evidence remain unavailable.

The API, CSV and signed AI reference use the today-to-date dish window. Each current cutoff is
sealed separately from the completed-day report. The baseline summary comes from the sealed
Pacific midnight snapshot. A later cutoff can pick up late matches for the same day.

## Rollout

Deploy a compatible console before switching the Worker to `OWNER_PRODUCTION_REPORT_WINDOW=sf-today`.
Set the approved `OWNER_PRODUCTION_REPORT_DISH_LIVE_START` to an exact UTC five-minute boundary
after legacy dish metrics stopped serving. A partial first day uses that timestamp as its marked
dish window start. Overview withholds the 2.5D total when the dish window covers only part of its labeled day. Keep both approved cutover values when changing modes. Retain private report
objects, including the `owner-report-batches/sf-today-v1/` prefix.

With a missing live cutoff, venue-wide totals are still available. The current source and delivery
checks remain. Activity may take until the next settled cutoff to appear on manual or automatic
refresh. AI requires the signed snapshot and verified freshness as before.

## Verification

Use one matched dish exposure/open and rendered portion from the eligible window. Check the
chart and CSV date ranges, exclude pre-cutover and wrong-tenant input, and confirm the same
count after a quiet cutoff. Check the first midnight and keep local and staging behavior.
