import type { OwnerDishReport } from '@peekaplate/contracts/owner-report';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { OwnerAuthRuntime, SignedInOwner } from '../auth/supabase-auth';
import { createOwnerAnalysisClient } from '../owner-dashboard/ai-preview/analysis-client';
import { OwnerAnalysisPanel } from '../owner-dashboard/ai-preview/OwnerAnalysisPanel';
import { ReportData } from '../owner-dashboard/report-data';
import { Button } from '../ui';
import { Icon } from './icons';
import { type OwnerPage, OwnerShell } from './OwnerShell';
import { fetchOwnerWorkspace, type WorkspaceState } from './workspace-api';
import './owner.css';
import './workspace.css';

export function OwnerWorkspace({
  auth,
  owner,
  apiBase,
  aiEnabled = false,
  onSessionExpired,
  onSignOut,
  signingOut,
}: {
  auth: OwnerAuthRuntime;
  owner: SignedInOwner;
  apiBase: string | null;
  /** Shows the #164 AI panel beside the live report. Off unless the build turns it on. */
  aiEnabled?: boolean;
  onSessionExpired: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState<OwnerPage>('overview');
  const pickerId = useId();
  // The report on screen, tagged with the restaurant it belongs to, so the AI panel never offers
  // one restaurant's dishes under another.
  const [shown, setShown] = useState<{ scope: string; report: OwnerDishReport } | null>(null);
  const getAccessToken = useCallback(() => auth.accessTokenFor(owner.id), [auth, owner.id]);

  useEffect(() => {
    if (!apiBase) return;
    void attempt;
    const controller = new AbortController();
    void fetchOwnerWorkspace({
      apiBase,
      actorId: owner.id,
      getAccessToken,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setState(result);
      if (result.kind === 'signed_out') onSessionExpired();
    });
    return () => controller.abort();
  }, [apiBase, owner.id, getAccessToken, attempt, onSessionExpired]);

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    setPage('overview');
    setAttempt((value) => value + 1);
  }, []);
  const accessFailure = useCallback(
    (kind: 'signed_out' | 'denied') => {
      if (kind === 'signed_out') onSessionExpired();
      else refresh();
    },
    [onSessionExpired, refresh],
  );
  const venues = state.kind === 'ready' ? state.venues : [];
  const selected =
    venues.find((venue) => venue.venueId === selectedId) ??
    (venues.length === 1 ? venues[0] : undefined);
  const pages = useMemo(
    () =>
      new Set<OwnerPage>(
        selected?.permission === 'owner' ? ['overview', 'performance'] : ['overview'],
      ),
    [selected?.permission],
  );
  const scope = selected ? `${owner.id}:${selected.venueId}` : '';
  const showReport = useCallback(
    (report: OwnerDishReport | null) => setShown(report ? { scope, report } : null),
    [scope],
  );
  const signOut = (
    <Button variant="text" disabled={signingOut} onClick={onSignOut}>
      Sign out
    </Button>
  );

  if (!apiBase)
    return (
      <main className="owner-workspace-state">
        <h1>You’re signed in</h1>
        <p>
          The restaurant workspace is unavailable here. Signing in alone grants no restaurant
          access.
        </p>
        {signOut}
      </main>
    );
  if (state.kind !== 'ready')
    return (
      <main className="owner-workspace-state">
        <h1>
          {state.kind === 'loading' ? 'Opening your workspace' : 'Restaurant workspace unavailable'}
        </h1>
        <p role={state.kind === 'loading' ? 'status' : 'alert'}>
          {state.kind === 'loading'
            ? 'Checking restaurant access…'
            : 'We could not confirm your restaurant access. Please try again.'}
        </p>
        {state.kind !== 'loading' && (
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        )}
        {signOut}
      </main>
    );
  if (venues.length === 0)
    return (
      <main className="owner-workspace-state">
        <h1>No restaurant access yet</h1>
        <p>Your account is ready. Contact PeekaPlate to connect your restaurant.</p>
        <Button variant="outline" onClick={refresh}>
          Check access again
        </Button>
        {signOut}
      </main>
    );

  const picker = (
    <div className="owner-workspace-picker">
      <label htmlFor={pickerId}>Restaurant</label>
      <select
        id={pickerId}
        value={selected?.venueId ?? ''}
        onChange={(event) => {
          setSelectedId(event.target.value);
          setPage('overview');
        }}
      >
        {!selected && <option value="">Choose a restaurant</option>}
        {venues.map((venue) => (
          <option key={venue.venueId} value={venue.venueId}>
            {venue.name}
          </option>
        ))}
      </select>
    </div>
  );
  if (!selected)
    return (
      <main className="owner-workspace-state">
        <h1>Choose a restaurant</h1>
        {picker}
        {signOut}
      </main>
    );

  const reportShown = page === 'performance' && shown?.scope === scope ? shown.report : null;
  const aside =
    aiEnabled && selected.permission === 'owner' && reportShown ? (
      <LiveAiPanel
        key={scope}
        apiBase={apiBase}
        venueId={selected.venueId}
        restaurantName={selected.name}
        getAccessToken={getAccessToken}
        dishes={reportShown.dishes}
      />
    ) : undefined;

  return (
    <div className="owner-root owner-workspace">
      <OwnerShell
        venueId={selected.venueId}
        restaurantName={selected.name}
        current={page}
        available={pages}
        visible={pages}
        onNavigate={(next) => {
          if (pages.has(next)) setPage(next);
        }}
        aside={aside}
        topbar={
          <div className="owner-workspace-toolbar">
            {picker}
            <Button variant="text" onClick={refresh}>
              Refresh access
            </Button>
            {signOut}
          </div>
        }
      >
        {page === 'performance' && selected.permission === 'owner' ? (
          <ReportData
            key={`${owner.id}:${selected.venueId}`}
            source={{ mode: 'live', apiBase, venueId: selected.venueId, getAccessToken }}
            onAccessFailure={accessFailure}
            onReport={showReport}
          />
        ) : (
          <section>
            <h1>Restaurant workspace</h1>
            <h2>{selected.name}</h2>
            <p>Access: {selected.permission === 'owner' ? 'Owner' : 'Editor'}</p>
            <p>Menu setup is not available here yet.</p>
          </section>
        )}
      </OwnerShell>
    </div>
  );
}

// The #164 analysis panel inside the live shell. Identity and restaurant come only from the signed-in
// workspace: the token getter is bound to this owner and the venue is the authorised selection.
// Dishes come from the report on screen; the panel sends only a dish ID and a review goal.
function LiveAiPanel({
  apiBase,
  venueId,
  restaurantName,
  getAccessToken,
  dishes,
}: {
  apiBase: string;
  venueId: string;
  restaurantName: string;
  getAccessToken: () => Promise<string | null>;
  dishes: OwnerDishReport['dishes'];
}) {
  const dishFieldId = useId();
  const [picked, setPicked] = useState('');
  const dishId = dishes.some((dish) => dish.dish_id === picked)
    ? picked
    : (dishes[0]?.dish_id ?? '');
  const analyze = useMemo(
    () => createOwnerAnalysisClient({ baseUrl: apiBase, venueId, getAccessToken }),
    [apiBase, venueId, getAccessToken],
  );
  const connection = useMemo(
    () => (dishId ? { analyze, venueId, dishId } : null),
    [analyze, venueId, dishId],
  );
  return (
    <aside className="owner-ai" aria-label="PeekaPlate AI">
      <div className="owner-ai__head">
        <div className="owner-ai__title">
          <span className="owner-ai__icon">
            <Icon name="spark" size={16} />
          </span>
          <h2>PeekaPlate AI</h2>
        </div>
        <div className="owner-chips">
          <span className="owner-chip owner-chip--surface">{restaurantName}</span>
        </div>
      </div>
      <div className="owner-ai__body">
        {connection ? (
          <>
            <div className="owner-ai__field">
              <label htmlFor={dishFieldId}>Dish</label>
              <select
                id={dishFieldId}
                className="pp-input"
                value={dishId}
                onChange={(event) => setPicked(event.target.value)}
              >
                {dishes.map((dish) => (
                  <option key={dish.dish_id} value={dish.dish_id}>
                    {dish.name}
                  </option>
                ))}
              </select>
            </div>
            <OwnerAnalysisPanel connection={connection} />
          </>
        ) : (
          <p className="owner-muted">There are no dishes in this report to review yet.</p>
        )}
      </div>
    </aside>
  );
}
