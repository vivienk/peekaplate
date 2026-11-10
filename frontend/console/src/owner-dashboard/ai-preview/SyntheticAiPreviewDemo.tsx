import { useId, useState } from 'react';
import { type AiPreviewState, AiRecommendationPreview } from './AiRecommendationPreview';
import { syntheticAbstention, syntheticRecommendation } from './fixtures';
import './ai-preview.css';

const examples = {
  recommendation: { kind: 'result', result: syntheticRecommendation },
  abstained: { kind: 'result', result: syntheticAbstention },
  loading: { kind: 'loading' },
  error: { kind: 'error' },
  'insufficient-evidence': { kind: 'insufficient-evidence' },
  withheld: { kind: 'withheld' },
} satisfies Record<string, AiPreviewState>;

type Example = keyof typeof examples;

/** Demo caller for #105's existing panel/drawer; RES-03 owns future integration. */
export function SyntheticAiPreviewDemo() {
  const id = useId();
  const [example, setExample] = useState<Example>('recommendation');
  return (
    <details className="ai-preview-demo">
      <summary>Typed AI result preview</summary>
      <label htmlFor={id}>Synthetic preview state</label>
      <select
        id={id}
        value={example}
        onChange={(event) => setExample(event.target.value as Example)}
      >
        <option value="recommendation">Recommendation</option>
        <option value="abstained">Abstained</option>
        <option value="loading">Loading</option>
        <option value="error">Error</option>
        <option value="insufficient-evidence">Insufficient evidence</option>
        <option value="withheld">Withheld</option>
      </select>
      <AiRecommendationPreview state={examples[example]} />
    </details>
  );
}
