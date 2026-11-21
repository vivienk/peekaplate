# 0017 — Production owner report sources

Status: Proposed · November 21, 2026

## Context

The production owner console used the synthetic report route and the Worker omitted the production origin in report preflights. Both QA restaurants could publish independently, but neither could read its owner report. Canonical events already reach Supabase through the signed menu authority, Queue and private R2 archive.

## Decision

Serve the production report only from the production Worker with the owner workflow and production reporting switches enabled. Check signed-in owner membership for the exact restaurant before querying PostHog. The existing staging and local synthetic routes keep their scope.

The current 24-hour report and its adjacent baseline keep their existing end-exclusive windows. Within the report, events whose canonical occurrence is today UTC require corroboration from the US PostHog project. Require exact event ID, publication revision and event type on the live canonical tenant row. Earlier UTC days use Supabase's canonical facts. PostHog supplies eligibility only. The dashboard and CSV never receive provider properties or raw canonical observations, and the internal batch export remains separate.

If the provider request fails or is truncated, return report unavailable. A successful bounded read cannot prove that both systems have received every event. The production report omits exact last-ingestion timestamps and retains unknown freshness. The AI analysis route re-reads the same signed snapshot, checks owner membership and abstains before using the provider while freshness is unknown. Current and previous figures can cover different capture cohorts. The console explains that difference.

## Consequences

PostHog captures can lag canonical ingestion and vice versa. The canonical match prevents provider-only or mismatched rows from becoming metrics. Public capture identifiers alone are not an authenticated independent receipt. Keep live rollout disabled until the approved production project, manifest provenance, repeated-report disclosure, historical environment separation and data-read coverage are verified. Do not repurpose the frozen staging environment's GitHub credentials.

## Verification

Exercise two owners against the restricted database reader and authenticated production routes. Check the UTC cutoff, today and earlier rows, mismatched publication/type, provider-only rows, legacy synthetic behavior and cross-restaurant denial before PostHog access. Verify the actual project and its query key with both live diner links, compare consented IDs, and observe the report in each signed-in owner console before enabling production reporting. Paid AI additionally requires an authorized production model key, rate limit, signing secret and trusted report freshness.
