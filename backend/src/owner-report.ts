// Owner dish report (S3-RES-03 / S3-DATA-02).
import { toOwnerReport } from '@peekaplate/contracts';
import {
  OWNER_PRODUCTION_BATCH_VERSION,
  OWNER_PRODUCTION_DAY_VERSION,
  OWNER_PRODUCTION_TODAY_VERSION,
  type OwnerDishReport,
  OwnerDishReportSchema,
  type OwnerReportSummary,
  PRIVACY_FLOOR_SESSIONS,
} from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';
import { AuthUnavailableError } from './auth';
import { CommandError } from './dish-command';
import { verifySyntheticCompleteness } from './owner-ai/synthetic-completeness';
import type { PreparedStorage } from './owner-prepare';
import {
  OWNER_BATCH_MS,
  OWNER_BATCH_SETTLE_MS,
  readBatchedOwnerReport,
  readDailyOwnerReport,
} from './owner-report-batches';
import { readOwnerReportDisplayActions } from './owner-report-display-actions';
import {
  liveEvidenceParameters,
  type OwnerReportLiveEvidence,
  PRODUCTION_REPORT_FILTER,
  REPORT_PUBLICATION_FILTER,
  REPORT_PUBLICATIONS,
  TODAY_REPORT_EVIDENCE,
} from './owner-report-evidence';
import type { LivePostHogOwnerEvent } from './owner-report-posthog';
import { readReportPublications } from './owner-report-publications';
import { readOwnerReportSummary } from './owner-report-summary';

const REPORT_PERMISSIONS = ['owner'];
export type OwnerReportSource = 'production' | 'synthetic';

type ReportOptions = {
  trafficClass?: 'live' | 'test';
  includeSummary?: boolean;
  includeDisplayActions?: boolean;
  syntheticSeal?: string;
  validationNow?: Date;
  readTodayEvents?: (venueId: string, start: Date, end: Date) => Promise<LivePostHogOwnerEvent[]>;
  productionPublications?: { storage: PreparedStorage; origin: string };
  productionDay?: boolean;
  productionToday?: boolean;
  productionDishDayStart?: Date | undefined;
  productionDishLiveStart?: Date | undefined;
};

type DailyScope = {
  baselineStart: Date;
  dishStart: Date;
  settledBaseline?: OwnerReportSummary['baseline'];
};

export async function readOwnerReport(
  client: Client,
  actorId: string,
  venueId: string,
  now: Date,
  source: OwnerReportSource = 'production',
  options: ReportOptions = {},
): Promise<unknown> {
  let started = false;
  try {
    await client.query(
      options.includeSummary || options.syntheticSeal
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN READ ONLY',
    );
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2`,
      [venueId, actorId],
    );

    if (!REPORT_PERMISSIONS.includes(membership.rows[0]?.permission ?? '')) {
      throw new CommandError('forbidden', 403);
    }

    // Tenant scope is set only after the owner permission is confirmed.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const { productionDishDayStart, productionDishLiveStart } = options;
    const legacyCutover =
      productionDishLiveStart &&
      (!productionDishDayStart || productionDishLiveStart < productionDishDayStart)
        ? productionDishLiveStart
        : productionDishDayStart;
    const report =
      source === 'production' && options.readTodayEvents && options.productionPublications
        ? options.productionDay || options.productionToday
          ? await readDailyOwnerReport(
              venueId,
              now,
              options.productionPublications.storage,
              ({ start, end, baselineStart }, midnightReport) =>
                midnightReport
                  ? advanceDailyReport(client, venueId, start, end, options, midnightReport)
                  : measureReport(client, venueId, end, source, options, 0, {
                      baselineStart,
                      dishStart: baselineStart,
                    }),
              productionDishDayStart,
              options.productionToday
                ? {
                    startsAt: productionDishLiveStart,
                    measure: ({ start, end, baselineStart }, dishStart, midnight) => {
                      if (!midnight.summary) throw new AuthUnavailableError();
                      return measureReport(
                        client,
                        venueId,
                        end,
                        source,
                        options,
                        end.getTime() - start.getTime(),
                        {
                          baselineStart,
                          dishStart,
                          settledBaseline: midnight.summary.baseline,
                        },
                      );
                    },
                  }
                : undefined,
            )
          : await readBatchedOwnerReport(
              venueId,
              now,
              options.productionPublications.storage,
              (end) => measureReport(client, venueId, end, source, options, OWNER_BATCH_MS),
              legacyCutover,
            )
        : await measureReport(client, venueId, now, source, options);
    await client.query('COMMIT');
    started = false;
    return report;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore a secondary rollback failure.
      }
    }
    throw error;
  }
}

async function readReportEvidence(
  client: Client,
  venueId: string,
  start: Date,
  end: Date,
  batch: boolean,
  options: ReportOptions,
  publicationStart = start,
): Promise<OwnerReportLiveEvidence> {
  if (!options.productionPublications || !options.readTodayEvents) throw new AuthUnavailableError();
  const { storage, origin } = options.productionPublications;
  // Earliest release time makes source selection stable across UTC midnight.
  const today = new Date(end.getTime() + (batch ? OWNER_BATCH_SETTLE_MS : 0));
  today.setUTCHours(0, 0, 0, 0);
  const starts = new Date(Math.max(today.getTime(), start.getTime()));
  const evidence = {
    start: today,
    events: end > starts ? await options.readTodayEvents(venueId, starts, end) : [],
  };
  return {
    ...evidence,
    publications: await readReportPublications(
      client,
      storage,
      origin,
      venueId,
      end,
      evidence,
      publicationStart,
    ),
  };
}

async function advanceDailyReport(
  client: Client,
  venueId: string,
  start: Date,
  end: Date,
  options: ReportOptions,
  midnightReport: OwnerDishReport,
) {
  const midnight = midnightReport.summary;
  if (!midnight) throw new AuthUnavailableError();
  const evidence = await readReportEvidence(client, venueId, start, end, true, options);
  const summary = await readOwnerReportSummary(
    client,
    venueId,
    end,
    'live',
    evidence,
    end.getTime() - start.getTime(),
    true,
    new Date(midnight.periods.baseline.start_time),
    midnight.baseline,
  );
  return OwnerDishReportSchema.parse({
    ...midnightReport,
    summary,
    report_metadata: { ...midnightReport.report_metadata, generated_at: end.toISOString() },
  });
}

async function measureReport(
  client: Client,
  venueId: string,
  now: Date,
  source: OwnerReportSource,
  options: ReportOptions,
  durationMs = 86_400_000,
  day?: DailyScope,
) {
  const isBatch = Boolean(day) || durationMs === OWNER_BATCH_MS;
  const productionDay = source === 'production' && day !== undefined;
  const productionToday = productionDay && day.settledBaseline !== undefined;
  const windowStart = new Date(now.getTime() - durationMs);
  const dishStart = day?.dishStart ?? windowStart;
  const liveEvidence =
    source === 'production' && options.readTodayEvents
      ? await readReportEvidence(
          client,
          venueId,
          productionToday ? windowStart : dishStart,
          now,
          isBatch,
          options,
          productionToday
            ? windowStart
            : (day?.baselineStart ?? new Date(now.getTime() - 2 * durationMs)),
        )
      : undefined;
  const query = liveEvidence
    ? PRODUCTION_OWNER_REPORT_QUERY
    : options.trafficClass === 'test'
      ? TEST_OWNER_REPORT_QUERY
      : OWNER_REPORT_QUERY;
  const result = await client.query(query, [
    venueId,
    dishStart,
    now,
    ...(liveEvidence ? liveEvidenceParameters(liveEvidence) : []),
  ]);
  const summary = options.includeSummary
    ? await readOwnerReportSummary(
        client,
        venueId,
        now,
        options.trafficClass ?? 'live',
        liveEvidence,
        durationMs,
        isBatch,
        day?.baselineStart,
        day?.settledBaseline,
      )
    : undefined;
  const complete =
    source === 'synthetic' &&
    options.trafficClass === 'test' &&
    (await verifySyntheticCompleteness(client, {
      ...(options.syntheticSeal ? { seal: options.syntheticSeal } : {}),
      venueId,
      anchor: now,
      validationNow: options.validationNow ?? new Date(),
    }));
  const rows = result.rows;
  const exposedDishes = new Set(
    rows
      .filter((row) => Number(row.total_sessions) >= PRIVACY_FLOOR_SESSIONS)
      .map((row) => String(row.dish_id)),
  );
  const displayActions =
    isBatch && options.includeDisplayActions && liveEvidence
      ? await readOwnerReportDisplayActions(
          client,
          venueId,
          dishStart,
          now,
          liveEvidence,
          exposedDishes,
          productionDay,
        )
      : undefined;
  if (productionDay && displayActions) {
    const observedDishes = new Set(rows.map((row) => String(row.dish_id)));
    for (const [dishId, name] of displayActions.dishNames) {
      if (observedDishes.has(dishId)) continue;
      // A comparison partner or a rendered portion can have no exposure or open
      // in the reporting window. The action is still measured on that dish.
      rows.push({
        dish_id: dishId,
        dish_name: name,
        total_sessions: 0,
        open_eligible_sessions: 0,
        timed_sessions: 0,
        total_openings: 0,
        average_active_seconds: null,
        last_event_ingested_at: null,
      });
    }
  }
  const internal = buildInternalReport(
    rows,
    venueId,
    now,
    source,
    now.getTime() - dishStart.getTime(),
    productionToday
      ? OWNER_PRODUCTION_TODAY_VERSION
      : productionDay
        ? OWNER_PRODUCTION_DAY_VERSION
        : undefined,
  );
  return toOwnerReport({
    ...internal,
    ...(displayActions
      ? {
          dishes: internal.dishes.map((dish) => {
            const activity = displayActions.byDish.get(String(dish.dish_id));
            return activity ? { ...dish, display_actions: activity } : dish;
          }),
        }
      : {}),
    report_metadata: {
      ...internal.report_metadata,
      freshness: {
        last_event_ingested_at: liveEvidence
          ? null
          : internal.report_metadata.freshness.last_event_ingested_at,
        is_stale: complete ? false : null,
      },
    },
    ...(summary
      ? {
          // Overview labels the whole day. A partial cutover count belongs only on Dish Performance.
          summary:
            displayActions && (!productionToday || dishStart.getTime() === windowStart.getTime())
              ? {
                  ...summary,
                  ...(productionDay && !productionToday
                    ? {
                        baseline: {
                          ...summary.baseline,
                          portion_previews_shown: displayActions.portionTotal,
                        },
                      }
                    : {
                        current: {
                          ...summary.current,
                          portion_previews_shown: displayActions.portionTotal,
                        },
                      }),
                }
              : summary,
        }
      : {}),
  });
}

// D7 rates are formed from distinct session sets, not event counts.
const OWNER_REPORT_QUERY = `
  WITH filtered_observations AS (
    SELECT
      obs.*,
      dish.name AS dish_name
    FROM app_private.owner_observation_v1 obs
    LEFT JOIN app_private.dish_current dish
      ON dish.tenant_id = obs.tenant_id AND dish.dish_id = obs.dish_id
    WHERE obs.tenant_id = $1
      AND obs.occurred_at >= $2
      AND obs.occurred_at < $3
      AND obs.dish_id IS NOT NULL
  ),
  opening_activity AS (
    SELECT
      act.tenant_id,
      act.dish_id,
      act.session_id,
      act.opening_id,
      act.active_ms,
      act.activity_final
    FROM filtered_observations act
    WHERE act.event_type = 'dish_activity_checkpoint'
      AND act.occurred_at >= $2
      AND act.occurred_at < $3
  ),
  event_order AS (
    SELECT
      event.tenant_id,
      event.event_id,
      event.session_id,
      event.producer_id,
      event.local_sequence
    FROM app_private.observation_event event
    JOIN filtered_observations obs
      ON obs.tenant_id = event.tenant_id
      AND obs.event_id = event.event_id
    WHERE event.tenant_id = $1
  ),
  dish_openings AS (
    SELECT
      obs.tenant_id,
      obs.session_id,
      obs.dish_id,
      obs.occurred_at,
      event_order.producer_id,
      event_order.local_sequence
    FROM filtered_observations obs
    JOIN event_order
      ON event_order.tenant_id = obs.tenant_id
      AND event_order.event_id = obs.event_id
      AND event_order.session_id = obs.session_id
    WHERE obs.event_type = 'dish_detail_opened'
  ),
  qualified_comparisons AS (
    SELECT
      comp.tenant_id,
      comp.session_id,
      comp.comparison_id,
      comp.occurred_at,
      comp.dish_id,
      comp.other_dish_id,
      comp_order.producer_id,
      comp_order.local_sequence
    FROM filtered_observations comp
    JOIN event_order comp_order
      ON comp_order.tenant_id = comp.tenant_id
      AND comp_order.event_id = comp.event_id
      AND comp_order.session_id = comp.session_id
    WHERE comp.event_type = 'dish_compared'
      AND comp.comparison_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM dish_openings opened
        WHERE opened.tenant_id = comp.tenant_id
          AND opened.session_id = comp.session_id
          AND opened.dish_id IN (comp.dish_id, comp.other_dish_id)
          AND (
            opened.occurred_at < comp.occurred_at
            OR (
              opened.occurred_at = comp.occurred_at
              AND opened.producer_id = comp_order.producer_id
              AND opened.local_sequence < comp_order.local_sequence
            )
          )
      )
  ),
  comparison_engagement AS (
    SELECT DISTINCT
      comp.tenant_id,
      comp.session_id,
      participant.dish_id
    FROM qualified_comparisons comp
    CROSS JOIN LATERAL (VALUES (comp.dish_id), (comp.other_dish_id)) participant(dish_id)
    WHERE EXISTS (
      SELECT 1
      FROM dish_openings opened
      WHERE opened.tenant_id = comp.tenant_id
        AND opened.session_id = comp.session_id
        AND opened.dish_id = participant.dish_id
    )
  ),
  dish_sessions AS (
    SELECT
      obs.dish_id,
      MIN(obs.dish_name) AS dish_name,
      obs.session_id,
      BOOL_OR(obs.event_type = 'dish_viewed') AS is_exposed,
      BOOL_OR(obs.event_type = 'dish_detail_opened') AS is_opened,
      BOOL_OR(obs.event_type = 'dish_saved' AND obs.save_origin = 'direct') AS has_direct_save,
      MAX(obs.first_received_at) AS last_event_ingested_at
    FROM filtered_observations obs
    GROUP BY obs.dish_id, obs.session_id
  ),
  opening_metrics AS (
    SELECT
      obs.dish_id,
      obs.session_id,
      obs.opening_id,
      MAX(act.active_ms) AS active_ms,
      COALESCE(BOOL_OR(act.activity_final), false) AS has_final_checkpoint
    FROM filtered_observations obs
    LEFT JOIN opening_activity act
      ON act.tenant_id = obs.tenant_id
      AND act.session_id = obs.session_id
      AND act.opening_id = obs.opening_id
      AND act.dish_id = obs.dish_id
    WHERE obs.event_type = 'dish_detail_opened'
    GROUP BY obs.dish_id, obs.session_id, obs.opening_id
  ),
  session_metrics AS (
    SELECT
      sessions.dish_id,
      sessions.dish_name,
      sessions.session_id,
      sessions.is_exposed,
      sessions.is_opened,
      sessions.has_direct_save,
      COALESCE(BOOL_OR(comparisons.dish_id IS NOT NULL), false) AS has_comparison,
      sessions.last_event_ingested_at,
      COALESCE(BOOL_OR(openings.active_ms >= 10000), false) AS has_active_engagement,
      COALESCE(BOOL_OR(openings.has_final_checkpoint), false) AS has_timing
    FROM dish_sessions sessions
    LEFT JOIN opening_metrics openings
      ON openings.dish_id = sessions.dish_id
      AND openings.session_id = sessions.session_id
    LEFT JOIN comparison_engagement comparisons
      ON comparisons.tenant_id = $1
      AND comparisons.dish_id = sessions.dish_id
      AND comparisons.session_id = sessions.session_id
    GROUP BY
      sessions.dish_id,
      sessions.dish_name,
      sessions.session_id,
      sessions.is_exposed,
      sessions.is_opened,
      sessions.has_direct_save,
      sessions.last_event_ingested_at
  ),
  dish_metrics AS (
    SELECT
      sessions.dish_id,
      MIN(sessions.dish_name) AS dish_name,
      COUNT(DISTINCT sessions.session_id) FILTER (WHERE sessions.is_exposed) AS total_sessions,
      COUNT(DISTINCT sessions.session_id) FILTER (
        WHERE sessions.is_exposed AND sessions.is_opened
      ) AS exposed_open_sessions,
      COUNT(DISTINCT sessions.session_id) FILTER (WHERE sessions.is_opened) AS open_eligible_sessions,
      COUNT(DISTINCT sessions.session_id) FILTER (
        WHERE sessions.is_opened AND (sessions.has_active_engagement OR sessions.has_comparison)
      ) AS engaged_sessions,
      COUNT(DISTINCT sessions.session_id) FILTER (
        WHERE sessions.is_exposed AND sessions.has_direct_save
      ) AS saved_sessions,
      COUNT(DISTINCT sessions.session_id) FILTER (
        WHERE sessions.is_opened AND sessions.has_timing
      ) AS timed_sessions,
      MAX(sessions.last_event_ingested_at) AS last_event_ingested_at
    FROM session_metrics sessions
    GROUP BY sessions.dish_id
  ),
  timing_metrics AS (
    SELECT
      openings.dish_id,
      AVG(openings.active_ms) FILTER (WHERE openings.has_final_checkpoint) / 1000.0
        AS average_active_seconds
    FROM opening_metrics openings
    GROUP BY openings.dish_id
  ),
  opening_coverage_metrics AS (
    SELECT
      openings.dish_id,
      COUNT(*) AS total_openings,
      COUNT(*) FILTER (WHERE openings.has_final_checkpoint) AS timed_openings,
      COUNT(DISTINCT openings.session_id) FILTER (
        WHERE openings.has_final_checkpoint
      ) AS timed_opening_sessions,
      COUNT(DISTINCT openings.session_id) FILTER (
        WHERE NOT openings.has_final_checkpoint
      ) AS untimed_opening_sessions
    FROM opening_metrics openings
    GROUP BY openings.dish_id
  )
  SELECT
    metrics.*,
    timing.average_active_seconds,
    coverage.total_openings,
    coverage.timed_openings,
    coverage.timed_opening_sessions,
    coverage.untimed_opening_sessions
  FROM dish_metrics metrics
  LEFT JOIN timing_metrics timing USING (dish_id)
  LEFT JOIN opening_coverage_metrics coverage USING (dish_id);
`;

type ReportRow = Record<string, unknown>;
const TEST_OWNER_REPORT_QUERY = OWNER_REPORT_QUERY.replace(
  'FROM app_private.owner_observation_v1 obs',
  'FROM app_private.owner_test_observation_v1 obs',
);
// The capture provider supplies inclusion IDs. Canonical facts retain authority over scope and values.
const PRODUCTION_OWNER_REPORT_QUERY = OWNER_REPORT_QUERY.replace(
  'WITH filtered_observations AS',
  `WITH ${TODAY_REPORT_EVIDENCE}, ${REPORT_PUBLICATIONS}, filtered_observations AS`,
).replace(
  'AND obs.dish_id IS NOT NULL',
  `AND obs.dish_id IS NOT NULL AND dish.dish_id IS NOT NULL
  ${PRODUCTION_REPORT_FILTER} ${REPORT_PUBLICATION_FILTER}`,
);
const numberOrNull = (value: unknown) => (value === null ? null : Number(value));

function rateMetric(
  numerator: number,
  denominator: number,
  belowDishFloor: boolean,
  eligibleSessions: number,
  minimumSessions: number,
  protectSmallPartitions = false,
) {
  if (belowDishFloor)
    return { value: null, status: 'SUPPRESSED', eligible_sessions: eligibleSessions };
  if (denominator === 0)
    return { value: null, status: 'NOT_MEASURABLE', eligible_sessions: eligibleSessions };
  if (eligibleSessions < minimumSessions)
    return { value: null, status: 'SUPPRESSED', eligible_sessions: eligibleSessions };
  if (
    protectSmallPartitions &&
    numerator > 0 &&
    numerator < denominator &&
    Math.min(numerator, denominator - numerator) < PRIVACY_FLOOR_SESSIONS
  )
    return { value: null, status: 'SUPPRESSED', eligible_sessions: eligibleSessions };
  if (numerator === 0)
    return { value: 0, status: 'VALID_ZERO', eligible_sessions: eligibleSessions };
  return {
    value: Math.round((numerator / denominator) * 1000) / 1000,
    status: 'NORMAL',
    eligible_sessions: eligibleSessions,
  };
}

function averageMetric(
  value: number | null,
  eligibleSessions: number,
  belowDishFloor: boolean,
  minimumSessions: number,
) {
  if (belowDishFloor)
    return { value: null, status: 'SUPPRESSED', eligible_sessions: eligibleSessions };
  if (eligibleSessions === 0)
    return { value: null, status: 'NOT_MEASURABLE', eligible_sessions: eligibleSessions };
  if (eligibleSessions < minimumSessions)
    return { value: null, status: 'SUPPRESSED', eligible_sessions: eligibleSessions };
  if (value === null) throw new Error('Timed sessions have no average active time');
  if (value === 0) return { value: 0, status: 'VALID_ZERO', eligible_sessions: eligibleSessions };
  return { value, status: 'NORMAL', eligible_sessions: eligibleSessions };
}

function timestampOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid last event ingestion timestamp');
  return timestamp.toISOString();
}

function buildInternalReport(
  rows: ReportRow[],
  venueId: string,
  now: Date,
  source: OwnerReportSource = 'production',
  durationMs = 86_400_000,
  dayVersion?: typeof OWNER_PRODUCTION_DAY_VERSION | typeof OWNER_PRODUCTION_TODAY_VERSION,
) {
  const productionDay = dayVersion !== undefined;
  const start = new Date(now.getTime() - durationMs);
  const isBatch = productionDay || durationMs === OWNER_BATCH_MS;
  const legacyBatch = isBatch && !productionDay;
  const minimumSessions = productionDay ? 1 : PRIVACY_FLOOR_SESSIONS;
  const visibleRows = legacyBatch
    ? rows.filter((row) => Number(row.total_sessions) >= minimumSessions)
    : rows;
  const lastEventIngestedAt = rows.reduce<string | null>((latest, row) => {
    const timestamp = timestampOrNull(row.last_event_ingested_at);
    return timestamp && (!latest || timestamp > latest) ? timestamp : latest;
  }, null);

  return {
    schema_version: 'owner_report.v1',
    venue_id: venueId,
    source,
    report_metadata: {
      calculation_version:
        dayVersion ?? (isBatch ? OWNER_PRODUCTION_BATCH_VERSION : `${source}.v1`),
      generated_at: now.toISOString(),
      date_window: {
        duration_hours: Math.floor(durationMs / 3_600_000),
        start_time: start.toISOString(),
        end_time: now.toISOString(),
      },
      coverage: {
        total_dishes_monitored: visibleRows.length,
        measurable_dishes_count: productionDay
          ? visibleRows.length
          : visibleRows.filter((row) => Number(row.total_sessions) >= minimumSessions).length,
      },
      freshness: {
        is_stale: null,
        last_event_ingested_at: lastEventIngestedAt,
      },
      report_status: visibleRows.length === 0 ? 'EMPTY' : 'NORMAL',
    },
    dishes: visibleRows.map((row) => {
      const totalSessions = Number(row.total_sessions);
      const openEligibleSessions = Number(row.open_eligible_sessions);
      const timedSessions = Number(row.timed_sessions);
      const belowDishFloor = !productionDay && totalSessions < minimumSessions;
      const coverageHasSmallSessionGroup =
        legacyBatch &&
        [row.timed_opening_sessions, row.untimed_opening_sessions]
          .map(Number)
          .some((count) => count > 0 && count < minimumSessions);

      return {
        dish_id: row.dish_id,
        name: row.dish_name,
        evidence_state: belowDishFloor ? 'SUPPRESSED' : 'NORMAL',
        metrics: {
          active_sessions: {
            value: belowDishFloor ? null : totalSessions,
            status: belowDishFloor ? 'SUPPRESSED' : totalSessions === 0 ? 'VALID_ZERO' : 'NORMAL',
          },
          avg_interaction_time_seconds: averageMetric(
            numberOrNull(row.average_active_seconds),
            timedSessions,
            belowDishFloor,
            minimumSessions,
          ),
          timing_coverage: rateMetric(
            Number(row.timed_openings),
            Number(row.total_openings),
            belowDishFloor || coverageHasSmallSessionGroup,
            openEligibleSessions,
            minimumSessions,
            legacyBatch,
          ),
          open_rate: rateMetric(
            Number(row.exposed_open_sessions),
            totalSessions,
            belowDishFloor,
            totalSessions,
            minimumSessions,
            legacyBatch,
          ),
          engagement_rate: rateMetric(
            Number(row.engaged_sessions),
            openEligibleSessions,
            belowDishFloor,
            openEligibleSessions,
            minimumSessions,
            legacyBatch,
          ),
          save_rate: rateMetric(
            Number(row.saved_sessions),
            totalSessions,
            belowDishFloor,
            totalSessions,
            minimumSessions,
            legacyBatch,
          ),
        },
      };
    }),
  };
}
