import {
  canonicalJson,
  type OwnerVenue,
  type RestaurantProfile,
  type RestaurantSetup,
} from '@peekaplate/contracts';
import {
  OWNER_REPORT_QUESTION_MAX_LENGTH,
  type OwnerReportQuestionResult,
} from '@peekaplate/contracts/owner-analysis';
import {
  isOwnerProductionCalendarVersion,
  OWNER_PRODUCTION_TODAY_VERSION,
  OWNER_REPORT_TIME_ZONE,
  type OwnerDishReport,
} from '@peekaplate/contracts/owner-report';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
  OwnerAnalysisAccessError,
  OwnerAnalysisReferenceError,
} from '../owner-dashboard/ai-preview/analysis-client';
import { mergeCategories } from '../owner-dashboard/category-field';
import { Btn } from '../owner-dashboard/controls';
import { Actions, type LiveMenuRow, Overview, type Page, Report } from '../owner-dashboard/pages';
import type { ReportState } from '../owner-dashboard/report-api';
import {
  formatOwnerReportTime,
  formatOwnerReportValue,
  OWNER_REPORT_STATE_TEXT,
  ReportView,
  useOwnerReport,
} from '../owner-dashboard/report-data';
import { createOwnerMenuClient, newCommandId, OwnerMenuApiError } from '../owner-menu/api';
import { Button, Input } from '../ui';
import { FirstDashboardAside, FirstDashboardTopbar } from './FirstDashboard';
import { Icon } from './icons';
import type { MenuSnapshot } from './menu-snapshot';
import { OwnerMenuWorkspace } from './OwnerMenuWorkspace';
import { type OwnerPage, OwnerShell } from './OwnerShell';
import { fetchOwnerActions, type OwnerActionsState } from './owner-actions-api';
import { createOwnerReportQuestionClient } from './report-question-client';
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
  /** Enables questions about the live report. Off unless the build turns it on. */
  aiEnabled?: boolean;
  dishAssistanceEnabled?: boolean;
  onSessionExpired: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [createdCategories, setCreatedCategories] = useState<Record<string, string[]>>({});
  const [navigation, setNavigation] = useState(0);
  const [firstProfile, setFirstProfile] = useState<{
    venueId: string;
    status: RestaurantProfile['status'];
    navigation: number;
  } | null>(null);
  const [deniedReportScope, setDeniedReportScope] = useState<string | null>(null);
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
  const reportScope = JSON.stringify([scope, apiBase]);
  const reportPage =
    activePage === 'overview' || activePage === 'report' || activePage === 'performance';
  const showAi =
    aiEnabled &&
    selected?.permission === 'owner' &&
    (reportPage || workspaceSetup.published === true);
  // Report pages and the composer use the same validated response and signed reference.
  // After a report denial, rechecking membership must not restart the background read in a loop.
  const {
    state: reportState,
    retry,
    reload,
    refreshing,
  } = useOwnerReport(
    apiBase &&
      selected?.permission === 'owner' &&
      (reportPage || (showAi && deniedReportScope !== reportScope))
      ? { mode: 'live', apiBase, venueId: selected.venueId, getAccessToken }
      : null,
  );
  useEffect(() => {
    if (reportState.kind === 'denied') {
      setDeniedReportScope(reportScope);
      // A former owner may still have editor access. Recheck before discarding an active draft.
      if (!reportPage && dirty) setAttempt((value) => value + 1);
      else accessFailure('denied');
    } else if (reportState.kind === 'signed_out') {
      accessFailure('signed_out');
    } else if (reportState.kind === 'ready') {
      setDeniedReportScope((current) => (current === reportScope ? null : current));
    }
  }, [reportState.kind, reportScope, reportPage, dirty, accessFailure]);
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

  const canRetryReport =
    reportState.kind === 'error' ||
    reportState.kind === 'unavailable' ||
    reportState.kind === 'invalid';
  const reportAvailability = (
    <FirstDashboardAside
      setup={workspaceSetup}
      ariaLabel="Analysis availability"
      reportStatus={
        showAi && deniedReportScope !== reportScope && reportState.kind !== 'ready'
          ? {
              message: reportPage
                ? 'Questions are unavailable until the report loads.'
                : OWNER_REPORT_STATE_TEXT[reportState.kind],
              refreshing,
              ...(canRetryReport && !reportPage ? { onRetry: retry } : {}),
            }
          : undefined
      }
    />
  );
  let aside = reportAvailability;
  if (showAi) {
    aside = (
      <OwnerReportAiAside
        key={reportScope}
        apiBase={apiBase}
        venueId={selected.venueId}
        restaurantName={selected.name}
        getAccessToken={getAccessToken}
        report={reportState.kind === 'ready' ? reportState.report : null}
        page={activePage}
        fallback={reportAvailability}
        showOverviewPeriod={activePage !== 'performance'}
        reportReference={reportState.kind === 'ready' ? reportState.reference : undefined}
        onOpenDishPerformance={() => openPage('performance')}
        onReloadReport={reload}
        onAccessFailure={accessFailure}
      />
    );
  }

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
          if (!canLeave()) return;
          setDeniedReportScope(null);
          refresh();
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
          addedCategories={createdCategories[scope] ?? []}
          onAddCategory={(category) =>
            setCreatedCategories((previous) => ({
              ...previous,
              [scope]: mergeCategories(previous[scope] ?? [], [category]),
            }))
          }
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
      {reportPage &&
        renderShell(
          <LiveDashboardReport
            key={scope}
            page={activePage}
            restaurantName={workspaceSetup.restaurantName}
            menu={menu?.dishes ?? []}
            state={reportState}
            retry={retry}
            refreshing={refreshing}
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
  restaurantName,
  menu,
  state,
  retry,
  refreshing,
  go,
}: {
  page: 'overview' | 'report' | 'performance';
  restaurantName: string;
  menu: LiveMenuRow[];
  state: ReportState;
  retry: () => void;
  refreshing: boolean;
  go: (page: Page) => void;
}) {
  const report = state.kind === 'ready' ? state.report : null;
  const reportRefresh =
    state.kind === 'ready' ||
    state.kind === 'unavailable' ||
    state.kind === 'invalid' ||
    (page === 'overview' && state.kind === 'error') ? (
      <div className="row">
        <Btn type="button" size="md" onClick={retry} disabled={refreshing}>
          Refresh report
        </Btn>
        <span className="muted" aria-live="polite">
          {refreshing ? 'Refreshing report…' : ''}
        </span>
      </div>
    ) : null;
  const reportContent = (
    <ReportView
      state={state}
      savedMenu={menu}
      onRetry={retry}
      refreshing={refreshing}
      refreshControl={page === 'performance' ? reportRefresh : undefined}
      presentation={page === 'performance' ? 'performance' : 'data'}
    />
  );
  const version = report?.report_metadata.calculation_version;
  const summaryDay = isOwnerProductionCalendarVersion(version);
  const live = {
    restaurantName,
    reportContent,
    reportRefresh,
    summary: report?.summary,
    summaryFreshness: report?.report_metadata.freshness.is_stale,
    summarySource: report?.source,
    summaryBatch: report?.report_metadata.calculation_version === 'production.batch.v1',
    summaryDay,
    summaryToday: version === OWNER_PRODUCTION_TODAY_VERSION,
    period: report
      ? reportPeriod(
          report.summary?.periods.current ?? report.report_metadata.date_window,
          summaryDay,
        )
      : undefined,
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

const PERIOD_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
// Report windows are end-exclusive, so the last day shown is the millisecond before the end.
function reportPeriod(window: { start_time: string; end_time: string }, pacific = false): string {
  if (pacific)
    return `${formatOwnerReportTime(window.start_time, OWNER_REPORT_TIME_ZONE)} – ${formatOwnerReportTime(window.end_time, OWNER_REPORT_TIME_ZONE)}`;
  const start = new Date(window.start_time);
  if (Date.parse(window.end_time) - start.getTime() === 300_000) {
    return `${window.start_time.slice(0, 10)} · ${window.start_time.slice(11, 16)}–${window.end_time.slice(11, 16)} UTC`;
  }
  const end = new Date(Math.max(start.getTime(), new Date(window.end_time).getTime() - 1));
  return PERIOD_FORMAT.formatRange(start, end);
}
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
// Show answers only for the exact report period on screen, compared as instants.
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
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'reference_error'; reference: string }
  | { kind: 'result'; result: OwnerReportQuestionResult };

const reportQuestionMetrics = {
  active_sessions: ['Visits', 'count'],
  open_rate: ['Open rate', 'rate'],
  avg_interaction_time_seconds: ['Average interaction time', 'seconds'],
  timing_coverage: ['Timing coverage', 'rate'],
  save_rate: ['Save rate', 'rate'],
  engagement_rate: ['Engagement rate', 'rate'],
  portion_previews_shown: ['2.5D previews shown', 'count'],
  comparisons_started: ['Comparisons started', 'count'],
  dish_opens: ['Restaurant-wide dish opens', 'count'],
  menu_sessions: ['Restaurant-wide visits', 'count'],
} as const;

type Period = Pick<OwnerDishReport['report_metadata']['date_window'], 'start_time' | 'end_time'>;
type AnswerEvidence =
  | { kind: 'verified'; window: Period; baseline?: Period }
  | { kind: 'mismatch'; periods: ReturnType<typeof periodPair> }
  | { kind: 'unverified' }
  | { kind: 'unsupported' };

function reportAnswerEvidence(
  result: OwnerReportQuestionResult,
  report: OwnerDishReport,
  displayedWindow: Period,
): AnswerEvidence {
  if (result.status === 'abstained' && result.reason === 'unsupported_question') {
    return { kind: 'unsupported' };
  }
  const summary = report.summary;
  const overview = result.overview;
  if (!overview) {
    return samePeriod(displayedWindow, result.timeWindow)
      ? { kind: 'verified', window: displayedWindow }
      : { kind: 'mismatch', periods: periodPair(displayedWindow, result.timeWindow) };
  }
  if (!summary) return { kind: 'unverified' };
  const period = overview.period === 'baseline' ? 'baseline' : 'current';
  const window = summary.periods[period];
  if (!samePeriod(window, result.timeWindow)) {
    return { kind: 'mismatch', periods: periodPair(window, result.timeWindow) };
  }
  let baseline: Period | undefined;
  if (overview.period === 'compare') {
    baseline = summary.periods.baseline;
    if (!samePeriod(baseline, overview.baselineWindow)) {
      return { kind: 'mismatch', periods: periodPair(baseline, overview.baselineWindow) };
    }
  }
  if (result.status === 'answered') {
    const { metric } = result;
    if (metric !== 'dish_opens' && metric !== 'menu_sessions') return { kind: 'unverified' };
    const counts = [summary[period][metric]];
    if (baseline) counts.push(summary.baseline[metric]);
    if (
      report.report_metadata.freshness.is_stale !== false ||
      result.points.length !== counts.length ||
      !counts.every(
        (count, index) =>
          (count.status === 'NORMAL' || count.status === 'VALID_ZERO') &&
          result.points[index]?.value === count.value,
      )
    ) {
      return { kind: 'unverified' };
    }
  }
  return baseline ? { kind: 'verified', window, baseline } : { kind: 'verified', window };
}

function ReportAnswer({
  answer,
}: {
  answer: Extract<OwnerReportQuestionResult, { status: 'answered' }>;
}) {
  const caption = useId();
  const [label, kind] = reportQuestionMetrics[answer.metric];
  const scale = kind === 'rate' ? 1 : Math.max(1, ...answer.points.map(({ value }) => value));
  const points = (
    <ul className="owner-ai__values" role="list">
      {answer.points.map(({ label, value }, index) => (
        <li key={`${label}:${index}`}>
          <span>{label}</span>
          <strong>{formatOwnerReportValue(value, kind)}</strong>
          {answer.chart && (
            <span className="owner-ai__chart-track" aria-hidden="true">
              <span style={{ inlineSize: `${(value / scale) * 100}%` }} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <h3>{label}</h3>
      {answer.chart ? (
        <figure className="owner-ai__chart" aria-labelledby={caption}>
          <figcaption id={caption} className="owner-visually-hidden">
            {label} chart
          </figcaption>
          {points}
        </figure>
      ) : (
        points
      )}
    </>
  );
}

type LiveAiPanelProps = {
  apiBase: string;
  venueId: string;
  restaurantName: string;
  getAccessToken: () => Promise<string | null>;
  report: OwnerDishReport;
  showOverviewPeriod: boolean;
  reportReference?: string | undefined;
  onOpenDishPerformance: () => void;
  onReloadReport: () => void;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  question: string;
  setQuestion: (question: string) => void;
};

// The draft belongs to the signed-in owner and restaurant. Responses belong to the displayed
// snapshot. Renewing the signature for that snapshot should only update the token for the next ask.
function OwnerReportAiAside({
  report,
  page,
  fallback,
  ...panel
}: Omit<LiveAiPanelProps, 'question' | 'setQuestion' | 'report'> & {
  report: OwnerDishReport | null;
  page: OwnerPage;
  fallback: ReactNode;
}) {
  const [question, setQuestion] = useState('');
  const hasReference = Boolean(panel.reportReference);
  const replyKey = useMemo(
    () =>
      report && hasReference
        ? `${page}:${canonicalJson({
            ...report,
            dishes: [...report.dishes].sort((a, b) => a.dish_id.localeCompare(b.dish_id)),
          })}`
        : page,
    [page, report, hasReference],
  );
  if (!report) return fallback;
  return (
    <LiveAiPanel
      key={replyKey}
      {...panel}
      report={report}
      question={question}
      setQuestion={setQuestion}
    />
  );
}

function LiveAiPanel({
  apiBase,
  venueId,
  restaurantName,
  getAccessToken,
  report,
  showOverviewPeriod,
  reportReference,
  onOpenDishPerformance,
  onReloadReport,
  onAccessFailure,
  question,
  setQuestion,
}: LiveAiPanelProps) {
  const inputId = useId();
  const [storedReply, setReply] = useState<Reply | null>(null);
  // The report can renew its signature without replacing its snapshot or the pending question.
  const reply =
    storedReply?.kind === 'reference_error' && storedReply.reference !== reportReference
      ? null
      : storedReply;
  const pending = useRef<AbortController | null>(null);
  const askReport = useMemo(
    () => createOwnerReportQuestionClient({ apiBase, venueId, getAccessToken }),
    [apiBase, venueId, getAccessToken],
  );
  const dishWindow = report.report_metadata.date_window;
  const summaryWindow = report.summary?.periods.current;
  const overviewWindow = showOverviewPeriod ? summaryWindow : undefined;
  const window = overviewWindow ?? dishWindow;
  const periodsDiffer =
    summaryWindow &&
    !samePeriod(summaryWindow, {
      start: dishWindow.start_time,
      end: dishWindow.end_time,
    });
  const differentDishWindow = showOverviewPeriod && periodsDiffer;
  const timeZoneIsPacific = isOwnerProductionCalendarVersion(
    report.report_metadata.calculation_version,
  );
  const result = reply?.kind === 'result' ? reply.result : undefined;
  const evidence = result ? reportAnswerEvidence(result, report, window) : undefined;
  const otherDishAnswer =
    result && !result.overview && differentDishWindow && samePeriod(dishWindow, result.timeWindow);
  let answerPeriodLabel = 'Answer period';
  if (result?.overview) {
    answerPeriodLabel =
      result.overview.period === 'baseline'
        ? 'Previous Overview period'
        : 'Current Overview period';
  }
  const busy = reply?.kind === 'loading';

  useLayoutEffect(() => () => pending.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || !reportReference || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setReply({ kind: 'loading' });
    try {
      const answer = await askReport(text, reportReference, controller.signal);
      if (!controller.signal.aborted) {
        setReply(
          answer.source === report.source ? { kind: 'result', result: answer } : { kind: 'error' },
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OwnerAnalysisAccessError) {
          setReply(null);
          onAccessFailure(error.status === 401 ? 'signed_out' : 'denied');
        } else {
          setReply(
            error instanceof OwnerAnalysisReferenceError
              ? { kind: 'reference_error', reference: reportReference }
              : { kind: 'error' },
          );
        }
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

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
            {overviewWindow ? 'Overview period' : 'Dish Performance period'}:{' '}
            {reportPeriod(window, timeZoneIsPacific)}
          </span>
        </div>
      </div>
      <div className="owner-ai__body" data-ai-state={reply?.kind ?? 'empty'} aria-live="polite">
        {differentDishWindow && (
          <div>
            <p>Dish Performance uses a different report period.</p>
            <Button variant="outline" onClick={onOpenDishPerformance}>
              Open Dish Performance to ask a question
            </Button>
          </div>
        )}
        {(!reportReference || reply?.kind === 'reference_error') && (
          <div role={reply?.kind === 'reference_error' ? 'alert' : undefined}>
            <p>
              {reply?.kind === 'reference_error'
                ? 'The report reference expired or changed. Reload the report, then ask again.'
                : 'Reload the report to ask a question about this period.'}
            </p>
            <Button variant="outline" onClick={onReloadReport}>
              Reload report
            </Button>
          </div>
        )}
        {reportReference && !reply && (
          <p className="owner-muted">
            {overviewWindow
              ? 'Ask about this report. Try “How many openings?”'
              : 'Ask about this report. Try “Chart the save rates by dish.”'}
          </p>
        )}
        {reportReference && !reply && !showOverviewPeriod && periodsDiffer && (
          <p className="owner-muted">Restaurant-wide opening totals use the Overview period.</p>
        )}
        {busy && (
          <p className="owner-muted" role="status">
            Checking the report…
          </p>
        )}
        {reply?.kind === 'error' && (
          <p className="owner-ai__error" role="alert">
            The report question could not be answered. Check your session or try again later.
          </p>
        )}
        {result && evidence && (
          <div className="owner-ai__answer">
            {evidence.kind === 'mismatch' && (
              <>
                <h3>Different report period</h3>
                <p>
                  The answer covers {evidence.periods.analysis}. The displayed report covers{' '}
                  {evidence.periods.report}.{' '}
                  {otherDishAnswer
                    ? 'Ask from Dish Performance for this period.'
                    : 'Reload the report before asking again.'}
                </p>
              </>
            )}
            {evidence.kind === 'unverified' && (
              <p>There is not enough verified evidence in this report to answer that question.</p>
            )}
            {evidence.kind === 'unsupported' && (
              <p>
                This report cannot answer that question. Ask about activity shown in this report.
              </p>
            )}
            {evidence.kind === 'verified' && (
              <>
                {result.status === 'answered' ? (
                  <ReportAnswer answer={result} />
                ) : (
                  <p>
                    There is not enough verified evidence in this report to answer that question.
                  </p>
                )}
                <p className="owner-muted">
                  {answerPeriodLabel}: {reportPeriod(evidence.window, timeZoneIsPacific)}
                </p>
                {evidence.baseline && (
                  <p className="owner-muted">
                    Previous Overview period: {reportPeriod(evidence.baseline, timeZoneIsPacific)}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <form className="owner-ai__composer" onSubmit={ask}>
        <label className="owner-visually-hidden" htmlFor={inputId}>
          Ask a report question
        </label>
        <input
          id={inputId}
          className="owner-ai__input"
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            pending.current?.abort();
            pending.current = null;
            setReply(null);
          }}
          placeholder="Ask a report question"
          required
          maxLength={OWNER_REPORT_QUESTION_MAX_LENGTH}
          disabled={!reportReference}
        />
        <button
          type="submit"
          className="owner-ai__send"
          disabled={busy || !reportReference || !question.trim()}
          aria-label="Send question"
        >
          <Icon name="send" size={18} />
        </button>
      </form>
    </aside>
  );
}
