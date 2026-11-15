import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { OwnerAuthRuntime, SignedInOwner } from '../auth/supabase-auth';
import { ReportData } from '../owner-dashboard/report-data';
import { Button } from '../ui';
import { OwnerMenuWorkspace } from './OwnerMenuWorkspace';
import { type OwnerPage, OwnerShell } from './OwnerShell';
import { fetchOwnerWorkspace, type WorkspaceState } from './workspace-api';
import './owner.css';
import './workspace.css';

export function OwnerWorkspace({
  auth,
  owner,
  apiBase,
  onSessionExpired,
  onSignOut,
  signingOut,
}: {
  auth: OwnerAuthRuntime;
  owner: SignedInOwner;
  apiBase: string | null;
  onSessionExpired: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState<OwnerPage>('overview');
  const [dirty, setDirty] = useState(false);
  const canLeave = () =>
    !dirty || window.confirm('Leave these unsaved changes? Your saved draft stays available.');
  const pickerId = useId();
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
        selected?.permission === 'owner'
          ? ['overview', 'performance', 'menu']
          : ['overview', 'menu'],
      ),
    [selected?.permission],
  );
  const signOut = (
    <Button
      variant="text"
      disabled={signingOut}
      onClick={() => {
        if (canLeave()) onSignOut();
      }}
    >
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
          if (!canLeave()) return;
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

  return (
    <div className="owner-root owner-workspace">
      <OwnerShell
        venueId={selected.venueId}
        restaurantName={selected.name}
        current={page}
        available={pages}
        visible={pages}
        onNavigate={(next) => {
          if (pages.has(next) && canLeave()) setPage(next);
        }}
        topbar={
          <div className="owner-workspace-toolbar">
            {picker}
            <Button
              variant="text"
              onClick={() => {
                if (canLeave()) refresh();
              }}
            >
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
          />
        ) : (
          <>
            <p>Access: {selected.permission === 'owner' ? 'Owner' : 'Editor'}</p>
            <OwnerMenuWorkspace
              key={`${owner.id}:${selected.venueId}`}
              apiBase={apiBase}
              actorId={owner.id}
              venueId={selected.venueId}
              restaurantName={selected.name}
              section={page === 'menu' ? 'menu' : 'overview'}
              getAccessToken={getAccessToken}
              onAccessFailure={accessFailure}
              onDirtyChange={setDirty}
            />
          </>
        )}
      </OwnerShell>
    </div>
  );
}
