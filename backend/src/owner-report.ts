// Owner dish report (S3-RES-03 / S3-DATA-02).
import type { Client } from 'pg';
import { CommandError } from './dish-command';

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

    // Configuration du tenant_id pour activer correctement les politiques RLS de la base
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const result = await client.query(OWNER_REPORT_QUERY, [
      venueId,
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
    ]);
    await client.query('COMMIT');
    started = false;
    return buildInternalReport(result.rows, venueId, now);
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignorer l'erreur latente du rollback
      }
    }
    throw error;
  }
}

// Requête d'agrégation d'interactions et d'achats alignée sur l'ADR 0015 D7 et le schéma de develop
const OWNER_REPORT_QUERY = `
  WITH raw_metrics AS (
    SELECT
      obs.dish_id,
      MIN(dish.name) AS dish_name,
      COUNT(DISTINCT CASE WHEN obs.event_type = 'dish_viewed' THEN obs.session_id END) AS total_sessions,
      COUNT(DISTINCT CASE WHEN obs.event_type = 'dish_detail_opened' THEN obs.session_id END) AS open_eligible_sessions,
      COUNT(DISTINCT CASE WHEN obs.event_type = 'dish_detail_opened' THEN obs.session_id END) AS total_opens,
      COUNT(DISTINCT CASE WHEN obs.event_type = 'dish_detail_opened' AND act.active_ms >= 10000
        THEN obs.session_id END) AS engaged_sessions,
      MAX(act.active_ms) AS max_active_time,
      COUNT(DISTINCT CASE WHEN obs.event_type = 'dish_saved' AND obs.save_origin = 'direct'
        THEN obs.session_id END) AS saved_dishes
    FROM app_private.owner_observation_v1 obs
    LEFT JOIN app_private.dish_current dish
      ON dish.tenant_id = obs.tenant_id AND dish.dish_id = obs.dish_id
    LEFT JOIN app_private.owner_opening_activity_v1 act
      ON act.tenant_id = obs.tenant_id
      AND act.opening_id = obs.opening_id
      AND act.dish_id = obs.dish_id
    WHERE obs.tenant_id = $1
      AND obs.occurred_at >= $2
    GROUP BY obs.dish_id
  )
  SELECT
    rm.dish_id,
    rm.dish_name,
    rm.open_eligible_sessions,
    rm.engaged_sessions,
    rm.saved_dishes,
    rm.max_active_time,
    
    -- Plancher de confidentialité global (10 sessions uniques d'exposition)
    CASE WHEN rm.total_sessions < 10 THEN 'SUPPRESSED' ELSE 'NORMAL' END AS active_sessions_status,
    CASE WHEN rm.total_sessions < 10 THEN NULL ELSE rm.total_sessions END AS active_sessions_value,
    
    -- Open Rate (Priorité de Wang : Évaluation du zéro avant le plancher)
    CASE 
      WHEN rm.total_sessions = 0 THEN 'NOT_MEASURABLE' 
      WHEN rm.total_sessions < 10 THEN 'SUPPRESSED' 
      ELSE 'NORMAL' 
    END AS open_rate_status,
    CASE WHEN rm.total_sessions < 10 THEN NULL ELSE ROUND(CAST(rm.total_opens AS NUMERIC) / rm.total_sessions, 3) END AS open_rate_value,

    -- Engagement Rate (Dénominateur basé sur open_eligible_sessions)
    CASE 
      WHEN rm.total_sessions < 10 THEN 'SUPPRESSED' 
      WHEN rm.open_eligible_sessions = 0 THEN 'NOT_MEASURABLE' 
      WHEN rm.open_eligible_sessions < 10 THEN 'SUPPRESSED' 
      WHEN rm.engaged_sessions = 0 THEN 'VALID_ZERO'
      ELSE 'NORMAL' 
    END AS engagement_rate_status,
    CASE WHEN rm.total_sessions < 10 OR rm.open_eligible_sessions < 10 THEN NULL ELSE ROUND(CAST(rm.engaged_sessions AS NUMERIC) / rm.open_eligible_sessions, 3) END AS engagement_rate_value,

    -- Save Rate (Dénominateur basé sur open_eligible_sessions)
    CASE 
      WHEN rm.total_sessions < 10 THEN 'SUPPRESSED' 
      WHEN rm.open_eligible_sessions = 0 THEN 'NOT_MEASURABLE' 
      WHEN rm.open_eligible_sessions < 10 THEN 'SUPPRESSED' 
      WHEN rm.saved_dishes = 0 THEN 'VALID_ZERO'
      ELSE 'NORMAL' 
    END AS save_rate_status,
    CASE WHEN rm.total_sessions < 10 OR rm.open_eligible_sessions < 10 THEN NULL ELSE ROUND(CAST(rm.saved_dishes AS NUMERIC) / rm.open_eligible_sessions, 3) END AS save_rate_value

  FROM raw_metrics rm;
`;

type ReportRow = Record<string, unknown>;
const numberOrNull = (value: unknown) => (value === null ? null : Number(value));

function buildInternalReport(rows: ReportRow[], venueId: string, now: Date) {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    schema_version: 'owner_report.v1',
    venue_id: venueId,
    source: 'synthetic',
    report_metadata: {
      calculation_version: 'production.v1',
      generated_at: now.toISOString(),
      date_window: {
        duration_hours: 24,
        start_time: yesterday.toISOString(),
        end_time: now.toISOString(),
      },
      coverage: { data_completeness: 1.0 },
      freshness: {
        is_stale: false,
        last_event_ingested_at: now.toISOString(),
      },
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
        open_rate: {
          value: numberOrNull(row.open_rate_value),
          status: row.open_rate_status,
          eligible_sessions: numberOrNull(row.total_sessions),
        },
        engagement_rate: {
          value: numberOrNull(row.engagement_rate_value),
          status: row.engagement_rate_status,
          eligible_sessions: numberOrNull(row.open_eligible_sessions),
          average_active_ms: numberOrNull(row.max_active_time),
        },
        save_rate: {
          value: numberOrNull(row.save_rate_value),
          status: row.save_rate_status,
          eligible_sessions: numberOrNull(row.open_eligible_sessions),
        },
      },
    })),
  };
}
