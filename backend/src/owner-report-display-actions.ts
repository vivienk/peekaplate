import { type OwnerDishReport, PRIVACY_FLOOR_SESSIONS } from '@peekaplate/contracts/owner-report';
import type { Client } from 'pg';
import {
  liveEvidenceParameters,
  type OwnerReportLiveEvidence,
  PRODUCTION_REPORT_FILTER,
  REPORT_PUBLICATION_FILTER,
  REPORT_PUBLICATIONS,
  TODAY_REPORT_EVIDENCE,
} from './owner-report-evidence';

type DisplayAction = 'portion_previews_shown' | 'comparisons_started';
type Count = OwnerDishReport['dishes'][number]['metrics']['active_sessions'];
type Row = { metric: DisplayAction; dishId: string | null; actions: string; visits: string };

const query = `WITH ${TODAY_REPORT_EVIDENCE}, ${REPORT_PUBLICATIONS},
portions AS MATERIALIZED (
  SELECT po.dish_id, obs.session_id
  FROM app_private.owner_observation_v1 obs
  JOIN app_private.owner_portion_opening_v1 po USING (tenant_id, event_id)
  WHERE obs.tenant_id=$1 AND obs.occurred_at >= $2 AND obs.occurred_at < $3
    AND obs.event_type='dish_portion_opened'
    ${PRODUCTION_REPORT_FILTER}
    AND EXISTS (
      SELECT 1 FROM report_dishes d
      WHERE d.publication_id=obs.authorized_publication_id
        AND d.id=po.dish_id AND d.revision=po.dish_revision_id AND d.has_portion
    )
), comparisons AS (
  SELECT DISTINCT dish.id AS dish_id, obs.session_id, obs.authorized_publication_id, obs.comparison_id
  FROM app_private.owner_observation_v1 obs
  CROSS JOIN LATERAL (VALUES (obs.dish_id), (obs.other_dish_id)) AS dish(id)
  WHERE obs.tenant_id=$1 AND obs.occurred_at >= $2 AND obs.occurred_at < $3
    AND obs.event_type='dish_compared' AND obs.compare_action='start' AND obs.comparison_id IS NOT NULL
    ${PRODUCTION_REPORT_FILTER}
    ${REPORT_PUBLICATION_FILTER}
)
SELECT 'portion_previews_shown' AS metric, dish_id AS "dishId",
  COUNT(*) AS actions, COUNT(DISTINCT session_id) AS visits
FROM portions GROUP BY GROUPING SETS ((dish_id), ())
UNION ALL
SELECT 'comparisons_started', dish_id, COUNT(*), COUNT(DISTINCT session_id)
FROM comparisons GROUP BY dish_id`;

/** The caller has checked owner membership and verified the publication manifests. */
export async function readOwnerReportDisplayActions(
  client: Client,
  venueId: string,
  start: Date,
  end: Date,
  evidence: OwnerReportLiveEvidence,
) {
  const { rows } = await client.query<Row>(query, [
    venueId,
    start,
    end,
    ...liveEvidenceParameters(evidence),
  ]);
  const missing = { value: null, status: 'MISSING' } as const;
  const suppressed = { value: null, status: 'SUPPRESSED' } as const;
  const byDish = new Map<string, Partial<Record<DisplayAction, Count>>>();
  let portionTotal: Count = missing;
  let protectedPortionDish = false;
  for (const row of rows) {
    const actions = Number(row.actions);
    const visits = Number(row.visits);
    if (
      !Number.isSafeInteger(actions) ||
      !Number.isSafeInteger(visits) ||
      visits < 0 ||
      actions < visits
    )
      throw new Error('Invalid report display-action count');
    const cell: Count =
      actions === 0
        ? missing
        : visits < PRIVACY_FLOOR_SESSIONS
          ? suppressed
          : { value: actions, status: 'NORMAL' };
    if (row.dishId === null) {
      portionTotal = cell;
      continue;
    }
    if (row.metric === 'portion_previews_shown' && cell.status === 'SUPPRESSED')
      protectedPortionDish = true;
    byDish.set(row.dishId, { ...byDish.get(row.dishId), [row.metric]: cell });
  }
  return { byDish, portionTotal: protectedPortionDish ? suppressed : portionTotal };
}
