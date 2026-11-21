import type { LivePostHogOwnerEvent } from './owner-report-posthog';

export type OwnerReportLiveEvidence = { start: Date; events: LivePostHogOwnerEvent[] };

// Today requires a matching PostHog tuple. Every field that reaches a metric comes from Postgres.
export const TODAY_REPORT_EVIDENCE = `posthog_today AS MATERIALIZED (
    SELECT "eventId" AS id, "publicationId" AS publication_id, "eventType" AS kind
    FROM jsonb_to_recordset($5::jsonb)
      AS e("eventId" uuid, "publicationId" uuid, "eventType" text)
  )`;

export const PRODUCTION_REPORT_FILTER = `
    AND obs.authorized_publication_id = obs.publication_revision_id
    AND (obs.occurred_at < $4::timestamptz OR EXISTS (
      SELECT 1 FROM posthog_today ph
      WHERE ph.id=obs.event_id
        AND ph.publication_id=obs.authorized_publication_id
        AND ph.kind=obs.event_type
    ))`;
