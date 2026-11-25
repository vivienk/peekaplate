import {
  type OwnerReportSummary,
  OwnerReportSummarySchema,
  ProductionBatchSummarySchema,
  ProductionDaySummarySchema,
} from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';
import {
  liveEvidenceParameters,
  type OwnerReportLiveEvidence,
  PRODUCTION_REPORT_FILTER,
  REPORT_PUBLICATION_FILTER,
  REPORT_PUBLICATIONS,
  TODAY_REPORT_EVIDENCE,
} from './owner-report-evidence';

const baselineStartExpression = '$2::timestamptz - ($3::timestamptz-$2::timestamptz)';
const baselineInterval = `UNION ALL SELECT 'baseline', ${baselineStartExpression}, $2::timestamptz`;
// The same authorized read-only snapshot and canonical traffic class as the dish report.
const query = `/* owner_summary.v1 */
WITH periods AS (
  SELECT 'current' AS period, $2::timestamptz AS starts, $3::timestamptz AS ends
  ${baselineInterval}
), scoped AS MATERIALIZED (
  SELECT p.period, obs.* FROM periods p
  JOIN app_private.owner_observation_v1 obs ON obs.tenant_id=$1
    AND obs.occurred_at>=p.starts AND obs.occurred_at<p.ends
), openings AS (
  SELECT period, session_id, dish_id, opening_id, MIN(occurred_at) AS opened_at FROM scoped
  WHERE event_type='dish_detail_opened' AND opening_id IS NOT NULL AND dish_id IS NOT NULL
  GROUP BY period, session_id, dish_id, opening_id
), timing AS (
  SELECT o.period,o.session_id,o.dish_id,o.opening_id,
    MAX(a.active_ms) AS active_ms,COALESCE(BOOL_OR(a.activity_final),false) AS has_final
  FROM openings o LEFT JOIN scoped a ON a.period=o.period AND a.session_id=o.session_id
    AND a.dish_id=o.dish_id AND a.opening_id=o.opening_id
    AND a.event_type='dish_activity_checkpoint'
  GROUP BY o.period,o.session_id,o.dish_id,o.opening_id
), dish_cohorts AS (
  SELECT period,dish_id,COUNT(DISTINCT session_id) FILTER (WHERE event_type='dish_viewed') AS exposed
  FROM scoped WHERE dish_id IS NOT NULL GROUP BY period,dish_id
), timed_cohorts AS (
  SELECT period,dish_id,COUNT(DISTINCT session_id) AS timed
  FROM timing WHERE has_final GROUP BY period,dish_id
), opened_cohorts AS (
  SELECT period,dish_id,COUNT(DISTINCT session_id) AS opened
  FROM openings GROUP BY period,dish_id
), daily AS (
  SELECT p.period,GREATEST(day AT TIME ZONE 'UTC',p.starts) AS starts,
    LEAST((day+interval '1 day') AT TIME ZONE 'UTC',p.ends) AS ends,
    COUNT(o.opening_id) AS opens,COUNT(DISTINCT o.session_id) AS sessions
  FROM periods p CROSS JOIN LATERAL generate_series(
    date_trunc('day',p.starts AT TIME ZONE 'UTC'),
    date_trunc('day',(p.ends-interval '1 microsecond') AT TIME ZONE 'UTC'),interval '1 day') day
  LEFT JOIN openings o ON o.period=p.period
    AND o.opened_at>=GREATEST(day AT TIME ZONE 'UTC',p.starts)
    AND o.opened_at<LEAST((day+interval '1 day') AT TIME ZONE 'UTC',p.ends)
  GROUP BY p.period,p.starts,p.ends,day
)
SELECT p.period,
  (SELECT jsonb_agg(jsonb_build_object('start_time',starts,'end_time',ends,'opens',opens,'sessions',sessions) ORDER BY starts)
    FROM daily WHERE period=p.period) AS daily_buckets,
  (SELECT COUNT(DISTINCT session_id) FROM scoped WHERE period=p.period AND event_type='menu_viewed') AS menu_sessions,
  (SELECT COUNT(*) FROM openings WHERE period=p.period) AS dish_opens,
  (SELECT COUNT(DISTINCT session_id) FROM openings WHERE period=p.period) AS open_sessions,
  (SELECT COUNT(DISTINCT session_id) FROM timing WHERE period=p.period AND has_final) AS timed_sessions,
  (SELECT AVG(active_ms)/1000.0 FROM timing WHERE period=p.period AND has_final) AS average_active_seconds,
  EXISTS(SELECT 1 FROM dish_cohorts WHERE period=p.period AND exposed<10) AS has_small_dish,
  (EXISTS(SELECT 1 FROM timed_cohorts WHERE period=p.period AND timed BETWEEN 1 AND 9)
   OR EXISTS(SELECT 1 FROM opened_cohorts WHERE period=p.period AND opened BETWEEN 1 AND 9)) AS has_small_timed_dish
FROM periods p`;

const productionQuery = query
  .replace('WITH periods AS', `WITH ${TODAY_REPORT_EVIDENCE}, ${REPORT_PUBLICATIONS}, periods AS`)
  .replace(
    'AND obs.occurred_at>=p.starts AND obs.occurred_at<p.ends',
    `AND obs.occurred_at>=p.starts AND obs.occurred_at<p.ends
    ${PRODUCTION_REPORT_FILTER}
    ${REPORT_PUBLICATION_FILTER}
    AND (obs.dish_id IS NULL OR EXISTS (
      SELECT 1 FROM app_private.dish_current d
      WHERE d.tenant_id=obs.tenant_id AND d.dish_id=obs.dish_id
    ))`,
  );

type Row = Record<string, unknown>;
type DailyRow = { start_time: string; end_time: string; opens: number; sessions: number };
function dailyRows(row: Row | undefined): DailyRow[] | undefined {
  if (row?.daily_buckets === undefined) return undefined;
  if (!Array.isArray(row.daily_buckets)) throw new Error('Invalid daily buckets');
  return row.daily_buckets.map((bucket: DailyRow) => {
    if (
      !bucket ||
      !Number.isSafeInteger(bucket.opens) ||
      bucket.opens < 0 ||
      !Number.isSafeInteger(bucket.sessions) ||
      bucket.sessions < 0 ||
      bucket.sessions > bucket.opens
    )
      throw new Error('Invalid daily cohort');
    return {
      ...bucket,
      start_time: new Date(bucket.start_time).toISOString(),
      end_time: new Date(bucket.end_time).toISOString(),
    };
  });
}
function metrics(
  row: Row | undefined,
  productionBatch: boolean,
  includeUtcBuckets: boolean,
): OwnerReportSummary['current'] {
  const missing = { value: null, status: 'MISSING' } as const;
  if (!row)
    return {
      menu_sessions: missing,
      dish_opens: missing,
      avg_interaction_time_seconds: missing,
      portion_previews_shown: missing,
      verified_orders: missing,
    };
  const count = (name: string) => {
    const value = Number(row[name]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid summary count');
    return value;
  };
  const menus = count('menu_sessions');
  const opens = count('dish_opens');
  const openingSessions = count('open_sessions');
  const timedSessions = count('timed_sessions');
  if (typeof row.has_small_dish !== 'boolean' || typeof row.has_small_timed_dish !== 'boolean')
    throw new Error('Invalid summary cohort evidence');
  const protectedSubset =
    includeUtcBuckets &&
    (row.has_small_dish ||
      row.has_small_timed_dish ||
      dailyRows(row)?.some((bucket) => bucket.sessions > 0 && bucket.sessions < 10));
  const value = (number: number | null, cohort: number) => {
    if (protectedSubset) return { value: null, status: 'SUPPRESSED' } as const;
    if (cohort === 0) return { value: null, status: 'NOT_MEASURABLE' } as const;
    if (includeUtcBuckets && cohort < 10) return { value: null, status: 'SUPPRESSED' } as const;
    if (number === null || !Number.isFinite(number))
      throw new Error('Missing measured summary value');
    return { value: number, status: number === 0 ? 'VALID_ZERO' : 'NORMAL' } as const;
  };
  const capturedCount = (count: number) =>
    count === 0
      ? ({ value: null, status: 'NOT_MEASURABLE' } as const)
      : ({ value: count, status: 'NORMAL' } as const);
  return {
    menu_sessions: productionBatch ? capturedCount(menus) : value(menus, menus),
    dish_opens: productionBatch ? capturedCount(opens) : value(opens, openingSessions),
    avg_interaction_time_seconds: value(
      row.average_active_seconds === null ? null : Number(row.average_active_seconds),
      timedSessions,
    ),
    portion_previews_shown: missing,
    verified_orders: missing,
  };
}

export async function readOwnerReportSummary(
  client: Client,
  venueId: string,
  now: Date,
  trafficClass: 'live' | 'test',
  liveEvidence?: OwnerReportLiveEvidence,
  durationMs = 86_400_000,
  productionBatch = false,
  dayBaselineStart?: Date,
  settledBaseline?: OwnerReportSummary['baseline'],
): Promise<OwnerReportSummary> {
  const start = new Date(now.getTime() - durationMs);
  const result = await client.query(
    settledBaseline
      ? productionQuery.replace(baselineInterval, '')
      : dayBaselineStart
        ? productionQuery.replace(baselineStartExpression, '$7::timestamptz')
        : liveEvidence
          ? productionQuery
          : trafficClass === 'test'
            ? query.replace(
                'app_private.owner_observation_v1',
                'app_private.owner_test_observation_v1',
              )
            : query,
    [
      venueId,
      start,
      now,
      ...(liveEvidence ? liveEvidenceParameters(liveEvidence) : []),
      ...(dayBaselineStart && !settledBaseline ? [dayBaselineStart] : []),
    ],
  );
  const currentRow = result.rows.find((row) => row.period === 'current');
  const baselineRow = result.rows.find((row) => row.period === 'baseline');
  // The Pacific-day report displays whole-day cohorts without UTC buckets.
  const includeUtcBuckets = !dayBaselineStart;
  const current = metrics(currentRow, productionBatch, includeUtcBuckets);
  if (dayBaselineStart) {
    current.avg_interaction_time_seconds = { value: null, status: 'MISSING' };
  }
  const baseline = settledBaseline ?? metrics(baselineRow, productionBatch, includeUtcBuckets);
  const daily = (row: Row | undefined, totals: OwnerReportSummary['current']) =>
    dailyRows(row)?.map((bucket) => ({
      start_time: bucket.start_time,
      end_time: bucket.end_time,
      opens:
        totals.dish_opens.status === 'SUPPRESSED'
          ? { value: null, status: 'SUPPRESSED' as const }
          : bucket.sessions === 0
            ? { value: null, status: 'NOT_MEASURABLE' as const }
            : { value: bucket.opens, status: 'NORMAL' as const },
    }));
  const currentDaily = includeUtcBuckets ? daily(currentRow, current) : undefined;
  const baselineDaily = includeUtcBuckets ? daily(baselineRow, baseline) : undefined;
  const schema = dayBaselineStart
    ? ProductionDaySummarySchema
    : productionBatch
      ? ProductionBatchSummarySchema
      : OwnerReportSummarySchema;
  return schema.parse({
    periods: {
      current: { start_time: start.toISOString(), end_time: now.toISOString() },
      baseline: {
        start_time: (dayBaselineStart ?? new Date(start.getTime() - durationMs)).toISOString(),
        end_time: start.toISOString(),
      },
    },
    current,
    baseline,
    ...(currentDaily && baselineDaily
      ? { daily_opens: { current: currentDaily, baseline: baselineDaily } }
      : {}),
  });
}
