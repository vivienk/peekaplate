import {
  InternalOwnerDishReportSchema,
  type OwnerAiEvidence,
  type OwnerRecommendationRequest,
  OwnerRecommendationRequestSchema,
  toOwnerReport,
} from '@peekaplate/contracts';
import { z } from 'zod';
import { OwnerAiAuthorizationError } from './recommendation';
import { validateOwnerAiReportInput } from './report-input';

const requestFields = OwnerRecommendationRequestSchema.shape;
const reportFields = InternalOwnerDishReportSchema.shape;
const metadataFields = reportFields.report_metadata.shape;

// Internal caller context, not a new HTTP contract or a report-ID generation scheme.
const snapshotSchema = z.strictObject({
  requestId: requestFields.requestId,
  reportId: requestFields.reportId,
  reportVersion: requestFields.reportVersion,
  venueId: requestFields.venueId,
  dishId: requestFields.venueId,
  source: reportFields.source,
  calculationVersion: metadataFields.calculation_version,
  generatedAt: metadataFields.generated_at,
  timeWindow: requestFields.timeWindow,
  evidenceIds: z.strictObject({
    open_rate: requestFields.requestId,
    engagement_rate: requestFields.requestId,
    save_rate: requestFields.requestId,
  }),
});

/** Maps an internal report into the existing deterministic core's request.
 * The server caller must authenticate current membership and supply trusted snapshot/evidence
 * identities bound to this dish, report tuple and version. This function neither issues those
 * identities nor proves producer provenance, real freshness or HTTP authorization.
 */
export function toOwnerRecommendationRequest(
  input: unknown,
  scope: { authorizedVenueId: string; dishId: string; snapshot: unknown },
): OwnerRecommendationRequest {
  const snapshot = snapshotSchema.parse(scope.snapshot);
  const report = InternalOwnerDishReportSchema.parse(input);
  const selected = validateOwnerAiReportInput(report, scope);
  const metadata = selected.metadata;
  if (
    snapshot.venueId !== selected.venueId.toLowerCase() ||
    snapshot.dishId !== selected.dishId.toLowerCase() ||
    snapshot.source !== selected.source ||
    snapshot.calculationVersion !== metadata.calculation_version ||
    snapshot.generatedAt !== metadata.generated_at ||
    snapshot.timeWindow.start !== metadata.date_window.start_time ||
    snapshot.timeWindow.end !== metadata.date_window.end_time
  ) {
    throw new OwnerAiAuthorizationError();
  }

  // Reuse the shared disclosure projection: a structurally valid internal cell may still be
  // hidden by complementary suppression. Never restore that cell from its internal value.
  const publicDish = toOwnerReport(report).dishes.find(
    (dish) => dish.dish_id.toLowerCase() === snapshot.dishId,
  );
  if (!publicDish) throw new OwnerAiAuthorizationError();
  const evidence: OwnerAiEvidence[] = selected.metrics.map((metric) => {
    const identity = {
      evidenceId: snapshot.evidenceIds[metric.metricKey],
      venueId: snapshot.venueId,
      reportId: snapshot.reportId,
      reportVersion: snapshot.reportVersion,
      metricKey: metric.metricKey,
      timeWindow: snapshot.timeWindow,
    };
    if (metric.state !== 'available') {
      return {
        ...identity,
        // The existing core has no not_measurable wire state: absent denominator evidence is
        // missing, not a valid zero. The original report retains its more specific status.
        state: metric.state === 'not_measurable' ? 'missing' : metric.state,
      };
    }
    if (publicDish.metrics[metric.metricKey].status === 'SUPPRESSED') {
      return { ...identity, state: 'suppressed' };
    }
    return {
      ...identity,
      state: 'available',
      value: metric.value,
      eligibleSessions: metric.eligibleSessions,
    };
  });

  return OwnerRecommendationRequestSchema.parse({
    schemaVersion: 'owner-recommendation.v1',
    requestId: snapshot.requestId,
    venueId: snapshot.venueId,
    reportId: snapshot.reportId,
    reportVersion: snapshot.reportVersion,
    timeWindow: snapshot.timeWindow,
    evidence,
  });
}
