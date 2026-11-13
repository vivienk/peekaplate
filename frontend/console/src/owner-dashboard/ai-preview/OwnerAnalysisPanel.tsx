import {
  OWNER_ANALYSIS_ACTIONS,
  OWNER_ANALYSIS_LIMITATION,
  type OwnerAnalysisRequest,
  type OwnerAnalysisResult,
} from '@peekaplate/contracts/owner-analysis';
import { useEffect, useRef, useState } from 'react';
import type { OwnerAnalysisClient } from './analysis-client';

export type OwnerAnalysisConnection = {
  analyze: OwnerAnalysisClient;
  dishId: string;
  venueId: string;
};

/** Auth/session comes from the caller. OpenAI credentials are never accepted by this component. */
export function OwnerAnalysisPanel({ connection }: { connection: OwnerAnalysisConnection }) {
  const [goal, setGoal] = useState<OwnerAnalysisRequest['goal']>('menu');
  const [state, setState] = useState<{
    kind: 'idle' | 'loading' | 'error' | 'result';
    result?: OwnerAnalysisResult;
    scope?: string;
  }>({ kind: 'idle' });
  const pending = useRef<AbortController | null>(null);
  const scope = `${connection.venueId}:${connection.dishId}:${goal}`;
  useEffect(() => {
    setState({ kind: 'idle' });
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [connection, goal]);
  const visible = state.scope === scope ? state : { kind: 'idle' as const };
  const run = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ kind: 'loading', scope });
    try {
      const result = await connection.analyze(
        { dishId: connection.dishId, goal },
        controller.signal,
      );
      if (!controller.signal.aborted) setState({ kind: 'result', result, scope });
    } catch {
      if (!controller.signal.aborted) setState({ kind: 'error', scope });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const result = visible.kind === 'result' ? visible.result : undefined;
  return (
    <section
      className="ai-preview"
      aria-label="Connected owner analysis"
      aria-busy={visible.kind === 'loading'}
    >
      <h3>PeekaPlate AI</h3>
      <p>Synthetic development report. Suggestions are for review only.</p>
      <label>
        Review focus{' '}
        <select
          value={goal}
          onChange={(e) => setGoal(e.target.value as OwnerAnalysisRequest['goal'])}
        >
          <option value="menu">Menu presentation</option>
          <option value="engagement">Dish engagement</option>
          <option value="crm">CRM and customer retention</option>
        </select>
      </label>
      <button type="button" onClick={run} disabled={visible.kind === 'loading'}>
        Review report
      </button>
      {visible.kind === 'loading' && <p role="status">Reviewing the report…</p>}
      {visible.kind === 'error' && (
        <p role="alert">The report could not be reviewed. Check your session or try again later.</p>
      )}
      {result && (
        <div role="status">
          {result.status === 'review' && result.metric !== null ? (
            <>
              <h4>Suggested review</h4>
              <p>{OWNER_ANALYSIS_ACTIONS[result.metric]}</p>
              <p>
                {result.metric.replaceAll('_', ' ')}: {((result.value ?? 0) * 100).toFixed(1)}%
              </p>
            </>
          ) : (
            <>
              <h4>No recommendation</h4>
              <p>
                {result.reason === 'unsupported_goal'
                  ? 'This report has no customer-retention or CRM evidence.'
                  : 'There is not enough verified evidence to suggest a next step.'}
              </p>
            </>
          )}
          <p>
            Report window: {result.timeWindow.start} to {result.timeWindow.end} (end excluded).
          </p>
          <p>{OWNER_ANALYSIS_LIMITATION}</p>
          <p>No menu changes or customer messages are sent.</p>
        </div>
      )}
    </section>
  );
}
