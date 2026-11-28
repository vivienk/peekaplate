// Report data page: the owner dish report (owner_report.v1) with its display states. Values are
// shown exactly as the API returns them; nothing is recalculated here. S3-RES-03 connects it to the
// report API (#107). Without the API settings (static previews) it shows a saved copy of a report
// from Uneeza's synthetic P0 v2 data, labelled as such.
import {
  isOwnerProductionCalendarVersion,
  OWNER_PRODUCTION_TODAY_VERSION,
  OWNER_REPORT_TIME_ZONE,
  type OwnerDishReport,
  OwnerDishReportSchema,
} from '@peekaplate/contracts/owner-report';
import { type ReactNode, useEffect, useState } from 'react';
import { type LiveMenuRow, LivePerf } from './pages';
import { fetchOwnerReport, type ReportState } from './report-api';
import { Note } from './ui';
import { UNEEZA_REPORT } from './uneeza-report';

type Status =
  | 'NORMAL'
  | 'VALID_ZERO'
  | 'NOT_MEASURABLE'
  | 'SUPPRESSED'
  | 'MISSING'
  | 'STALE'
  | 'EVIDENCE_CHECK_FAILED';
type Cell = { value: number | null; status: Status };
type Kind = 'count' | 'seconds' | 'rate';

// Proposed wording, shared with Uneeza on S5-DATA-12; Adam and Rania to confirm.
const STATUS_TEXT: Record<Exclude<Status, 'NORMAL' | 'VALID_ZERO'>, string> = {
  NOT_MEASURABLE: 'Not measurable',
  SUPPRESSED: 'Not enough visits yet',
  MISSING: 'No data',
  STALE: 'Out of date',
  EVIDENCE_CHECK_FAILED: 'Couldn’t verify',
};

export function formatOwnerReportValue(value: number, kind: Kind): string {
  if (kind === 'rate') return `${Math.round(value * 1000) / 10}%`;
  if (kind === 'seconds') return `${value} s`;
  return value.toLocaleString('en-US');
}

function show(cell: Cell, kind: Kind) {
  if (cell.status !== 'NORMAL' && cell.status !== 'VALID_ZERO') {
    return <span className="muted">{STATUS_TEXT[cell.status]}</span>;
  }
  return formatOwnerReportValue(cell.value ?? 0, kind);
}

const COLUMNS: [keyof OwnerDishReport['dishes'][number]['metrics'], string, Kind][] = [
  ['active_sessions', 'Visits', 'count'],
  ['open_rate', 'Open rate', 'rate'],
  ['avg_interaction_time_seconds', 'Avg time', 'seconds'],
  ['timing_coverage', 'Timing coverage', 'rate'],
  ['save_rate', 'Save rate', 'rate'],
  ['engagement_rate', 'Engagement', 'rate'],
];

// null means the reader abstains on freshness, so it must not read as "up to date".
function freshnessLabel(isStale: boolean | null) {
  if (isStale === null) return 'freshness not known';
  return isStale ? 'out of date' : 'up to date';
}

export const formatOwnerReportTime = (iso: string, timeZone = 'UTC') =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });

// The saved copy, checked against the same schema as a live response.
const SAVED_REPORT = OwnerDishReportSchema.parse(UNEEZA_REPORT);

// Standalone demos have no identity. The real workspace passes its actor-bound SDK getter.
export async function getOwnerAccessToken(): Promise<string | null> {
  return null;
}

export type ReportSource =
  | { mode: 'saved' }
  | {
      mode: 'live';
      apiBase: string;
      venueId: string;
      getAccessToken: () => Promise<string | null>;
    };

// Live when both API settings are present; static previews have neither.
export function reportSourceFromEnv(
  env: {
    VITE_PUBLIC_API_URL?: string;
    VITE_OWNER_REPORT_VENUE_ID?: string;
  },
  getAccessToken = getOwnerAccessToken,
): ReportSource {
  const apiBase = env.VITE_PUBLIC_API_URL;
  const venueId = env.VITE_OWNER_REPORT_VENUE_ID;
  if (!apiBase || !venueId) return { mode: 'saved' };
  return { mode: 'live', apiBase, venueId, getAccessToken };
}

// Loads the report for one restaurant. Changing restaurant clears the old report at once, and an
// answer for a previous restaurant or attempt is dropped, so one restaurant's numbers never show
// under another.
export function useOwnerReport(source: ReportSource | null): {
  state: ReportState;
  refreshing: boolean;
  retry: () => void;
  reload: () => void;
} {
  const live = source?.mode === 'live' ? source : null;
  const apiBase = live?.apiBase;
  const venueId = live?.venueId;
  const getAccessToken = live?.getAccessToken;
  const [load, setLoad] = useState(() => ({
    request: { apiBase, venueId, getAccessToken },
    state: { kind: 'loading' } as ReportState,
    refreshing: false,
    daily: false,
  }));
  const { request, state, refreshing, daily } = load;
  if (
    request.apiBase !== apiBase ||
    request.venueId !== venueId ||
    request.getAccessToken !== getAccessToken
  ) {
    // Reset during render so the previous source's values cannot reach the next commit.
    setLoad({
      request: { apiBase, venueId, getAccessToken },
      state: { kind: 'loading' },
      refreshing: false,
      daily: false,
    });
  }
  useEffect(() => {
    const { apiBase, venueId, getAccessToken } = request;
    if (!apiBase || !venueId || !getAccessToken) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      let next: ReportState;
      try {
        const accessToken = await getAccessToken();
        if (signal.aborted) return;
        next = await fetchOwnerReport({ apiBase, venueId, accessToken, signal });
      } catch {
        next = { kind: 'error' };
      }
      if (signal.aborted) return;
      // Remember the validated report mode during a transient failure, while clearing its data.
      setLoad((current) =>
        current.request === request
          ? {
              request,
              state: next,
              refreshing: false,
              daily:
                next.kind === 'ready'
                  ? isOwnerProductionCalendarVersion(
                      next.report.report_metadata.calculation_version,
                    )
                  : current.daily && (next.kind === 'error' || next.kind === 'unavailable'),
            }
          : current,
      );
    })();
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    if (!daily || !apiBase || !venueId || !getAccessToken) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setLoad((current) => {
        if (
          current.refreshing ||
          current.request.venueId !== venueId ||
          current.request.apiBase !== apiBase ||
          current.request.getAccessToken !== getAccessToken ||
          !current.daily
        )
          return current;
        return { ...current, request: { ...current.request }, refreshing: true };
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [daily, apiBase, venueId, getAccessToken]);
  function refresh(discard: boolean) {
    setLoad((current) => {
      if (
        current.request !== request ||
        current.state.kind === 'loading' ||
        (current.refreshing && !discard)
      )
        return current;
      return {
        ...current,
        request: current.refreshing ? request : { ...request },
        ...(discard && { state: { kind: 'loading' } }),
        refreshing: true,
      };
    });
  }
  return {
    state: source?.mode === 'saved' ? { kind: 'ready', report: SAVED_REPORT } : state,
    refreshing,
    retry: () => refresh(false),
    reload: () => refresh(true),
  };
}

// Proposed wording for the page states; Adam, Shirley and Rania to confirm.
const STATE_TEXT: Record<Exclude<ReportState['kind'], 'ready' | 'loading'>, string> = {
  signed_out: 'Sign in to see your restaurant’s reports.',
  denied: 'You don’t have access to this restaurant’s reports.',
  unavailable: 'Reports aren’t available for this restaurant yet.',
  invalid: 'We couldn’t verify this report, so it isn’t shown.',
  error: 'We couldn’t load the report. Please try again.',
};

export function ReportView({
  state,
  saved = false,
  onRetry,
  refreshing = false,
  refreshControl,
  presentation = 'data',
  savedMenu = [],
}: {
  state: ReportState;
  savedMenu?: readonly Pick<LiveMenuRow, 'id' | 'name'>[];
  saved?: boolean;
  onRetry?: () => void;
  refreshing?: boolean;
  refreshControl?: ReactNode;
  presentation?: 'data' | 'performance';
}) {
  if (state.kind === 'ready')
    return (
      <ReportTable
        report={state.report}
        saved={saved}
        presentation={presentation}
        refreshControl={refreshControl}
        savedMenu={savedMenu}
      />
    );
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">
          {presentation === 'performance' ? 'Dish performance' : 'Report data'}
        </span>
        <h1>
          {presentation === 'performance'
            ? 'What diners did with each dish'
            : 'Dish report from the report API'}
        </h1>
        {refreshControl}
      </div>
      {state.kind === 'loading' ? (
        <div className="card" role="status">
          Loading report…
        </div>
      ) : (
        <div className="card" role={state.kind === 'error' ? 'alert' : 'status'}>
          <p>{STATE_TEXT[state.kind]}</p>
          {state.kind === 'error' && onRetry && (
            <button type="button" className="btn primary" onClick={onRetry} disabled={refreshing}>
              {refreshing ? 'Retrying…' : 'Try again'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ReportData({
  source = reportSourceFromEnv({
    VITE_PUBLIC_API_URL: import.meta.env.VITE_PUBLIC_API_URL,
    VITE_OWNER_REPORT_VENUE_ID: import.meta.env.VITE_OWNER_REPORT_VENUE_ID,
  }),
  onAccessFailure,
  onReport,
  presentation = 'data',
}: {
  source?: ReportSource;
  onAccessFailure?: (kind: 'signed_out' | 'denied') => void;
  /** The report on screen, or null while none is (loading, failed or denied). */
  onReport?: (report: OwnerDishReport | null, reference?: string) => void;
  presentation?: 'data' | 'performance';
}) {
  const { state, retry, refreshing } = useOwnerReport(source);
  useEffect(() => {
    if (state.kind === 'signed_out' || state.kind === 'denied') onAccessFailure?.(state.kind);
  }, [state.kind, onAccessFailure]);
  const report = state.kind === 'ready' ? state.report : null;
  const reference = state.kind === 'ready' ? state.reference : undefined;
  useEffect(() => {
    onReport?.(report, reference);
  }, [report, reference, onReport]);
  useEffect(() => () => onReport?.(null), [onReport]);
  return (
    <ReportView
      state={state}
      saved={source.mode === 'saved'}
      onRetry={retry}
      refreshing={refreshing}
      presentation={presentation}
    />
  );
}

function ReportTable({
  report: r,
  saved,
  presentation,
  refreshControl,
  savedMenu,
}: {
  report: OwnerDishReport;
  savedMenu: readonly Pick<LiveMenuRow, 'id' | 'name'>[];
  saved: boolean;
  presentation: 'data' | 'performance';
  refreshControl?: ReactNode;
}) {
  const m = r.report_metadata;
  const reportDay = isOwnerProductionCalendarVersion(m.calculation_version);
  const zone = reportDay ? OWNER_REPORT_TIME_ZONE : 'UTC';
  if (presentation === 'performance')
    return (
      <LivePerf
        report={r}
        savedMenu={savedMenu}
        headerAction={refreshControl}
        period={`${formatOwnerReportTime(m.date_window.start_time, zone)} – ${formatOwnerReportTime(m.date_window.end_time, zone)} (end exclusive)`}
        summary={`${m.coverage.measurable_dishes_count} measurable · report ${m.report_status.toLowerCase()} · ${freshnessLabel(m.freshness.is_stale)}`}
        notice={
          saved ? (
            <Note kind="warn">Saved copy of a report: synthetic test data. Not real diners.</Note>
          ) : r.source === 'synthetic' ? (
            <Note kind="warn">Synthetic test data from the report API. Not real diners.</Note>
          ) : m.calculation_version === OWNER_PRODUCTION_TODAY_VERSION ? (
            <Note>Today’s verified dish activity updates through the cutoff shown above.</Note>
          ) : reportDay ? (
            <Note>
              Dish Performance shows the previous completed San Francisco day. Today’s restaurant
              totals are on Overview.
            </Note>
          ) : m.calculation_version === 'production.batch.v1' ? (
            <Note>
              Each completed five-minute batch needs at least ten eligible visits per dish. Overview
              shows restaurant totals.
            </Note>
          ) : (
            <Note>Today uses matched PostHog events. Earlier UTC days use Supabase.</Note>
          )
        }
        columns={COLUMNS}
        display={(cell, kind) =>
          cell.status === 'NORMAL' || cell.status === 'VALID_ZERO'
            ? show(cell, kind)
            : STATUS_TEXT[cell.status]
        }
      />
    );
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">
          Report data · {formatOwnerReportTime(m.date_window.start_time, zone)} –{' '}
          {formatOwnerReportTime(m.date_window.end_time, zone)}
        </span>
        <h1>Dish report from the report API</h1>
        {refreshControl}
      </div>
      {saved ? (
        <Note kind="warn">
          Saved copy of a report: synthetic test data (Uneeza’s P0 v2 set, 300 fictional visits),
          calculated by the owner report API in PR #107. Not real diners.
        </Note>
      ) : (
        r.source === 'synthetic' && (
          <Note kind="warn">Synthetic test data from the report API. Not real diners.</Note>
        )
      )}
      <div className="card">
        <div className="card-h">
          <div>
            <h2>All dishes</h2>
            <span className="sub">
              {m.coverage.measurable_dishes_count} of {m.coverage.total_dishes_monitored} dishes
              measurable · report {m.report_status.toLowerCase()} ·{' '}
              {freshnessLabel(m.freshness.is_stale)} · {r.schema_version} · {m.calculation_version}
            </span>
          </div>
        </div>
        <div className="scrollx">
          <table className="tbl">
            <thead>
              <tr>
                <th>Dish</th>
                {COLUMNS.map(([k, label]) => (
                  <th key={k} className="r">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.dishes.map((d) => (
                <tr key={d.dish_id}>
                  <td>
                    <b>{d.name}</b>
                    {d.evidence_state !== 'NORMAL' && (
                      <div className="lab unk">{STATUS_TEXT[d.evidence_state as 'SUPPRESSED']}</div>
                    )}
                  </td>
                  {COLUMNS.map(([k, , kind]) => (
                    <td key={k} className="r num">
                      {show(d.metrics[k] as Cell, kind)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Note>
        Rates are shares of visits. “Not measurable” means no visit qualified (for example, a dish
        that was seen but never opened), which is different from 0%.
      </Note>
    </div>
  );
}
