import {
  type OwnerReportSummary,
  OwnerReportSummarySchema,
} from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';

// The same authorized read-only snapshot and canonical traffic class as the dish report.
const query = `/* owner_summary.v1 */
WITH periods AS (
  SELECT 'current' AS period, $2::timestamptz AS starts, $3::timestamptz AS ends
  UNION ALL SELECT 'baseline', $2::timestamptz - ($3::timestamptz-$2::timestamptz), $2::timestamptz
), scoped AS MATERIALIZED (
  SELECT p.period, obs.* FROM periods p
  JOIN app_private.owner_observation_v1 obs ON obs.tenant_id=$1
    AND obs.occurred_at>=p.starts AND obs.occurred_at<p.ends
), openings AS (
  SELECT DISTINCT period, session_id, dish_id, opening_id FROM scoped
  WHERE event_type='dish_detail_opened' AND opening_id IS NOT NULL AND dish_id IS NOT NULL
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
)
SELECT p.period,
  (SELECT COUNT(DISTINCT session_id) FROM scoped WHERE period=p.period AND event_type='menu_viewed') AS menu_sessions,
  (SELECT COUNT(*) FROM openings WHERE period=p.period) AS dish_opens,
  (SELECT COUNT(DISTINCT session_id) FROM openings WHERE period=p.period) AS open_sessions,
  (SELECT COUNT(DISTINCT session_id) FROM timing WHERE period=p.period AND has_final) AS timed_sessions,
  (SELECT AVG(active_ms)/1000.0 FROM timing WHERE period=p.period AND has_final) AS average_active_seconds,
  EXISTS(SELECT 1 FROM dish_cohorts WHERE period=p.period AND exposed<10) AS has_small_dish,
  (EXISTS(SELECT 1 FROM timed_cohorts WHERE period=p.period AND timed BETWEEN 1 AND 9)
   OR EXISTS(SELECT 1 FROM opened_cohorts WHERE period=p.period AND opened BETWEEN 1 AND 9)) AS has_small_timed_dish
FROM periods p`;

type Row = Record<string, unknown>;
function metrics(row: Row | undefined): OwnerReportSummary['current'] {
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
  const protectedSubset = row.has_small_dish || row.has_small_timed_dish;
  const value = (number: number | null, cohort: number) => {
    if (protectedSubset) return { value: null, status: 'SUPPRESSED' } as const;
    if (cohort === 0) return { value: null, status: 'NOT_MEASURABLE' } as const;
    if (cohort < 10) return { value: null, status: 'SUPPRESSED' } as const;
    if (number === null || !Number.isFinite(number))
      throw new Error('Missing measured summary value');
    return { value: number, status: number === 0 ? 'VALID_ZERO' : 'NORMAL' } as const;
  };
  return {
    menu_sessions: value(menus, menus),
    dish_opens: value(opens, openingSessions),
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
): Promise<OwnerReportSummary> {
  const start = new Date(now.getTime() - 86_400_000);
  const result = await client.query(
    trafficClass === 'test'
      ? query.replace('app_private.owner_observation_v1', 'app_private.owner_test_observation_v1')
      : query,
    [venueId, start, now],
  );
  return OwnerReportSummarySchema.parse({
    periods: {
      current: { start_time: start.toISOString(), end_time: now.toISOString() },
      baseline: {
        start_time: new Date(start.getTime() - 86_400_000).toISOString(),
        end_time: start.toISOString(),
      },
    },
    current: metrics(result.rows.find((row) => row.period === 'current')),
    baseline: metrics(result.rows.find((row) => row.period === 'baseline')),
  });
}
