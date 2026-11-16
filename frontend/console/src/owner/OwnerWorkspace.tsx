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
import { OwnerAccountMenu } from '../onboarding/OnboardingLayout';
import {
  createOwnerAnalysisClient,
  OwnerAnalysisAccessError,
} from '../owner-dashboard/ai-preview/analysis-client';
import { ReportData } from '../owner-dashboard/report-data';
import { Button } from '../ui';
import { FirstDashboardAside, FirstDashboardTopbar } from './FirstDashboard';
import { Icon } from './icons';
import { OwnerMenuWorkspace } from './OwnerMenuWorkspace';
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
  const [page, setPage] = useState<OwnerPage>('setup');
  const [navigation, setNavigation] = useState(0);
  const [dirty, setDirty] = useState(false);
  const canLeave = () =>
    !dirty || window.confirm('Leave these unsaved changes? Your saved draft stays available.');
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
    setPage('setup');
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
        selected?.permission === 'owner' ? ['setup', 'performance', 'menu'] : ['setup', 'menu'],
      ),
    [selected?.permission],
  );
  const scope = selected ? `${owner.id}:${selected.venueId}` : '';
  const showReport = useCallback(
    (report: OwnerDishReport | null) => setShown(report ? { scope, report } : null),
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
        report={reportShown}
        onAccessFailure={accessFailure}
      />
    ) : (
      <FirstDashboardAside
        setup={{
          venueId: selected.venueId,
          restaurantName: selected.name,
          detailsStatus: 'unknown',
          menuAdded: null,
          published: null,
        }}
        ariaLabel="Analysis availability"
      />
    );

  const renderShell = (content: ReactNode) => (
    <div className="owner-root owner-workspace">
      <OwnerShell
        venueId={selected.venueId}
        restaurantName={selected.name}
        current={page}
        available={pages}
        lockedHint="Some screens are not connected in this workspace yet."
        visible={
          new Set<OwnerPage>(['overview', 'report', 'performance', 'menu', 'actions', 'setup'])
        }
        onNavigate={(next) => {
          if (pages.has(next) && canLeave()) {
            setPage(next);
            setNavigation((value) => value + 1);
          }
        }}
        aside={aside}
        topbar={
          <div className="owner-workspace-toolbar">
            <FirstDashboardTopbar
              setup={{
                venueId: selected.venueId,
                restaurantName: selected.name,
                detailsStatus: 'unknown',
                menuAdded: null,
                published: null,
              }}
            />
            <OwnerAccountMenu>
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
            </OwnerAccountMenu>
          </div>
        }
      >
        {content}
      </OwnerShell>
    </div>
  );
  return page === 'performance' && selected.permission === 'owner' ? (
    renderShell(
      <ReportData
        presentation="performance"
        key={`${owner.id}:${selected.venueId}`}
        source={{ mode: 'live', apiBase, venueId: selected.venueId, getAccessToken }}
        onAccessFailure={accessFailure}
        onReport={showReport}
      />,
    )
  ) : (
    <OwnerMenuWorkspace
      key={`${owner.id}:${selected.venueId}`}
      apiBase={apiBase}
      actorId={owner.id}
      venueId={selected.venueId}
      restaurantName={selected.name}
      canPublish={selected.permission === 'owner'}
      section={page === 'menu' ? 'menu' : 'overview'}
      navigation={navigation}
      getAccessToken={getAccessToken}
      onAccessFailure={accessFailure}
      onDirtyChange={setDirty}
      renderShell={renderShell}
      accountActions={
        <>
          {picker}
          {signOut}
        </>
      }
    />
  );
}

// PeekaPlate AI panel in the live shell, built on Rania's "AI panel" component (Figma 2462:15103):
// header with restaurant and report-period chips, intro text, messages, composer. Identity and
// restaurant come only from the signed-in workspace: the token getter is bound to this owner and the
// venue is the authorised selection. The analysis API (#164) takes a dish and a review focus rather
// than free text, so the composer offers those two pickers in place of Figma's text box (design gap
// flagged for Rania). Only `{ dishId, goal }` is sent; nothing is published or changed.
const FOCUS_OPTIONS: { value: OwnerAnalysisRequest['goal']; label: string }[] = [
  { value: 'menu', label: 'Menu presentation' },
  { value: 'engagement', label: 'Dish engagement' },
  { value: 'crm', label: 'Customer retention (CRM)' },
];
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

type Reply =
  | { kind: 'loading'; scope: string }
  | { kind: 'error'; scope: string }
  | { kind: 'result'; scope: string; result: OwnerAnalysisResult; dishName: string };

function LiveAiPanel({
  apiBase,
  venueId,
  restaurantName,
  getAccessToken,
  report,
  onAccessFailure,
}: {
  apiBase: string;
  venueId: string;
  restaurantName: string;
  getAccessToken: () => Promise<string | null>;
  report: OwnerDishReport;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
}) {
  const ids = useId();
  const dishes = report.dishes;
  const [picked, setPicked] = useState('');
  const [goal, setGoal] = useState<OwnerAnalysisRequest['goal']>('menu');
  const [reply, setReply] = useState<Reply | null>(null);
  const pending = useRef<AbortController | null>(null);
  const dishId = dishes.some((dish) => dish.dish_id === picked)
    ? picked
    : (dishes[0]?.dish_id ?? '');
  const scope = `${venueId}:${dishId}:${goal}:${report.report_metadata.date_window.start_time}:${report.report_metadata.date_window.end_time}:${report.report_metadata.generated_at}`;
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
    if (!dishId || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const dishName = dishes.find((dish) => dish.dish_id === dishId)?.name ?? '';
    setReply({ kind: 'loading', scope });
    try {
      const result = await analyze({ dishId, goal }, controller.signal);
      if (!controller.signal.aborted) setReply({ kind: 'result', scope, result, dishName });
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OwnerAnalysisAccessError) {
          setReply(null);
          onAccessFailure(error.status === 401 ? 'signed_out' : 'denied');
        } else setReply({ kind: 'error', scope });
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
        <p className="owner-muted">
          Choose a dish for analysis from a separate authorized server-read snapshot. Its evidence
          period may differ from the report displayed here.
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
        {shown?.kind === 'result' && (
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
            <p className="owner-muted">Synthetic analysis from a separate server-read snapshot.</p>
            <p className="owner-muted">{OWNER_ANALYSIS_LIMITATION}</p>
            <p className="owner-muted">No menu changes or customer messages are sent.</p>
          </div>
        )}
      </div>
      <form className="owner-ai__composer owner-ai__composer--pickers" onSubmit={ask}>
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
            value={goal}
            onChange={(event) => setGoal(event.target.value as OwnerAnalysisRequest['goal'])}
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
            disabled={busy || dishes.length === 0}
            aria-label="Review report"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      </form>
    </aside>
  );
}
