import {
  type OwnerRecommendationResult,
  OwnerRecommendationResultSchema,
} from '@peekaplate/contracts';

/** Local display states; these do not extend owner-recommendation.v1. */
export type AiPreviewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'insufficient-evidence' }
  | { kind: 'withheld' }
  | { kind: 'result'; result: OwnerRecommendationResult };

const abstentionText = {
  missing_evidence: 'The report evidence needed for a recommendation is unavailable.',
  suppressed_evidence: 'This evidence is withheld. No recommendation is shown.',
  stale_evidence: 'Current report evidence is needed before a recommendation can be shown.',
  conflicting_evidence: 'The report evidence could not be verified consistently.',
  unsupported_evidence: 'The available evidence does not support this recommendation.',
  insufficient_evidence: 'There is not enough usable evidence for a recommendation.',
} as const;

function PreviewBody({ state }: { state: AiPreviewState }) {
  switch (state.kind) {
    case 'loading':
      return <p role="status">Loading the synthetic example…</p>;
    case 'error':
      return <p role="alert">The example could not be displayed. Please choose another state.</p>;
    case 'insufficient-evidence':
      return <p role="status">Not enough usable evidence. No recommendation is shown.</p>;
    case 'withheld':
      return <p role="status">Evidence withheld. No recommendation is shown.</p>;
    case 'result': {
      // Validate the public result only. Never accept internal report/evidence objects or
      // display a raw exception / producer diagnostic in the owner-facing panel.
      const parsed = OwnerRecommendationResultSchema.safeParse(state.result);
      if (!parsed.success) {
        return <p role="alert">The example could not be verified. No recommendation is shown.</p>;
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
              <time dateTime={result.timeWindow.start}>{result.timeWindow.start.slice(0, 10)}</time>
              {' to '}
              <time dateTime={result.timeWindow.end}>{result.timeWindow.end.slice(0, 10)}</time>
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

/** Synthetic handoff component only; no fetch, model, chat, approval or mutation effects. */
export function AiRecommendationPreview({ state }: { state: AiPreviewState }) {
  return (
    <section
      className="ai-preview"
      aria-label="Synthetic AI result"
      aria-busy={state.kind === 'loading'}
    >
      <p className="ai-preview__label">Synthetic AI preview</p>
      <p className="ai-preview__notice">
        Fictional examples only. No live restaurant data is loaded.
      </p>
      <PreviewBody state={state} />
    </section>
  );
}
