import {
  OwnerAiTimeWindowSchema,
  OwnerRecommendationRequestSchema,
  type OwnerRecommendationResult,
  OwnerRecommendationResultSchema,
} from '@peekaplate/contracts/owner-ai';

/** Local display states; these do not extend owner-recommendation.v1. */
export type AiPreviewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'insufficient-evidence' }
  | { kind: 'withheld' }
  | { kind: 'result'; result: OwnerRecommendationResult };

/** Screen consistency only; this context does not prove authorization or provenance. */
export type AiPreviewContext = {
  venueId: string;
  timeWindow: OwnerRecommendationResult['timeWindow'];
  /** Bind only when the caller already has the trusted result's report identity. */
  reportId?: string;
};

type AiRecommendationPreviewProps =
  | { state: AiPreviewState; expectedContext: AiPreviewContext }
  | {
      state: Exclude<AiPreviewState, { kind: 'result' }>;
      expectedContext?: undefined;
    };

const abstentionText = {
  missing_evidence: 'The report evidence needed for a recommendation is unavailable.',
  suppressed_evidence: 'This evidence is withheld. No recommendation is shown.',
  stale_evidence: 'Current report evidence is needed before a recommendation can be shown.',
  conflicting_evidence: 'The report evidence could not be verified consistently.',
  unsupported_evidence: 'The available evidence does not support this recommendation.',
  insufficient_evidence: 'There is not enough usable evidence for a recommendation.',
} as const;

const displayUtcTime = (timestamp: string) =>
  new Date(timestamp)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.000Z$/, ' UTC')
    .replace(/Z$/, ' UTC');

function matchesExpectedContext(result: OwnerRecommendationResult, context?: AiPreviewContext) {
  if (!context || typeof context !== 'object') return false;
  const venue = OwnerRecommendationRequestSchema.shape.venueId.safeParse(context.venueId);
  const window = OwnerAiTimeWindowSchema.safeParse(context.timeWindow);
  if (!venue.success || !window.success) return false;
  if (
    result.venueId !== venue.data ||
    result.timeWindow.start !== window.data.start ||
    result.timeWindow.end !== window.data.end
  ) {
    return false;
  }
  if (context.reportId !== undefined) {
    const report = OwnerRecommendationRequestSchema.shape.reportId.safeParse(context.reportId);
    if (!report.success || result.reportId !== report.data) return false;
  }
  return true;
}

function PreviewBody({
  state,
  expectedContext,
}: {
  state: AiPreviewState;
  expectedContext: AiPreviewContext | undefined;
}) {
  switch (state.kind) {
    case 'loading':
      return <p role="status">Loading recommendation…</p>;
    case 'error':
      return <p role="alert">The recommendation could not be displayed. Please try again.</p>;
    case 'insufficient-evidence':
      return <p role="status">Not enough usable evidence. No recommendation is shown.</p>;
    case 'withheld':
      return <p role="status">Evidence withheld. No recommendation is shown.</p>;
    case 'result': {
      // Validate the public result only. Never accept internal report/evidence objects or
      // display a raw exception / producer diagnostic in the owner-facing panel.
      const parsed = OwnerRecommendationResultSchema.safeParse(state.result);
      if (!parsed.success || !matchesExpectedContext(parsed.data, expectedContext)) {
        return (
          <p role="alert">The recommendation could not be verified. No recommendation is shown.</p>
        );
      }
      const result = parsed.data;
      if (result.status === 'abstained') {
        return (
          <div role="status">
            <h4>No recommendation</h4>
            <p>{abstentionText[result.reason]}</p>
          </div>
        );
      }
      return (
        <div role="status">
          <h4>Draft recommendation</h4>
          <p className="ai-preview__action">{result.draftAction}</p>
          <p>{result.rationale}</p>
          <dl>
            <dt>Report window (UTC)</dt>
            <dd>
              <time dateTime={result.timeWindow.start}>
                {displayUtcTime(result.timeWindow.start)}
              </time>
              {' to '}
              <time dateTime={result.timeWindow.end}>{displayUtcTime(result.timeWindow.end)}</time>
              {' (end excluded)'}
            </dd>
            <dt>Confidence</dt>
            <dd>{result.confidence}</dd>
          </dl>
          <h4>Limitations</h4>
          <ul>
            {result.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
          <p className="ai-preview__review">Review required. This preview cannot apply changes.</p>
        </div>
      );
    }
  }
}

/** Display only; no fetch, model, chat, approval or mutation effects. */
export function AiRecommendationPreview({ state, expectedContext }: AiRecommendationPreviewProps) {
  return (
    <section
      className="ai-preview"
      aria-label="AI recommendation result"
      aria-busy={state.kind === 'loading'}
    >
      <p className="ai-preview__label">AI recommendation</p>
      <PreviewBody state={state} expectedContext={expectedContext} />
    </section>
  );
}
