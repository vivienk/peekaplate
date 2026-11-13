// Demo page: shows an owner_report.v1 payload (from #107's calculator on Uneeza's synthetic P0 v2
// data) with the proposed display states. Values are shown exactly as the API returns them;
// nothing is recalculated here. S3-RES-03 replaces the fixture with the live API call.
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

const COLUMNS: [keyof (typeof UNEEZA_REPORT.dishes)[number]['metrics'], string, Kind][] = [
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

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });

export function ReportData() {
  const r = UNEEZA_REPORT;
  const m = r.report_metadata;
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">
          Report data · {fmt(m.date_window.start_time)} – {fmt(m.date_window.end_time)}
        </span>
        <h1>Dish report from the report API</h1>
      </div>
      <Note kind="warn">
        Synthetic test data (Uneeza’s P0 v2 set, 300 fictional visits), calculated by the owner
        report API in PR #107. Not real diners.
      </Note>
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
