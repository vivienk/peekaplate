import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createOwnerAnalysisClient } from './ai-preview/analysis-client';
import type { OwnerAnalysisConnection } from './ai-preview/OwnerAnalysisPanel';

declare const __OWNER_AI_LOCAL_PREVIEW__: boolean;

import './owner-dashboard.css';

// Development-only page served at /owner-dashboard.html; it is not part of the production build.
// It rebuilds the Owner Dashboard V2 (Simplified) prototype on the light token theme with
// fictional sample data only.
const root = document.getElementById('root');
if (!root) throw new Error('Owner dashboard root element is missing');

async function start() {
  let connection: OwnerAnalysisConnection | undefined;
  if (__OWNER_AI_LOCAL_PREVIEW__) {
    const response = await fetch('/__owner-ai/session', {
      headers: { 'X-Owner-AI-Local': '1' },
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('Local session unavailable');
    const session = await response.json();
    const analyze = createOwnerAnalysisClient({
      baseUrl: `${location.origin}/__owner-ai`,
      venueId: session.venueId,
      getAccessToken: async () => session.token,
    });
    connection = { analyze, venueId: session.venueId, dishId: session.dishId };
  }
  createRoot(root!).render(
    <StrictMode>
      <App {...(connection ? { ownerAnalysis: connection } : {})} />
    </StrictMode>,
  );
}
start().catch(() => {
  root.textContent = 'The local analysis session could not be started.';
});
