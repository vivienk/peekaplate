# 0017 — Production owner report sources

Status: Proposed · November 21, 2026

## Context

The production owner console used the synthetic report route and the Worker omitted the production origin in report preflights. Both QA restaurants could publish independently, but neither could read its owner report. Canonical events already reach Supabase through the signed menu authority, Queue and private R2 archive.

## Decision

Serve the production report only from the production Worker with the owner workflow and production reporting switches enabled. Check signed-in owner membership for the exact restaurant before querying PostHog. The existing staging and local synthetic routes keep their scope.

The production console reports activity from midnight in `America/Los_Angeles` through the latest completed five-minute cutoff, with the previous San Francisco calendar day shown separately. San Francisco calendar days can be 23, 24, or 25 hours. A cutoff becomes eligible one minute after it ends. Each day-to-cutoff report is sealed on its first read, and late arrivals may appear in the next snapshot. The console, CSV, and signed AI report reference use the same snapshot. Staging and local retain their existing windows. The production rollback mode uses the latest completed five-minute interval and its adjacent predecessor.

Event-source selection uses the UTC date of the scheduled eligibility time, regardless of the display timezone or the first refresh. Same-UTC-day events require the exact venue, event ID, publication and event type to match PostHog. Earlier UTC activity uses attested canonical Supabase facts, including the portion of the same San Francisco day before UTC midnight. The Worker stamps production provenance after successful production menu-token verification, and Queue/R2 replays retain the first archive's provenance. The reader resolves the immutable approval and verifies the published menu contents before using any dish or comparison revision. PostHog supplies eligibility only. The dashboard and CSV receive aggregate values only. Diner events still reach PostHog live. The scheduled PostHog batch export to Supabase runs separately and does not control dashboard refreshes.

If the provider request fails or is truncated, return report unavailable. A successful bounded read cannot prove that both systems have received every event. The production report omits exact last-ingestion timestamps and retains unknown freshness. The AI analysis route re-reads the same signed snapshot, checks owner membership and abstains before using the provider while freshness is unknown. Current and previous figures can cover different capture cohorts. The console explains that difference.

## Consequences

PostHog captures can lag canonical ingestion and vice versa. Public capture identifiers alone are not an authenticated independent receipt. Immutable releases prevent repeated reads of the same cutoff from exposing an intrabatch delta. Consecutive day-to-date snapshots can expose changes between cutoffs. The venue-wide exception and dish-level suppression are documented in [ADR 0018](0018-production-batch-counts.md). Keep rollout disabled until the authorized PostHog project, publication provenance, history separation and release behavior are verified. Do not repurpose the frozen staging environment's GitHub credentials.

## Verification

Exercise two owners against the restricted database reader and authenticated production routes. Check the UTC cutoff, today and earlier rows, mismatched publication/type, provider-only rows, legacy synthetic behavior and cross-restaurant denial before PostHog access. Verify the actual project and its query key with both live diner links, compare consented IDs, and observe the report in each signed-in owner console before enabling production reporting. Paid AI additionally requires an authorized production model key, rate limit, signing secret and trusted report freshness.
