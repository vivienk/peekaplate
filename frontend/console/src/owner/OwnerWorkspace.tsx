import type { OwnerVenue, RestaurantProfile, RestaurantSetup } from '@peekaplate/contracts';
import {
  OWNER_ANALYSIS_ACTIONS,
  OWNER_ANALYSIS_LIMITATION,
  type OwnerAnalysisRequest,
  type OwnerAnalysisResult,
} from '@peekaplate/contracts/owner-analysis';
import type { OwnerDishReport } from '@peekaplate/contracts/owner-report';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { OwnerAuthRuntime, SignedInOwner } from '../auth/supabase-auth';
import type { RestaurantDetails as Details } from '../onboarding/details';
import { OnboardingLayout, OwnerAccountMenu } from '../onboarding/OnboardingLayout';
import { RestaurantDetails } from '../onboarding/RestaurantDetails';
import { focusScreenHeading } from '../onboarding/useHeadingFocus';
import {
  createOwnerAnalysisClient,
  OwnerAnalysisAccessError,
  OwnerAnalysisReferenceError,
} from '../owner-dashboard/ai-preview/analysis-client';
import { Actions, type LiveMenuRow, Overview, type Page, Report } from '../owner-dashboard/pages';
import { ReportView, useOwnerReport } from '../owner-dashboard/report-data';
import { createOwnerMenuClient, newCommandId, OwnerMenuApiError } from '../owner-menu/api';
import { Button, Input } from '../ui';
import { FirstDashboardAside, FirstDashboardTopbar } from './FirstDashboard';
import { Icon } from './icons';
import type { MenuSnapshot } from './menu-snapshot';
import { OwnerMenuWorkspace } from './OwnerMenuWorkspace';
import { type OwnerPage, OwnerShell } from './OwnerShell';
import { fetchOwnerActions, type OwnerActionsState } from './owner-actions-api';
import { OWNER_PAGE_LABELS } from './routes';
import { useOwnerPage } from './useOwnerPage';
import {
  createRestaurant,
  fetchOwnerWorkspace,
  readWorkspaceApiBase,
  restaurantDetailsSaver,
  type WorkspaceState,
} from './workspace-api';
import './owner.css';
import '../owner-dashboard/owner-dashboard.css';
import './workspace.css';

export function ownerDashboardPages(
  permission: string | undefined,
  verified: boolean,
  published: boolean | null,
): ReadonlySet<OwnerPage> {
  return new Set<OwnerPage>(
    permission === 'owner' && (verified || published === true)
      ? ['setup', 'overview', 'report', 'performance', 'menu', 'actions']
      : ['setup', 'menu'],
  );
}

export function OwnerWorkspace({
  auth,
  owner,
  apiBase,
  production = false,
  aiEnabled = false,
  dishAssistanceEnabled = false,
  onSessionExpired,
  onSignOut,
  signingOut,
}: {
  auth: OwnerAuthRuntime;
  owner: SignedInOwner;
  apiBase: string | null;
  production?: boolean;
  /** Shows the #164 AI panel beside the live report. Off unless the build turns it on. */
  aiEnabled?: boolean;
  dishAssistanceEnabled?: boolean;
  onSessionExpired: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [navigation, setNavigation] = useState(0);
  const [firstProfile, setFirstProfile] = useState<{
    venueId: string;
    status: RestaurantProfile['status'];
    navigation: number;
  } | null>(null);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [detailsRequested, setDetailsRequested] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canLeave = useCallback(
    () =>
      !dirty || window.confirm('Leave these unsaved changes? Your saved draft stays available.'),
    [dirty],
  );
  const resetView = useCallback(() => {
    setDetailsRequested(false);
    setNavigation((value) => value + 1);
  }, []);
  const [page, setPage] = useOwnerPage(production, canLeave, resetView);
  const [menuRead, setMenuRead] = useState<{ actor: string; value: MenuSnapshot | null } | null>(
    null,
  );
  const updateMenu = useCallback(
    (value: MenuSnapshot | null) => setMenuRead({ actor: owner.id, value }),
    [owner.id],
  );
  const [setupRead, setSetupRead] = useState<{ actor: string; value: RestaurantSetup } | null>(
    null,
  );
  const updateSetup = useCallback(
    (value: RestaurantSetup | null) => setSetupRead(value ? { actor: owner.id, value } : null),
    [owner.id],
  );
  const pickerId = useId();
  // The report on screen, tagged with the restaurant it belongs to, so the AI panel never offers
  // one restaurant's dishes under another.
  const [shown, setShown] = useState<{
    scope: string;
    report: OwnerDishReport;
    reference?: string | undefined;
  } | null>(null);
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
    setDetailsRequested(false);
    setFirstProfile(null);
    setState({ kind: 'loading' });
    setMenuRead(null);
    setSetupRead(null);
    setPage('setup', 'replace');
    setAttempt((value) => value + 1);
  }, [setPage]);
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
    (production || (!selectedId && venues.length === 1) ? venues[0] : undefined);
  const workspaceSetup =
    setupRead?.actor === owner.id && setupRead.value.venueId === selected?.venueId
      ? setupRead.value
      : {
          venueId: selected?.venueId ?? '',
          restaurantName: selected?.name ?? '',
          detailsStatus: 'unknown' as const,
          menuAdded: null,
          published: null,
        };
  const menu =
    menuRead?.actor === owner.id && menuRead.value?.venueId === selected?.venueId
      ? menuRead.value
      : null;
  const pages = ownerDashboardPages(
    selected?.permission,
    menu?.verified === true && menu.dishes.length > 0,
    workspaceSetup.published,
  );
  const activePage = pages.has(page) ? page : 'setup';
  const checkingPage = selected?.permission === 'owner' && !menuRead && !pages.has(page);
  const workspaceReady = state.kind === 'ready' && !checkingPage;
  const readyPage = workspaceReady ? (selected ? activePage : 'setup') : null;
  useEffect(() => {
    if (production && workspaceReady)
      setPage(selected && page === activePage ? page : 'setup', 'replace');
  }, [activePage, page, production, selected, setPage, workspaceReady]);
  useEffect(() => {
    if (!production || !readyPage) return;
    const previousTitle = document.title;
    document.title = `PeekaPlate · ${OWNER_PAGE_LABELS[readyPage]}`;
    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById('owner-content');
      if (!main) return;
      main.closest('.owner-main')?.scrollTo(0, 0);
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.title = previousTitle;
    };
  }, [production, readyPage]);
  useEffect(() => {
    if (!production || selected || state.kind !== 'ready' || !dirty) return;
    function onUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty, production, selected, state.kind]);
  const scope = selected ? `${owner.id}:${selected.venueId}` : '';
  const showReport = useCallback(
    (report: OwnerDishReport | null, reference?: string) =>
      setShown(report ? { scope, report, reference } : null),
    [scope],
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
  const testRestaurant =
    !production && apiBase && readWorkspaceApiBase(apiBase) ? (
      <CreateTestRestaurant
        key={`${owner.id}:${apiBase}`}
        apiBase={apiBase}
        getAccessToken={getAccessToken}
        canLeave={canLeave}
        onAccessFailure={accessFailure}
        onCreated={(venueId) => {
          refresh();
          setSelectedId(venueId);
          setDetailsRequested(true);
          setNavigation((value) => value + 1);
        }}
      />
    ) : null;

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
  if (venues.length === 0 && production)
    return (
      <FirstRestaurant
        apiBase={apiBase}
        actorId={owner.id}
        getAccessToken={getAccessToken}
        onAccessFailure={accessFailure}
        onDiscovered={(venues) => setState({ kind: 'ready', venues })}
        onSaved={(venue, profile) => {
          setFirstProfile({ venueId: venue.venueId, status: profile.status, navigation });
          setSelectedId(venue.venueId);
          setState({ kind: 'ready', venues: [venue] });
        }}
        onDirtyChange={setDirty}
        accountActions={signOut}
      />
    );
  if (venues.length === 0)
    return (
      <main className="owner-workspace-state">
        <h1>No restaurant access yet</h1>
        <p>
          {testRestaurant
            ? 'Your account is ready. Create a test restaurant to start, or check access to an existing restaurant.'
            : 'Your account is ready. Contact PeekaPlate to connect your restaurant.'}
        </p>
        {testRestaurant}
        <Button variant="outline" onClick={refresh}>
          Check access again
        </Button>
        {signOut}
      </main>
    );

  const picker =
    production && venues.length === 1 ? null : (
      <div className="owner-workspace-picker">
        <label htmlFor={pickerId}>Restaurant</label>
        <select
          id={pickerId}
          value={selected?.venueId ?? ''}
          onChange={(event) => {
            if (!canLeave()) return;
            setSelectedId(event.target.value);
            setMenuRead(null);
            setSetupRead(null);
            setDetailsRequested(false);
            setPage('setup');
          }}
        >
          {!selected && <option value="">Choose a restaurant</option>}
          {venues.map((venue) => (
            <option key={venue.venueId} value={venue.venueId}>
              {venue.name}
            </option>
          ))}
        </select>
        {testRestaurant}
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

  const reportShown =
    ['overview', 'report', 'performance'].includes(activePage) && shown?.scope === scope
      ? shown.report
      : null;
  const aside =
    aiEnabled && selected.permission === 'owner' && reportShown ? (
      <LiveAiPanel
        key={scope}
        apiBase={apiBase}
        venueId={selected.venueId}
        restaurantName={selected.name}
        getAccessToken={getAccessToken}
        report={reportShown}
        reportReference={shown?.scope === scope ? shown.reference : undefined}
        onReloadReport={() => {
          setShown(null);
          setReportAttempt((value) => value + 1);
        }}
        onAccessFailure={accessFailure}
      />
    ) : (
      <FirstDashboardAside setup={workspaceSetup} ariaLabel="Analysis availability" />
    );

  const accountActions = (
    <>
      {picker}
      <Button
        variant="text"
        onClick={() => {
          if (!canLeave()) return;
          setDetailsRequested(true);
          setPage('setup');
          setNavigation((value) => value + 1);
        }}
      >
        Restaurant details
      </Button>
      <Button
        variant="text"
        onClick={() => {
          if (canLeave()) refresh();
        }}
      >
        Refresh access
      </Button>
      {signOut}
      {!production && (
        <small className="owner-workspace-design-note">
          (Account placement awaiting design review)
        </small>
      )}
    </>
  );
  const openPage = (next: OwnerPage) => {
    if (!pages.has(next) || !canLeave()) return;
    setPage(next);
    resetView();
  };
  const renderShell = (content: ReactNode) => (
    <div className="owner-root owner-workspace">
      <OwnerShell
        venueId={selected.venueId}
        restaurantName={workspaceSetup.restaurantName}
        current={activePage}
        available={pages}
        lockedHint="Verify every saved dish to open the dashboard. Publication remains a separate step."
        visible={
          new Set<OwnerPage>(['overview', 'report', 'performance', 'menu', 'actions', 'setup'])
        }
        onNavigate={openPage}
        aside={aside}
        topbar={
          <div className="owner-workspace-toolbar">
            <FirstDashboardTopbar setup={workspaceSetup} />
            <OwnerAccountMenu>{accountActions}</OwnerAccountMenu>
          </div>
        }
      >
        {content}
      </OwnerShell>
    </div>
  );
  const navigate = (next: Page) => {
    const target: OwnerPage =
      next === 'perf' || next === 'data' || next === 'dish'
        ? 'performance'
        : next === 'welcome'
          ? 'setup'
          : next;
    openPage(target);
  };
  const showMenu = activePage === 'menu' || activePage === 'setup';
  return (
    <>
      {(showMenu || production) && (
        <OwnerMenuWorkspace
          key={scope}
          active={showMenu}
          apiBase={apiBase}
          actorId={owner.id}
          venueId={selected.venueId}
          restaurantName={selected.name}
          canPublish={selected.permission === 'owner'}
          dishAssistanceEnabled={dishAssistanceEnabled}
          section={activePage === 'menu' ? 'menu' : 'overview'}
          navigation={navigation}
          detailsRequested={detailsRequested}
          offerInitialDetails={
            production && selected.permission === 'owner' && activePage === 'setup'
          }
          firstProfileStatus={
            firstProfile?.venueId === selected.venueId && firstProfile.navigation === navigation
              ? firstProfile.status
              : undefined
          }
          getAccessToken={getAccessToken}
          onAccessFailure={accessFailure}
          onDirtyChange={setDirty}
          onSetupChange={updateSetup}
          onMenuChange={updateMenu}
          renderShell={renderShell}
          accountActions={accountActions}
        />
      )}
      {activePage === 'actions' &&
        renderShell(
          <LiveActions
            key={scope}
            apiBase={apiBase}
            venueId={selected.venueId}
            restaurantName={workspaceSetup.restaurantName}
            getAccessToken={getAccessToken}
            onAccessFailure={accessFailure}
          />,
        )}
      {(activePage === 'overview' || activePage === 'report' || activePage === 'performance') &&
        renderShell(
          <LiveDashboardReport
            key={`${scope}:${reportAttempt}`}
            page={activePage}
            apiBase={apiBase}
            venueId={selected.venueId}
            restaurantName={workspaceSetup.restaurantName}
            menu={menu?.dishes ?? []}
            getAccessToken={getAccessToken}
            onAccessFailure={accessFailure}
            onReport={showReport}
            go={navigate}
          />,
        )}
    </>
  );
}

function FirstRestaurant({
  apiBase,
  actorId,
  getAccessToken,
  onAccessFailure,
  onDiscovered,
  onSaved,
  onDirtyChange,
  accountActions,
}: {
  apiBase: string;
  actorId: string;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onDiscovered: (venues: OwnerVenue[]) => void;
  onSaved: (venue: OwnerVenue, profile: RestaurantProfile) => void;
  onDirtyChange: (dirty: boolean) => void;
  accountActions: ReactNode;
}) {
  const pending = useRef<AbortController | null>(null);
  const creation = useRef<{ name: string; commandId: string; venue?: OwnerVenue } | null>(null);
  const [saveDetails] = useState(restaurantDetailsSaver);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    focusScreenHeading();
    return () => pending.current?.abort();
  }, []);

  async function save(details: Details, photo: File | null) {
    if (pending.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    pending.current = controller;
    setBusy(true);
    setFailed(false);
    const attempt = (creation.current ??= { name: details.name, commandId: newCommandId() });
    async function checkMembership() {
      const result = await fetchOwnerWorkspace({ apiBase, actorId, getAccessToken, signal });
      if (signal.aborted) return;
      if (result.kind === 'ready' && result.venues.length) onDiscovered(result.venues);
      else if (result.kind === 'signed_out') onAccessFailure('signed_out');
      else setFailed(true);
    }
    try {
      if (!attempt.venue) {
        const result = await createRestaurant({ apiBase, getAccessToken, signal, ...attempt });
        if (signal.aborted) return;
        if (result.kind === 'conflict') return await checkMembership();
        if (result.kind === 'signed_out' || result.kind === 'denied')
          return onAccessFailure(result.kind);
        if (result.kind !== 'created') return setFailed(true);
        attempt.venue = result.venue;
      }
      const client = createOwnerMenuClient({ baseUrl: apiBase, getToken: getAccessToken, signal });
      const profile = await saveDetails(client, attempt.venue.venueId, details, photo, null);
      if (signal.aborted) return;
      if (profile) onSaved(attempt.venue, profile);
      else setFailed(true);
    } catch (reason) {
      if (signal.aborted) return;
      if (reason instanceof OwnerMenuApiError) {
        if (reason.status === 401 || reason.status === 403)
          return onAccessFailure(reason.status === 401 ? 'signed_out' : 'denied');
        if (reason.status === 409) return await checkMembership();
      }
      setFailed(true);
    } finally {
      pending.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <OnboardingLayout accountActions={accountActions}>
      <RestaurantDetails
        mode="onboarding"
        saving={busy}
        saveFailed={failed}
        onSave={(details, photo) => void save(details, photo)}
        onDirtyChange={onDirtyChange}
      />
    </OnboardingLayout>
  );
}

function CreateTestRestaurant({
  apiBase,
  getAccessToken,
  canLeave,
  onAccessFailure,
  onCreated,
}: {
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  canLeave: () => boolean;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onCreated: (venueId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const pending = useRef<AbortController | null>(null);
  const command = useRef<{ commandId: string; name: string } | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || !canLeave()) return;
    const trimmed = name.trim();
    if (command.current?.name !== trimmed)
      command.current = { commandId: crypto.randomUUID(), name: trimmed };
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    const result = await createRestaurant({
      apiBase,
      ...command.current,
      getAccessToken,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    pending.current = null;
    setBusy(false);
    if (result.kind === 'created') {
      onCreated(result.venue.venueId);
      return;
    }
    if (result.kind === 'signed_out' || result.kind === 'denied') {
      onAccessFailure(result.kind);
      return;
    }
    setError(
      result.kind === 'quota'
        ? 'Your test restaurant limit has been reached. Use an existing restaurant.'
        : result.kind === 'conflict'
          ? 'This request was already used with a different name. Enter a new name to start another request.'
          : result.kind === 'invalid'
            ? 'Enter a restaurant name of 1–160 characters without control characters, then try again.'
            : 'We could not confirm creation. Retry with the same name to safely check the same request.',
    );
  };
  return open ? (
    <form onSubmit={(event) => void create(event)} aria-label="Create test restaurant">
      <label htmlFor={id}>Test restaurant name (Staging testing)</label>
      <Input
        id={id}
        value={name}
        required
        maxLength={160}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Creating test restaurant…' : 'Create test restaurant'}
      </Button>
    </form>
  ) : (
    <Button variant="outline" onClick={() => setOpen(true)}>
      Create test restaurant (Staging testing)
    </Button>
  );
}

const noop = () => {};
function LiveDashboardReport({
  page,
  apiBase,
  venueId,
  restaurantName,
  menu,
  getAccessToken,
  onAccessFailure,
  onReport,
  go,
}: {
  page: 'overview' | 'report' | 'performance';
  apiBase: string;
  venueId: string;
  restaurantName: string;
  menu: LiveMenuRow[];
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onReport: (report: OwnerDishReport | null, reference?: string) => void;
  go: (page: Page) => void;
}) {
  const { state, retry } = useOwnerReport({ mode: 'live', apiBase, venueId, getAccessToken });
  const report = state.kind === 'ready' ? state.report : null;
  const reference = state.kind === 'ready' ? state.reference : undefined;
  useEffect(() => {
    onReport(report, reference);
  }, [report, reference, onReport]);
  useEffect(() => () => onReport(null), [onReport]);
  useEffect(() => {
    if (state.kind === 'signed_out' || state.kind === 'denied') onAccessFailure(state.kind);
  }, [state.kind, onAccessFailure]);
  const reportContent = (
    <ReportView
      state={state}
      onRetry={retry}
      presentation={page === 'performance' ? 'performance' : 'data'}
    />
  );
  const live = {
    restaurantName,
    reportContent,
    summary: report?.summary,
    summaryFreshness: report?.report_metadata.freshness.is_stale,
    summarySource: report?.source,
    period: report ? reportPeriod(report.report_metadata.date_window) : undefined,
  };
  return (
    <div className="owner-dashboard-content">
      {page === 'performance' ? (
        reportContent
      ) : page === 'report' ? (
        <Report live={live} go={go} acts={{}} setAct={noop} />
      ) : (
        <Overview
          live={{ ...live, menu }}
          go={go}
          acts={{}}
          sim={{ scn: 'empty' }}
          openDish={() => go('menu')}
          openInsight={() => go('report')}
        />
      )}
    </div>
  );
}

function LiveActions({
  apiBase,
  venueId,
  restaurantName,
  getAccessToken,
  onAccessFailure,
}: {
  apiBase: string;
  venueId: string;
  restaurantName: string;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
}) {
  const [state, setState] = useState<OwnerActionsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void attempt;
    setState({ kind: 'loading' });
    void fetchOwnerActions({ apiBase, venueId, getAccessToken, signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setState(result);
        if (result.kind === 'signed_out' || result.kind === 'denied') onAccessFailure(result.kind);
      },
    );
    return () => controller.abort();
  }, [apiBase, venueId, getAccessToken, onAccessFailure, attempt]);
  return (
    <div className="owner-dashboard-content">
      <Actions
        acts={{}}
        setAct={noop}
        editDish={noop}
        openInsight={noop}
        sim={{ scn: 'empty' }}
        live={{
          restaurantName,
          actionsStatus:
            state.kind === 'ready' ? 'ready' : state.kind === 'loading' ? 'loading' : 'unavailable',
          actions:
            state.kind === 'ready'
              ? state.actions.map((action) => ({
                  id: action.actionId,
                  title: action.category.replaceAll('_', ' '),
                  text: action.note ?? 'No note recorded.',
                  status: action.status,
                }))
              : [],
        }}
      />
      {state.kind === 'unavailable' && (
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry saved actions
        </Button>
      )}
    </div>
  );
}

// PeekaPlate AI panel in the live shell, built on Rania's "AI panel" component (Figma 2462:15103):
// header with restaurant and report-period chips, intro text, messages, composer. Identity and
// restaurant come only from the signed-in workspace: the token getter is bound to this owner and the
// venue is the authorised selection. The analysis API (#164) takes a dish and a review focus rather
// than free text, so typed questions can only select a focus for the displayed report.
const FOCUS_OPTIONS: { value: OwnerAnalysisRequest['goal']; label: string }[] = [
  { value: 'menu', label: 'Menu presentation' },
  { value: 'engagement', label: 'Dish engagement' },
  { value: 'crm', label: 'Customer retention (CRM)' },
];

export function matchReportQuestion(question: string): OwnerAnalysisRequest['goal'] | null {
  const text = question
    .trim()
    .toLowerCase()
    .replace(/[?.!]$/, '')
    .trim();
  switch (text) {
    case 'dish engagement':
    case 'how is engagement for this dish':
      return 'engagement';
    case 'menu presentation':
    case 'dish saves':
      return 'menu';
    case 'customer retention':
    case 'how can i improve customer retention':
      return 'crm';
    default:
      return null;
  }
}
const PERIOD_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
// Report windows are end-exclusive, so the last day shown is the millisecond before the end.
function reportPeriod(window: { start_time: string; end_time: string }): string {
  const start = new Date(window.start_time);
  const end = new Date(Math.max(start.getTime(), new Date(window.end_time).getTime() - 1));
  return PERIOD_FORMAT.formatRange(start, end);
}
const percent = (value: number | null) => `${((value ?? 0) * 100).toFixed(1)}%`;
const EXACT_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});
// Two periods named for the owner: by date, or with exact UTC times when the dates read the same
// (a rolling window shifted by seconds would otherwise look identical).
export function periodPair(
  report: { start_time: string; end_time: string },
  analysis: { start: string; end: string },
): { report: string; analysis: string } {
  const analysisWindow = { start_time: analysis.start, end_time: analysis.end };
  const byDate = { report: reportPeriod(report), analysis: reportPeriod(analysisWindow) };
  if (byDate.report !== byDate.analysis) return byDate;
  const exact = (window: { start_time: string; end_time: string }) =>
    `${EXACT_FORMAT.format(new Date(window.start_time))} – ${EXACT_FORMAT.format(new Date(window.end_time))}`;
  return { report: exact(report), analysis: exact(analysisWindow) };
}
// The analysis reads its own server snapshot. Its suggestion is shown only when that snapshot
// covers exactly the report period on screen (compared as instants, so "…07:00:00Z" and
// "…07:00:00.000Z" match); otherwise it would read as advice about numbers the owner isn't seeing.
export function samePeriod(
  report: { start_time: string; end_time: string },
  analysis: { start: string; end: string },
): boolean {
  const at = (value: string) => Date.parse(value);
  return (
    Number.isFinite(at(report.start_time)) &&
    at(report.start_time) === at(analysis.start) &&
    at(report.end_time) === at(analysis.end)
  );
}

type Reply =
  | { kind: 'loading'; scope: string }
  | { kind: 'error'; scope: string }
  | { kind: 'reference_error'; scope: string }
  | { kind: 'result'; scope: string; result: OwnerAnalysisResult; dishName: string };

function LiveAiPanel({
  apiBase,
  venueId,
  restaurantName,
  getAccessToken,
  report,
  reportReference,
  onReloadReport,
  onAccessFailure,
}: {
  apiBase: string;
  venueId: string;
  restaurantName: string;
  getAccessToken: () => Promise<string | null>;
  report: OwnerDishReport;
  reportReference?: string | undefined;
  onReloadReport: () => void;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
}) {
  const ids = useId();
  const dishes = report.dishes;
  const [picked, setPicked] = useState('');
  const [goal, setGoal] = useState<OwnerAnalysisRequest['goal']>('menu');
  const [question, setQuestion] = useState('');
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const pending = useRef<AbortController | null>(null);
  const dishId = dishes.some((dish) => dish.dish_id === picked)
    ? picked
    : (dishes[0]?.dish_id ?? '');
  const requestGoal = question.trim() ? matchReportQuestion(question) : goal;
  const scope = `${venueId}:${dishId}:${requestGoal}:${report.report_metadata.date_window.start_time}:${report.report_metadata.date_window.end_time}:${report.report_metadata.generated_at}:${reportReference ?? ''}`;
  const analyze = useMemo(
    () => createOwnerAnalysisClient({ baseUrl: apiBase, venueId, getAccessToken }),
    [apiBase, venueId, getAccessToken],
  );
  // A reply belongs to one restaurant, dish and focus; changing any of them hides it and stops a
  // request still on its way.
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [analyze, scope],
  );
  const shown = reply?.scope === scope ? reply : null;

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!dishId || !reportReference || pending.current) return;
    if (!requestGoal) {
      setQuestionError(
        'Use the focus menu or type “Dish engagement”, “Menu presentation”, “Dish saves”, or “Customer retention”. The review uses the displayed dish and report period.',
      );
      return;
    }
    setQuestionError(null);
    const controller = new AbortController();
    pending.current = controller;
    const dishName = dishes.find((dish) => dish.dish_id === dishId)?.name ?? '';
    const requestScope = scope;
    setReply({ kind: 'loading', scope: requestScope });
    try {
      const result = await analyze(
        { dishId, goal: requestGoal },
        controller.signal,
        reportReference,
      );
      if (!controller.signal.aborted)
        setReply({ kind: 'result', scope: requestScope, result, dishName });
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OwnerAnalysisAccessError) {
          setReply(null);
          onAccessFailure(error.status === 401 ? 'signed_out' : 'denied');
        } else if (error instanceof OwnerAnalysisReferenceError) {
          setReply({ kind: 'reference_error', scope: requestScope });
        } else setReply({ kind: 'error', scope: requestScope });
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  const busy = shown?.kind === 'loading';
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
          <span className="owner-chip owner-chip--surface">
            Displayed report period: {reportPeriod(report.report_metadata.date_window)}
          </span>
        </div>
      </div>
      <div className="owner-ai__body" data-ai-state={shown?.kind ?? 'empty'} aria-live="polite">
        {!reportReference && (
          <p className="owner-muted">
            Analysis needs a current server report reference. Reload the report; analysis stays
            unavailable if no reference is issued.
          </p>
        )}
        <p className="owner-muted">
          {report.source === 'production'
            ? 'Analysis uses the same authorized report window shown here.'
            : 'Choose a dish for analysis from a separate authorized server-read snapshot. Its evidence period may differ from the report displayed here.'}
        </p>
        {dishes.length === 0 && (
          <>
            <h3>No questions yet</h3>
            <p className="owner-muted">There are no dishes in this report to ask about yet.</p>
          </>
        )}
        {dishes.length > 0 && !shown && (
          <>
            <h3>No questions yet</h3>
            <p className="owner-muted">
              Choose a dish and a focus below. Suggestions are for review only; nothing is changed
              or sent to diners.
            </p>
          </>
        )}
        {shown?.kind === 'loading' && (
          <p className="owner-muted" role="status">
            Reviewing the report…
          </p>
        )}
        {shown?.kind === 'error' && (
          <p className="owner-ai__error" role="alert">
            The report could not be reviewed. Check your session or try again later.
          </p>
        )}
        {shown?.kind === 'reference_error' && (
          <div role="alert">
            <p>The report reference expired or changed. Reload the report, then ask again.</p>
            <Button variant="outline" onClick={onReloadReport}>
              Reload report
            </Button>
          </div>
        )}
        {shown?.kind === 'result' &&
          !samePeriod(report.report_metadata.date_window, shown.result.timeWindow) && (
            <div className="owner-ai__answer" data-ai-period="mismatch">
              <h3>Different report period</h3>
              {(() => {
                const periods = periodPair(
                  report.report_metadata.date_window,
                  shown.result.timeWindow,
                );
                return (
                  <p>
                    This analysis was calculated for {periods.analysis}, which is not exactly the
                    report period shown here ({periods.report}). Its suggestion is not shown, so it
                    can’t be mistaken for advice about these numbers.
                  </p>
                );
              })()}
              <p className="owner-muted">
                Suggestions appear only when the analysis and the report on screen cover the same
                period. No menu changes or customer messages are sent.
              </p>
            </div>
          )}
        {shown?.kind === 'result' &&
          samePeriod(report.report_metadata.date_window, shown.result.timeWindow) && (
            <div className="owner-ai__answer">
              {shown.result.status === 'review' && shown.result.metric !== null ? (
                <>
                  <h3>Suggested review: {shown.dishName}</h3>
                  <p>{OWNER_ANALYSIS_ACTIONS[shown.result.metric]}</p>
                  <p className="owner-muted">
                    {shown.result.metric.replaceAll('_', ' ')}: {percent(shown.result.value)}
                  </p>
                </>
              ) : (
                <>
                  <h3>No recommendation for {shown.dishName}</h3>
                  <p>
                    {shown.result.reason === 'unsupported_goal'
                      ? 'This report has no customer-retention or CRM evidence.'
                      : 'There is not enough verified evidence to suggest a next step.'}
                  </p>
                </>
              )}
              <p className="owner-muted">
                Analysis evidence period:{' '}
                {reportPeriod({
                  start_time: shown.result.timeWindow.start,
                  end_time: shown.result.timeWindow.end,
                })}
              </p>
              <p className="owner-muted">
                {shown.result.source === 'production'
                  ? 'Analysis from the authorized production report.'
                  : 'Synthetic analysis from a separate server-read snapshot.'}
              </p>
              <p className="owner-muted">{OWNER_ANALYSIS_LIMITATION}</p>
              <p className="owner-muted">No menu changes or customer messages are sent.</p>
            </div>
          )}
      </div>
      <form className="owner-ai__composer owner-ai__composer--pickers" onSubmit={ask}>
        <label className="owner-visually-hidden" htmlFor={`${ids}-question`}>
          Ask a report question
        </label>
        <input
          id={`${ids}-question`}
          className="owner-ai__input"
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            setQuestionError(null);
            pending.current?.abort();
            pending.current = null;
            setReply(null);
          }}
          placeholder="Type a review focus, e.g. Dish engagement"
          disabled={dishes.length === 0}
        />
        {questionError && (
          <p className="owner-ai__error" role="alert">
            {questionError}
          </p>
        )}
        <label className="owner-visually-hidden" htmlFor={`${ids}-dish`}>
          Dish
        </label>
        <select
          id={`${ids}-dish`}
          className="owner-ai__input"
          value={dishId}
          disabled={dishes.length === 0}
          onChange={(event) => setPicked(event.target.value)}
        >
          {dishes.map((dish) => (
            <option key={dish.dish_id} value={dish.dish_id}>
              {dish.name}
            </option>
          ))}
        </select>
        <div className="owner-ai__row">
          <label className="owner-visually-hidden" htmlFor={`${ids}-focus`}>
            Review focus
          </label>
          <select
            id={`${ids}-focus`}
            className="owner-ai__input"
            value={requestGoal ?? goal}
            onChange={(event) => {
              setGoal(event.target.value as OwnerAnalysisRequest['goal']);
              setQuestion('');
              setQuestionError(null);
            }}
          >
            {FOCUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="owner-ai__send"
            disabled={busy || dishes.length === 0 || !reportReference}
            aria-label="Review report"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      </form>
    </aside>
  );
}
