# 0017 — Production owner report sources

Status: Proposed · November 21, 2026

## Context

The production owner console used the synthetic report route and the Worker omitted the production origin in report preflights. Both QA restaurants could publish independently, but neither could read its owner report. Canonical events already reach Supabase through the signed menu authority, Queue and private R2 archive.

## Decision

Serve the production report only from the production Worker with the owner workflow and production reporting switches enabled. Check signed-in owner membership for the exact restaurant before querying PostHog. The existing staging and local synthetic routes keep their scope.

Production answers use the latest completed five-minute UTC interval and its previous adjacent interval. Each becomes eligible for release one minute after it ends. Once first read, it is sealed in private object storage with a create-only condition. Later arrivals remain in canonical history and cannot rewrite a displayed interval. The console and CSV read the same sealed results. Staging and local retain their existing report windows.

Intervals use the UTC date of their scheduled eligibility time, regardless of the first refresh. Same-UTC-day events require the exact venue, event ID, publication and event type to match PostHog. Earlier UTC intervals use only attested canonical Supabase facts. The Worker stamps production provenance after successful production menu-token verification, and Queue/R2 replays retain the first archive's provenance. The reader resolves the immutable approval and verifies the published menu contents before using any dish or comparison revision. PostHog supplies eligibility only. The dashboard and CSV receive aggregate values only. The internal PostHog batch export remains separate.

If the provider request fails or is truncated, return report unavailable. A successful bounded read cannot prove that both systems have received every event. The production report omits exact last-ingestion timestamps and retains unknown freshness. The AI analysis route re-reads the same signed snapshot, checks owner membership and abstains before using the provider while freshness is unknown. Current and previous figures can cover different capture cohorts. The console explains that difference.

## Consequences

PostHog captures can lag canonical ingestion and vice versa. Public capture identifiers alone are not an authenticated independent receipt. Independent intervals and immutable releases prevent repeated refreshes from exposing an exact intrabatch delta. The requested exception for venue-wide counts is documented in [ADR 0018](0018-production-batch-counts.md). Keep rollout disabled until that approval and the authorized PostHog project, publication provenance, history separation and release behavior are verified. Do not repurpose the frozen staging environment's GitHub credentials.

## Verification

Exercise two owners against the restricted database reader and authenticated production routes. Check the UTC cutoff, today and earlier rows, mismatched publication/type, provider-only rows, legacy synthetic behavior and cross-restaurant denial before PostHog access. Verify the actual project and its query key with both live diner links, compare consented IDs, and observe the report in each signed-in owner console before enabling production reporting. Paid AI additionally requires an authorized production model key, rate limit, signing secret and trusted report freshness.
