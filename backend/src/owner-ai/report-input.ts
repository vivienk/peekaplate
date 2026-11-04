import { InternalOwnerDishReportSchema } from '@peekaplate/contracts';
import { OwnerAiAuthorizationError } from './recommendation';

const metricKeys = ['open_rate', 'engagement_rate', 'save_rate'] as const;
type MetricKey = (typeof metricKeys)[number];
type WithheldState = 'suppressed' | 'not_measurable' | 'missing' | 'stale' | 'conflicting';
type ReportMetric =
  | { metricKey: MetricKey; state: 'available'; value: number; eligibleSessions: number }
  | { metricKey: MetricKey; state: WithheldState };

const withheldStates = {
  SUPPRESSED: 'suppressed',
  NOT_MEASURABLE: 'not_measurable',
  MISSING: 'missing',
  STALE: 'stale',
  EVIDENCE_CHECK_FAILED: 'conflicting',
} as const;

/** Server-only input validation. The caller must authenticate membership before supplying scope.
 * Consumes the internal report because owner responses deliberately omit eligible-session counts.
 * Report/evidence identity assignment and recommendation generation are a separate integration.
 */
export function validateOwnerAiReportInput(
  input: unknown,
  scope: { authorizedVenueId: string; dishId: string },
) {
  const report = InternalOwnerDishReportSchema.parse(input);
  if (report.venue_id.toLowerCase() !== scope.authorizedVenueId.toLowerCase()) {
    throw new OwnerAiAuthorizationError();
  }
  const identities = report.dishes.map((dish) => dish.dish_id.toLowerCase());
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate report dish');
  const dish = report.dishes.find(
    (item) => item.dish_id.toLowerCase() === scope.dishId.toLowerCase(),
  );
  if (!dish) throw new Error('Requested dish is absent from the report');

  const metadata = report.report_metadata;
  let reportState: WithheldState | undefined;
  if (metadata.report_status === 'ERROR') reportState = 'conflicting';
  else if (metadata.report_status === 'STALE' || metadata.freshness.is_stale) reportState = 'stale';
  else if (metadata.report_status === 'EMPTY') reportState = 'missing';
  else if (dish.evidence_state !== 'NORMAL') reportState = withheldStates[dish.evidence_state];

  const metrics = metricKeys.map((metricKey): ReportMetric => {
    if (reportState) return { metricKey, state: reportState };
    const metric = dish.metrics[metricKey];
    if (metric.status !== 'NORMAL' && metric.status !== 'VALID_ZERO') {
      return { metricKey, state: withheldStates[metric.status] };
    }
    // Schema validation has checked both the value and this metric's own privacy cohort.
    if (metric.value === null) throw new Error('Available metric has no value');
    return {
      metricKey,
      state: 'available',
      value: metric.value,
      eligibleSessions: metric.eligible_sessions,
    };
  });
  return {
    venueId: report.venue_id,
    dishId: dish.dish_id,
    source: report.source,
    metadata,
    metrics,
  };
}
