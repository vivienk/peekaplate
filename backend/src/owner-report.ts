// Owner dish report (S3-RES-03 / S3-DATA-02). The route verifies the staff token; this module
// checks that the actor owns the restaurant and reads the report inside one read-only
// transaction, with app.actor_id set so the owner views' row-level security applies. The route
// then passes the internal report through toOwnerReport() (@peekaplate/contracts), which checks
// the per-metric privacy floor and strips cohort counts before anything reaches the owner.
import type { Client } from 'pg';
import { CommandError } from './dish-command';

// Implementation plan, access matrix: owners may read their restaurant's approved aggregates;
// editors receive only explicitly granted capabilities, and viewers none.
const REPORT_PERMISSIONS = ['owner'];

export async function readOwnerReport(
  client: Client,
  actorId: string,
  venueId: string,
  now: Date,
): Promise<unknown> {
  let started = false;
  try {
    await client.query('BEGIN READ ONLY');
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
    // The observation fact tables behind the owner views are scoped by app.tenant_id
    // (security_invoker views, tenant RLS). Without it every row is hidden and the report would
    // look like a restaurant with no activity. Same pattern as dish-command.ts (Jeffin, 5 Nov).
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const result = await client.query(OWNER_REPORT_QUERY, [venueId]);
    await client.query('COMMIT');
    started = false;
    return buildInternalReport(result.rows, venueId, now);
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is kept.
      }
    }
    throw error;
  }
}

// PENDING (pairing with Louis, metric definitions checked with Vivien): this query and the
// mapping below are carried over unchanged from the first draft and do not work yet.
// owner_observation_v1 has one row per event (tenant_id, session_id, event_type, dish_id, ...);
// it has no venue_id, dish_name, total_sessions, total_opens, open_eligible_sessions,
// engaged_sessions or saved_dishes. The report needs aggregating per dish (distinct sessions,
// counted per metric as Sai specified), dish names from the published menu, the date window,
// coverage and freshness, average interaction time and timing coverage, and eligible_sessions
// for every rate and the average. Until then toOwnerReport() rejects the result and the route
// answers with the generic service_unavailable error.
const OWNER_REPORT_QUERY = `
  SELECT
    v.dish_id, v.dish_name, v.total_sessions, v.open_eligible_sessions,
    CASE WHEN v.total_sessions < 10 THEN 'SUPPRESSED' ELSE 'NORMAL' END AS active_sessions_status,
    CASE WHEN v.total_sessions < 10 THEN NULL ELSE v.total_sessions END AS active_sessions_value,
    CASE WHEN v.total_sessions < 10 THEN 'SUPPRESSED' WHEN v.total_sessions = 0 THEN 'NOT_MEASURABLE' ELSE 'NORMAL' END AS open_rate_status,
    CASE WHEN v.total_sessions < 10 THEN NULL ELSE ROUND(CAST(v.total_opens AS NUMERIC) / v.total_sessions, 3) END AS open_rate_value,
    CASE WHEN v.open_eligible_sessions < 10 THEN 'SUPPRESSED' WHEN v.open_eligible_sessions = 0 THEN 'NOT_MEASURABLE' WHEN v.engaged_sessions = 0 THEN 'VALID_ZERO' ELSE 'NORMAL' END AS engagement_rate_status,
    CASE WHEN v.open_eligible_sessions < 10 THEN NULL ELSE ROUND(CAST(v.engaged_sessions AS NUMERIC) / v.open_eligible_sessions, 3) END AS engagement_rate_value,
    CASE WHEN v.open_eligible_sessions < 10 THEN 'SUPPRESSED' WHEN v.open_eligible_sessions = 0 THEN 'NOT_MEASURABLE' WHEN v.saved_dishes = 0 THEN 'VALID_ZERO' ELSE 'NORMAL' END AS save_rate_status,
    CASE WHEN v.open_eligible_sessions < 10 THEN NULL ELSE ROUND(CAST(v.saved_dishes AS NUMERIC) / v.open_eligible_sessions, 3) END AS save_rate_value
  FROM app_private.owner_observation_v1 v
  WHERE v.venue_id = $1
`;

type ReportRow = Record<string, unknown>;
const numberOrNull = (value: unknown) => (value === null ? null : Number(value));

function buildInternalReport(rows: ReportRow[], venueId: string, now: Date) {
  return {
    schema_version: 'owner_report.v1',
    venue_id: venueId,
    // PENDING: must come from the deployment (synthetic fixtures vs production data).
    source: 'synthetic',
    report_metadata: {
      calculation_version: 'production.v1',
      generated_at: now.toISOString(),
      date_window: { duration_hours: 24 },
      freshness: { is_stale: false },
      report_status: 'NORMAL',
    },
    dishes: rows.map((row) => ({
      dish_id: row.dish_id,
      name: row.dish_name,
      evidence_state: row.active_sessions_status,
      metrics: {
        active_sessions: {
          value: numberOrNull(row.active_sessions_value),
          status: row.active_sessions_status,
        },
        open_rate: { value: numberOrNull(row.open_rate_value), status: row.open_rate_status },
        engagement_rate: {
          value: numberOrNull(row.engagement_rate_value),
          status: row.engagement_rate_status,
        },
        save_rate: { value: numberOrNull(row.save_rate_value), status: row.save_rate_status },
      },
    })),
  };
}
