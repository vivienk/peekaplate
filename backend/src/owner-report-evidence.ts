import type { LivePostHogOwnerEvent } from './owner-report-posthog';
import type { ReportPublication } from './owner-report-publications';

export type OwnerReportLiveEvidence = {
  start: Date;
  events: LivePostHogOwnerEvent[];
  publications?: ReportPublication[];
};

// Today requires a matching PostHog tuple. Every field that reaches a metric comes from Postgres.
export const TODAY_REPORT_EVIDENCE = `posthog_today AS MATERIALIZED (
    SELECT "eventId" AS id, "publicationId" AS publication_id, "eventType" AS kind
    FROM jsonb_to_recordset($5::jsonb)
      AS e("eventId" uuid, "publicationId" uuid, "eventType" text)
  )`;

export const PRODUCTION_REPORT_FILTER = `
    AND obs.authorized_publication_id = obs.publication_revision_id
    AND EXISTS (
      SELECT 1 FROM app_private.observation_event canonical
      WHERE canonical.tenant_id=obs.tenant_id AND canonical.event_id=obs.event_id
        AND canonical.source_environment='production'
    )
    AND (obs.occurred_at < $4::timestamptz OR EXISTS (
      SELECT 1 FROM posthog_today ph
      WHERE ph.id=obs.event_id
        AND ph.publication_id=obs.authorized_publication_id
        AND ph.kind=obs.event_type
    ))`;

export const REPORT_PUBLICATIONS = `report_publications AS MATERIALIZED (
    SELECT "publicationId" AS publication_id, dishes
    FROM jsonb_to_recordset($6::jsonb) AS p("publicationId" uuid, dishes jsonb)
  ), report_dishes AS MATERIALIZED (
    SELECT p.publication_id, d.id, d.revision
    FROM report_publications p, jsonb_to_recordset(p.dishes) AS d(id uuid, revision uuid)
  )`;

export const REPORT_PUBLICATION_FILTER = `
    AND EXISTS (SELECT 1 FROM report_publications p WHERE p.publication_id=obs.authorized_publication_id)
    AND (obs.event_type='menu_viewed' OR EXISTS (
      SELECT 1 FROM report_dishes d WHERE d.publication_id=obs.authorized_publication_id
        AND d.id=obs.dish_id AND d.revision=obs.dish_revision_id
    ))
    AND (obs.event_type<>'dish_compared' OR EXISTS (
      SELECT 1 FROM report_dishes d WHERE d.publication_id=obs.authorized_publication_id
        AND d.id=obs.other_dish_id AND d.revision=obs.other_dish_revision_id
    ))`;

export const liveEvidenceParameters = ({
  start,
  events,
  publications,
}: OwnerReportLiveEvidence) => [start, JSON.stringify(events), JSON.stringify(publications ?? [])];
