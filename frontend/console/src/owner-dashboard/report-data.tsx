// Report data page: the owner dish report (owner_report.v1) with its display states. Values are
// shown exactly as the API returns them; nothing is recalculated here. S3-RES-03 connects it to the
// report API (#107). Without the API settings (static previews) it shows a saved copy of a report
// from Uneeza's synthetic P0 v2 data, labelled as such.
import { type OwnerDishReport, OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { useEffect, useState } from 'react';
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

function show(cell: Cell, kind: Kind) {
  if (cell.status !== 'NORMAL' && cell.status !== 'VALID_ZERO') {
    return <span className="muted">{STATUS_TEXT[cell.status]}</span>;
  }
  const v = cell.value ?? 0;
  if (kind === 'rate') return `${Math.round(v * 1000) / 10}%`;
  if (kind === 'seconds') return `${v} s`;
  return v.toLocaleString('en-US');
}

const COLUMNS: [keyof OwnerDishReport['dishes'][number]['metrics'], string, Kind][] = [
  ['active_sessions', 'Visits', 'count'],
  ['open_rate', 'Open rate', 'rate'],
  ['avg_interaction_time_seconds', 'Avg time', 'seconds'],
  ['timing_coverage', 'Timing coverage', 'rate'],
  ['save_rate', 'Save rate', 'rate'],
  ['engagement_rate', 'Engagement', 'rate'],
];

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });

// The saved copy, checked against the same schema as a live response.
const SAVED_REPORT = OwnerDishReportSchema.parse(UNEEZA_REPORT);

// Owner sign-in is S4-FE-04 (Ehab). Until it exists there is no access token, so a live page shows
// the signed-out state rather than any data.
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
export function reportSourceFromEnv(env: {
  VITE_PUBLIC_API_URL?: string;
  VITE_OWNER_REPORT_VENUE_ID?: string;
}): ReportSource {
  const apiBase = env.VITE_PUBLIC_API_URL;
  const venueId = env.VITE_OWNER_REPORT_VENUE_ID;
  if (!apiBase || !venueId) return { mode: 'saved' };
  return { mode: 'live', apiBase, venueId, getAccessToken: getOwnerAccessToken };
}

// Loads the report for one restaurant. Changing restaurant clears the old report at once, and an
// answer for a previous restaurant or attempt is dropped, so one restaurant's numbers never show
// under another.
function useOwnerReport(source: ReportSource): { state: ReportState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReportState>(
    source.mode === 'saved' ? { kind: 'ready', report: SAVED_REPORT } : { kind: 'loading' },
  );
  const live = source.mode === 'live' ? source : null;
  const apiBase = live?.apiBase;
  const venueId = live?.venueId;
  const getAccessToken = live?.getAccessToken;
  useEffect(() => {
    if (!apiBase || !venueId || !getAccessToken) return;
    // attempt is read so Retry runs this again.
    void attempt;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      let next: ReportState;
      try {
        next = await fetchOwnerReport({
          apiBase,
          venueId,
          accessToken: await getAccessToken(),
          signal: controller.signal,
        });
      } catch {
        next = { kind: 'error' };
      }
      if (!controller.signal.aborted) setState(next);
    })();
    return () => controller.abort();
  }, [apiBase, venueId, getAccessToken, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
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
}: {
  state: ReportState;
  saved?: boolean;
  onRetry?: () => void;
}) {
  if (state.kind === 'ready') return <ReportTable report={state.report} saved={saved} />;
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Report data</span>
        <h1>Dish report from the report API</h1>
      </div>
      {state.kind === 'loading' ? (
        <div className="card" role="status">
          Loading report…
        </div>
      ) : (
        <div className="card" role={state.kind === 'error' ? 'alert' : 'status'}>
          <p>{STATE_TEXT[state.kind]}</p>
          {state.kind === 'error' && onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              Try again
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
}: {
  source?: ReportSource;
}) {
  const { state, retry } = useOwnerReport(source);
  return <ReportView state={state} saved={source.mode === 'saved'} onRetry={retry} />;
}

function ReportTable({ report: r, saved }: { report: OwnerDishReport; saved: boolean }) {
  const m = r.report_metadata;
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">
          Report data · {fmt(m.date_window.start_time)} – {fmt(m.date_window.end_time)}
        </span>
        <h1>Dish report from the report API</h1>
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
              {m.freshness.is_stale ? 'out of date' : 'up to date'} · {r.schema_version} ·{' '}
              {m.calculation_version}
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
