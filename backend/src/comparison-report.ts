import { type ComparisonReport, ComparisonReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError } from './dish-command';

type ComparisonRow = {
  dish_id: string;
  name: string;
  current_sessions: string | number;
  baseline_sessions: string | number;
  current_exposure_sessions: string | number;
  baseline_exposure_sessions: string | number;
  current_opening_sessions: string | number;
  baseline_opening_sessions: string | number;
  current_open_rate: string | number | null;
  baseline_open_rate: string | number | null;
  open_rate_delta: string | number | null;
  current_engagement_rate: string | number | null;
  baseline_engagement_rate: string | number | null;
  engagement_rate_delta: string | number | null;
  current_save_rate: string | number | null;
  baseline_save_rate: string | number | null;
  save_rate_delta: string | number | null;
};

type MetricValues = {
  current: number | null;
  baseline: number | null;
  delta: number | null;
  eligibleSessions: number | null;
  insufficient: boolean;
};

function count(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Comparison report session count is invalid');
  }
  return parsed;
}

function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Comparison report metric is invalid');
  return parsed;
}

function assertWindow(start: string, end: string, name: string): void {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new RangeError(`${name} must be a valid, increasing time window`);
  }
}

function metric(
  currentSessions: number,
  baselineSessions: number,
  currentDenominator: number,
  baselineDenominator: number,
  currentValue: string | number | null,
  baselineValue: string | number | null,
  delta: string | number | null,
): MetricValues {
  const insufficient =
    currentSessions < 10 ||
    baselineSessions < 10 ||
    currentDenominator < 10 ||
    baselineDenominator < 10;

  if (insufficient) {
    return {
      current: null,
      baseline: null,
      delta: null,
      eligibleSessions: null,
      insufficient: true,
    };
  }

  return {
    current: numeric(currentValue),
    baseline: numeric(baselineValue),
    delta: numeric(delta),
    eligibleSessions: Math.min(currentDenominator, baselineDenominator),
    insufficient: false,
  };
}

function metricStatus(values: MetricValues) {
  if (values.insufficient) return 'INSUFFICIENT' as const;
  if (values.current === null || values.baseline === null || values.delta === null) {
    return 'MISSING' as const;
  }
  if (values.current === 0 && values.baseline === 0) return 'VALID_ZERO' as const;
  return 'COMPARABLE' as const;
}

function reportMetric(values: MetricValues) {
  return {
    metric_version: 'session_rate.v1',
    status: metricStatus(values),
    current_value: values.current,
    baseline_value: values.baseline,
    delta: values.delta,
    eligible_sessions: values.eligibleSessions,
  };
}

const COMPARISON_SQL = `
WITH current_period AS (
  SELECT sessions.dish_id,
    count(*)::bigint AS eligible_sessions,
    count(*) FILTER (WHERE sessions.has_exposure)::bigint AS exposure_sessions,
    count(*) FILTER (WHERE sessions.has_opening)::bigint AS opening_sessions,
    count(*) FILTER (WHERE sessions.has_exposure AND sessions.has_opening)::bigint
      AS exposed_open_sessions,
    count(*) FILTER (
      WHERE sessions.has_opening
        AND (
          sessions.has_engagement_time
          OR (sessions.has_comparison AND sessions.has_comparison_opening)
        )
    )::bigint AS engaged_sessions,
    count(*) FILTER (WHERE sessions.has_exposure AND sessions.has_save)::bigint AS saved_sessions
  FROM (
    SELECT related.dish_id,
    obs.session_id,
    bool_or(fact.event_type = 'dish_viewed') AS has_exposure,
    bool_or(fact.event_type = 'dish_detail_opened') AS has_opening,
    bool_or(
      fact.event_type = 'dish_detail_opened' AND fact.opening_source = 'compare_view'
    ) AS has_comparison_opening,
      bool_or(
        fact.event_type = 'dish_activity_checkpoint'
        AND fact.active_ms >= 10000
        AND EXISTS (
          SELECT 1
          FROM app_private.owner_observation_v1 linked_opening
          WHERE linked_opening.tenant_id = fact.tenant_id
            AND linked_opening.session_id = obs.session_id
            AND linked_opening.event_type = 'dish_detail_opened'
            AND linked_opening.dish_id = related.dish_id
            AND linked_opening.opening_id = fact.opening_id
            AND linked_opening.occurred_at >= $2::timestamptz
            AND linked_opening.occurred_at < $3::timestamptz
        )
      ) AS has_engagement_time,
      bool_or(fact.event_type = 'dish_compared') AS has_comparison,
      bool_or(fact.event_type = 'dish_saved' AND fact.save_origin = 'direct') AS has_save
    FROM app_private.observation_event obs
    JOIN app_private.owner_observation_v1 fact USING (tenant_id, event_id)
    CROSS JOIN LATERAL (
      VALUES
        (fact.dish_id),
        (CASE WHEN fact.event_type = 'dish_compared' THEN fact.other_dish_id END)
    ) AS related(dish_id)
    WHERE obs.tenant_id = $1
      AND obs.traffic_class = 'live'
      AND fact.occurred_at >= $2::timestamptz
      AND fact.occurred_at < $3::timestamptz
      AND related.dish_id IS NOT NULL
    GROUP BY related.dish_id, obs.session_id
  ) sessions
  GROUP BY sessions.dish_id
),
baseline_period AS (
  SELECT sessions.dish_id,
    count(*)::bigint AS eligible_sessions,
    count(*) FILTER (WHERE sessions.has_exposure)::bigint AS exposure_sessions,
    count(*) FILTER (WHERE sessions.has_opening)::bigint AS opening_sessions,
    count(*) FILTER (WHERE sessions.has_exposure AND sessions.has_opening)::bigint
      AS exposed_open_sessions,
    count(*) FILTER (
      WHERE sessions.has_opening
        AND (
          sessions.has_engagement_time
          OR (sessions.has_comparison AND sessions.has_comparison_opening)
        )
    )::bigint AS engaged_sessions,
    count(*) FILTER (WHERE sessions.has_exposure AND sessions.has_save)::bigint AS saved_sessions
  FROM (
    SELECT related.dish_id,
    obs.session_id,
    bool_or(fact.event_type = 'dish_viewed') AS has_exposure,
    bool_or(fact.event_type = 'dish_detail_opened') AS has_opening,
    bool_or(
      fact.event_type = 'dish_detail_opened' AND fact.opening_source = 'compare_view'
    ) AS has_comparison_opening,
      bool_or(
        fact.event_type = 'dish_activity_checkpoint'
        AND fact.active_ms >= 10000
        AND EXISTS (
          SELECT 1
          FROM app_private.owner_observation_v1 linked_opening
          WHERE linked_opening.tenant_id = fact.tenant_id
            AND linked_opening.session_id = obs.session_id
            AND linked_opening.event_type = 'dish_detail_opened'
            AND linked_opening.dish_id = related.dish_id
            AND linked_opening.opening_id = fact.opening_id
            AND linked_opening.occurred_at >= $4::timestamptz
            AND linked_opening.occurred_at < $5::timestamptz
        )
      ) AS has_engagement_time,
      bool_or(fact.event_type = 'dish_compared') AS has_comparison,
      bool_or(fact.event_type = 'dish_saved' AND fact.save_origin = 'direct') AS has_save
    FROM app_private.observation_event obs
    JOIN app_private.owner_observation_v1 fact USING (tenant_id, event_id)
    CROSS JOIN LATERAL (
      VALUES
        (fact.dish_id),
        (CASE WHEN fact.event_type = 'dish_compared' THEN fact.other_dish_id END)
    ) AS related(dish_id)
    WHERE obs.tenant_id = $1
      AND obs.traffic_class = 'live'
      AND fact.occurred_at >= $4::timestamptz
      AND fact.occurred_at < $5::timestamptz
      AND related.dish_id IS NOT NULL
    GROUP BY related.dish_id, obs.session_id
  ) sessions
  GROUP BY sessions.dish_id
),
paired_periods AS (
  SELECT
    coalesce(current_period.dish_id, baseline_period.dish_id) AS dish_id,
    coalesce(current_period.eligible_sessions, 0)::bigint AS current_sessions,
    coalesce(baseline_period.eligible_sessions, 0)::bigint AS baseline_sessions,
    coalesce(current_period.exposure_sessions, 0)::bigint AS current_exposure_sessions,
    coalesce(baseline_period.exposure_sessions, 0)::bigint AS baseline_exposure_sessions,
    coalesce(current_period.opening_sessions, 0)::bigint AS current_opening_sessions,
    coalesce(baseline_period.opening_sessions, 0)::bigint AS baseline_opening_sessions,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.exposure_sessions >= 10 AND baseline_period.exposure_sessions >= 10
      THEN current_period.exposed_open_sessions::double precision / current_period.exposure_sessions
    END AS current_open_rate,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.exposure_sessions >= 10 AND baseline_period.exposure_sessions >= 10
      THEN baseline_period.exposed_open_sessions::double precision / baseline_period.exposure_sessions
    END AS baseline_open_rate,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.opening_sessions >= 10 AND baseline_period.opening_sessions >= 10
      THEN current_period.engaged_sessions::double precision / current_period.opening_sessions
    END AS current_engagement_rate,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.opening_sessions >= 10 AND baseline_period.opening_sessions >= 10
      THEN baseline_period.engaged_sessions::double precision / baseline_period.opening_sessions
    END AS baseline_engagement_rate,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.exposure_sessions >= 10 AND baseline_period.exposure_sessions >= 10
      THEN current_period.saved_sessions::double precision / current_period.exposure_sessions
    END AS current_save_rate,
    CASE
      WHEN current_period.eligible_sessions >= 10 AND baseline_period.eligible_sessions >= 10
        AND current_period.exposure_sessions >= 10 AND baseline_period.exposure_sessions >= 10
      THEN baseline_period.saved_sessions::double precision / baseline_period.exposure_sessions
    END AS baseline_save_rate
  FROM current_period
  FULL OUTER JOIN baseline_period USING (dish_id)
),
comparison_rates AS (
  SELECT *,
    current_open_rate - baseline_open_rate AS open_rate_delta,
    current_engagement_rate - baseline_engagement_rate AS engagement_rate_delta,
    current_save_rate - baseline_save_rate AS save_rate_delta
  FROM paired_periods
)
SELECT
  comparison_rates.*,
  dish.name
FROM comparison_rates
JOIN app_private.dish_current dish
  ON dish.tenant_id = $1 AND dish.dish_id = comparison_rates.dish_id
ORDER BY dish.name, comparison_rates.dish_id
`;

export async function readComparisonReport(
  client: Client,
  actorId: string,
  venueId: string,
  currentStart: string,
  currentEnd: string,
  baselineStart: string,
  baselineEnd: string,
): Promise<ComparisonReport> {
  assertWindow(currentStart, currentEnd, 'Current period');
  assertWindow(baselineStart, baselineEnd, 'Baseline period');

  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2`,
      [venueId, actorId],
    );
    if (!['owner', 'editor', 'viewer'].includes(membership.rows[0]?.permission ?? '')) {
      throw new CommandError('forbidden', 403);
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const result = await client.query<ComparisonRow>(COMPARISON_SQL, [
      venueId,
      currentStart,
      currentEnd,
      baselineStart,
      baselineEnd,
    ]);

    const dishes = result.rows.map((row) => {
      const currentSessions = count(row.current_sessions);
      const baselineSessions = count(row.baseline_sessions);
      const openRate = metric(
        currentSessions,
        baselineSessions,
        count(row.current_exposure_sessions),
        count(row.baseline_exposure_sessions),
        row.current_open_rate,
        row.baseline_open_rate,
        row.open_rate_delta,
      );
      const engagementRate = metric(
        currentSessions,
        baselineSessions,
        count(row.current_opening_sessions),
        count(row.baseline_opening_sessions),
        row.current_engagement_rate,
        row.baseline_engagement_rate,
        row.engagement_rate_delta,
      );
      const saveRate = metric(
        currentSessions,
        baselineSessions,
        count(row.current_exposure_sessions),
        count(row.baseline_exposure_sessions),
        row.current_save_rate,
        row.baseline_save_rate,
        row.save_rate_delta,
      );
      const metricStatuses = [openRate, engagementRate, saveRate].map(metricStatus);
      const dishStatus = metricStatuses.some(
        (status) => status === 'COMPARABLE' || status === 'VALID_ZERO',
      )
        ? 'COMPARABLE'
        : metricStatuses.includes('INSUFFICIENT')
          ? 'INSUFFICIENT'
          : 'MISSING';

      return {
        dish_id: row.dish_id,
        name: row.name,
        comparison_status: dishStatus,
        metrics: {
          open_rate: reportMetric(openRate),
          engagement_rate: reportMetric(engagementRate),
          save_rate: reportMetric(saveRate),
        },
      };
    });

    const comparisonEligibility =
      dishes.length === 0
        ? 'MISSING'
        : dishes.some((dish) =>
              Object.values(dish.metrics).some(
                (value) => value.status === 'COMPARABLE' || value.status === 'VALID_ZERO',
              ),
            )
          ? 'COMPARABLE'
          : 'INSUFFICIENT';

    const report = ComparisonReportSchema.parse({
      schema_version: 'comparison_report.v1',
      venue_id: venueId,
      comparison_eligibility: comparisonEligibility,
      metrics_metadata: {
        calculation_version: 'comparison_rates.v1',
        timezone: 'UTC',
        window_boundaries: {
          current_period: { start: currentStart, end: currentEnd },
          baseline_period: { start: baselineStart, end: baselineEnd },
        },
        exclusions: ['test_traffic', 'demo_traffic', 'periods_below_privacy_floor'],
      },
      dishes,
    });

    await client.query('COMMIT');
    started = false;
    return report;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501') {
      throw new CommandError('forbidden', 403);
    }
    throw error;
  }
}
