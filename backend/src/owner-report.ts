import {
  InternalOwnerDishReportV2Schema,
  type OwnerDishReportV2,
  type OwnerReportQuery,
  OwnerReportQuerySchema,
  toOwnerReportV2,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError } from './dish-command';

type RevisionAggregate = {
  dish_id: string;
  dish_revision_id: string;
  name: string | null;
  exposures: string;
  exposure_sessions: string;
  open_sessions: string;
  engaged_sessions: string;
  timed_sessions: string;
  average_active_seconds: number | null;
  saved_sessions: string;
  last_event_ingested_at: Date | null;
};

const REPORT_SQL = `
  WITH exposure_rows AS (
    SELECT DISTINCT
      observation.tenant_id,
      observation.session_id,
      observation.dish_id,
      observation.dish_revision_id,
      observation.exposure_id
    FROM app_private.owner_observation_v1 AS observation
    WHERE observation.tenant_id = $1
      AND observation.event_type = 'dish_viewed'
      AND observation.occurred_at >= $2::timestamptz
      AND observation.occurred_at < $3::timestamptz
      AND observation.exposure_id IS NOT NULL
  ),
  exposure_sessions AS (
    SELECT DISTINCT tenant_id, session_id, dish_id, dish_revision_id
    FROM exposure_rows
  ),
  exposure_counts AS (
    SELECT
      tenant_id,
      dish_id,
      dish_revision_id,
      count(DISTINCT exposure_id)::text AS exposures
    FROM exposure_rows
    GROUP BY tenant_id, dish_id, dish_revision_id
  ),
  linked_openings AS (
    SELECT DISTINCT
      observation.tenant_id,
      observation.session_id,
      observation.dish_id,
      observation.dish_revision_id,
      observation.opening_id
    FROM app_private.owner_observation_v1 AS observation
    JOIN exposure_rows AS exposure
      ON exposure.tenant_id = observation.tenant_id
      AND exposure.session_id = observation.session_id
      AND exposure.dish_id = observation.dish_id
      AND exposure.dish_revision_id = observation.dish_revision_id
      AND exposure.exposure_id = observation.exposure_id
    WHERE observation.event_type = 'dish_detail_opened'
      AND observation.opening_id IS NOT NULL
      AND observation.occurred_at >= $2::timestamptz
      AND observation.occurred_at < $3::timestamptz
  ),
  opening_activity AS (
    SELECT
      observation.tenant_id,
      observation.session_id,
      observation.dish_id,
      observation.dish_revision_id,
      observation.opening_id,
      max(observation.active_ms) AS active_ms,
      bool_or(observation.activity_final) AS has_final_checkpoint
    FROM app_private.owner_observation_v1 AS observation
    WHERE observation.tenant_id = $1
      AND observation.event_type = 'dish_activity_checkpoint'
      AND observation.occurred_at >= $2::timestamptz
      AND observation.occurred_at < $3::timestamptz
    GROUP BY
      observation.tenant_id,
      observation.session_id,
      observation.dish_id,
      observation.dish_revision_id,
      observation.opening_id
  ),
  timed_openings AS (
    SELECT
      opening.tenant_id,
      opening.session_id,
      opening.dish_id,
      opening.dish_revision_id,
      opening.opening_id,
      activity.active_ms,
      activity.has_final_checkpoint
    FROM linked_openings AS opening
    JOIN opening_activity AS activity
      ON activity.tenant_id = opening.tenant_id
      AND activity.opening_id = opening.opening_id
      AND activity.dish_id = opening.dish_id
      AND activity.dish_revision_id = opening.dish_revision_id
      AND activity.has_final_checkpoint
  ),
  active_openings AS (
    SELECT
      opening.tenant_id,
      opening.session_id,
      opening.dish_id,
      opening.dish_revision_id,
      opening.opening_id,
      activity.active_ms,
      activity.has_final_checkpoint
    FROM linked_openings AS opening
    JOIN opening_activity AS activity
      ON activity.tenant_id = opening.tenant_id
      AND activity.opening_id = opening.opening_id
      AND activity.dish_id = opening.dish_id
      AND activity.dish_revision_id = opening.dish_revision_id
  ),
  saved_sessions AS (
    SELECT DISTINCT
      observation.tenant_id,
      observation.session_id,
      observation.dish_id,
      observation.dish_revision_id
    FROM app_private.owner_observation_v1 AS observation
    JOIN exposure_sessions AS exposure
      ON exposure.tenant_id = observation.tenant_id
      AND exposure.session_id = observation.session_id
      AND exposure.dish_id = observation.dish_id
      AND exposure.dish_revision_id = observation.dish_revision_id
    WHERE observation.event_type = 'dish_saved'
      AND observation.save_origin = 'direct'
      AND observation.occurred_at >= $2::timestamptz
      AND observation.occurred_at < $3::timestamptz
  ),
  revision_names AS (
    SELECT DISTINCT ON (event.tenant_id, event.stream_id, event.payload->>'revisionId')
      event.tenant_id,
      event.stream_id AS dish_id,
      (event.payload->>'revisionId')::uuid AS dish_revision_id,
      event.payload->>'name' AS name
    FROM app_private.es_event AS event
    WHERE event.tenant_id = $1
      AND event.stream_type = 'dish'
      AND event.event_type = 'dish.revision.created'
    ORDER BY event.tenant_id, event.stream_id, event.payload->>'revisionId', event.version DESC
  ),
  revision_metrics AS (
    SELECT
      exposure.tenant_id,
      exposure.dish_id,
      exposure.dish_revision_id,
      count(DISTINCT exposure.session_id)::text AS exposure_sessions,
      count(DISTINCT opening.session_id)::text AS open_sessions,
      count(DISTINCT opening.session_id) FILTER (
        WHERE active_opening.active_ms >= 10000
      )::text AS engaged_sessions,
      count(DISTINCT timed.session_id)::text AS timed_sessions,
      CAST(
        avg(timed.active_ms::numeric / 1000) FILTER (WHERE timed.has_final_checkpoint)
        AS double precision
      ) AS average_active_seconds,
      count(DISTINCT saved.session_id)::text AS saved_sessions
    FROM exposure_sessions AS exposure
    LEFT JOIN linked_openings AS opening
      ON opening.tenant_id = exposure.tenant_id
      AND opening.session_id = exposure.session_id
      AND opening.dish_id = exposure.dish_id
      AND opening.dish_revision_id = exposure.dish_revision_id
    LEFT JOIN timed_openings AS timed
      ON timed.tenant_id = exposure.tenant_id
      AND timed.session_id = exposure.session_id
      AND timed.dish_id = exposure.dish_id
      AND timed.dish_revision_id = exposure.dish_revision_id
      AND timed.opening_id = opening.opening_id
    LEFT JOIN active_openings AS active_opening
      ON active_opening.tenant_id = exposure.tenant_id
      AND active_opening.session_id = exposure.session_id
      AND active_opening.dish_id = exposure.dish_id
      AND active_opening.dish_revision_id = exposure.dish_revision_id
      AND active_opening.opening_id = opening.opening_id
    LEFT JOIN saved_sessions AS saved
      ON saved.tenant_id = exposure.tenant_id
      AND saved.session_id = exposure.session_id
      AND saved.dish_id = exposure.dish_id
      AND saved.dish_revision_id = exposure.dish_revision_id
    GROUP BY exposure.tenant_id, exposure.dish_id, exposure.dish_revision_id
  )
  SELECT
    metrics.dish_id,
    metrics.dish_revision_id,
    names.name,
    exposure_counts.exposures,
    metrics.exposure_sessions,
    metrics.open_sessions,
    metrics.engaged_sessions,
    metrics.timed_sessions,
    metrics.average_active_seconds,
    metrics.saved_sessions,
    (
      SELECT max(observation.first_received_at)
      FROM app_private.owner_observation_v1 AS observation
      WHERE observation.tenant_id = metrics.tenant_id
        AND observation.dish_id = metrics.dish_id
        AND observation.dish_revision_id = metrics.dish_revision_id
        AND observation.occurred_at >= $2::timestamptz
        AND observation.occurred_at < $3::timestamptz
    ) AS last_event_ingested_at
  FROM revision_metrics AS metrics
  JOIN exposure_counts
    ON exposure_counts.tenant_id = metrics.tenant_id
    AND exposure_counts.dish_id = metrics.dish_id
    AND exposure_counts.dish_revision_id = metrics.dish_revision_id
  LEFT JOIN revision_names AS names
    ON names.tenant_id = metrics.tenant_id
    AND names.dish_id = metrics.dish_id
    AND names.dish_revision_id = metrics.dish_revision_id
  ORDER BY metrics.dish_id, metrics.dish_revision_id`;

function safeCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Owner report count exceeded the supported integer range.');
  }
  return parsed;
}

function countCell(value: number | null, eligibleSessions: number) {
  if (eligibleSessions === 0)
    return { value: null, status: 'NOT_MEASURABLE' as const, eligible_sessions: 0 };
  if (eligibleSessions < 10)
    return { value: null, status: 'SUPPRESSED' as const, eligible_sessions: eligibleSessions };
  if (value === null)
    return { value: null, status: 'MISSING' as const, eligible_sessions: eligibleSessions };
  return {
    value,
    status: value === 0 ? ('VALID_ZERO' as const) : ('NORMAL' as const),
    eligible_sessions: eligibleSessions,
  };
}

function rateCell(numerator: number, denominator: number) {
  if (denominator === 0)
    return { value: null, status: 'NOT_MEASURABLE' as const, eligible_sessions: 0 };
  if (denominator < 10 || numerator < 10 || denominator - numerator < 10)
    return { value: null, status: 'SUPPRESSED' as const, eligible_sessions: denominator };
  const value = numerator / denominator;
  return {
    value,
    status: value === 0 ? ('VALID_ZERO' as const) : ('NORMAL' as const),
    eligible_sessions: denominator,
  };
}

function averageCell(value: number | null, eligibleSessions: number) {
  if (eligibleSessions === 0)
    return { value: null, status: 'NOT_MEASURABLE' as const, eligible_sessions: 0 };
  if (eligibleSessions < 10)
    return { value: null, status: 'SUPPRESSED' as const, eligible_sessions: eligibleSessions };
  if (value === null)
    return { value: null, status: 'MISSING' as const, eligible_sessions: eligibleSessions };
  return { value, status: 'NORMAL' as const, eligible_sessions: eligibleSessions };
}

export async function readOwnerReport(
  client: Client,
  actorId: string,
  venueId: string,
  input: OwnerReportQuery,
): Promise<OwnerDishReportV2> {
  const query = OwnerReportQuerySchema.parse(input);
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor', 'viewer'].includes(membership.rows[0]?.permission ?? '')) {
      throw new CommandError('forbidden', 403);
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const snapshot = await client.query<{ generated_at: Date }>(
      'SELECT transaction_timestamp() AS generated_at',
    );
    const result = await client.query<RevisionAggregate>(REPORT_SQL, [
      venueId,
      query.start_time,
      query.end_time,
    ]);
    const generatedAt = snapshot.rows[0]?.generated_at;
    if (!generatedAt) throw new Error('Owner report snapshot timestamp is missing.');

    const dishes = result.rows.map((row) => {
      if (!row.name) throw new Error('Owner report revision name is missing.');
      const exposures = safeCount(row.exposures);
      const considerationSessions = safeCount(row.exposure_sessions);
      const openSessions = safeCount(row.open_sessions);
      const engagedSessions = safeCount(row.engaged_sessions);
      const timedSessions = safeCount(row.timed_sessions);
      const savedSessions = safeCount(row.saved_sessions);
      const belowFloor = considerationSessions < 10;
      const maybeMask = <
        T extends { value: number | null; status: string; eligible_sessions?: number },
      >(
        cell: T,
      ) => (belowFloor ? { ...cell, value: null, status: 'SUPPRESSED' as const } : cell);
      return {
        dish_id: row.dish_id,
        dish_revision_id: row.dish_revision_id,
        name: row.name,
        evidence_state: belowFloor ? ('SUPPRESSED' as const) : ('NORMAL' as const),
        metrics: {
          consideration_sessions: belowFloor
            ? { value: null, status: 'SUPPRESSED' as const }
            : { value: considerationSessions, status: 'NORMAL' as const },
          consideration_exposures: maybeMask(countCell(exposures, considerationSessions)),
          verified_conversion_sessions: belowFloor
            ? {
                value: null,
                status: 'SUPPRESSED' as const,
                eligible_sessions: 0,
              }
            : {
                value: null,
                status: 'MISSING' as const,
                eligible_sessions: 0,
              },
          avg_interaction_time_seconds: maybeMask(
            averageCell(row.average_active_seconds, timedSessions),
          ),
          timing_coverage: maybeMask(rateCell(timedSessions, openSessions)),
          open_rate: maybeMask(rateCell(openSessions, considerationSessions)),
          engagement_rate: maybeMask(rateCell(engagedSessions, openSessions)),
          save_rate: maybeMask(rateCell(savedSessions, considerationSessions)),
        },
        last_event_ingested_at: row.last_event_ingested_at,
      };
    });
    const lastEvent = dishes.reduce<Date | null>(
      (latest, dish) =>
        dish.last_event_ingested_at && (!latest || dish.last_event_ingested_at > latest)
          ? dish.last_event_ingested_at
          : latest,
      null,
    );
    const total = dishes.length;
    const report = InternalOwnerDishReportV2Schema.parse({
      schema_version: 'owner_report.v2',
      venue_id: venueId,
      source: 'production',
      report_metadata: {
        calculation_version: 's5-data-08.1',
        generated_at: generatedAt.toISOString(),
        date_window: {
          start_time: new Date(query.start_time).toISOString(),
          end_time: new Date(query.end_time).toISOString(),
          duration_hours: Math.ceil(
            (new Date(query.end_time).getTime() - new Date(query.start_time).getTime()) / 3_600_000,
          ),
        },
        coverage: {
          total_dishes_monitored: total,
          measurable_dishes_count: dishes.filter((dish) => !belowFloorFor(dish)).length,
        },
        freshness: {
          last_event_ingested_at: lastEvent?.toISOString() ?? null,
          is_stale: false,
        },
        report_status: total === 0 ? 'EMPTY' : 'NORMAL',
      },
      dishes: dishes.map(({ last_event_ingested_at: _lastEvent, ...dish }) => dish),
    });
    const ownerReport = toOwnerReportV2(report);
    await client.query('COMMIT');
    started = false;
    return ownerReport;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the report failure if the connection cannot roll back.
      }
    }
    throw error;
  }
}

function belowFloorFor(dish: {
  metrics: { consideration_sessions: { value: number | null; status: string } };
}): boolean {
  return (
    dish.metrics.consideration_sessions.status !== 'NORMAL' ||
    (dish.metrics.consideration_sessions.value ?? 0) < 10
  );
}
