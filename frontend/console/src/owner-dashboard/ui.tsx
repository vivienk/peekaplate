// Shared pieces of the Owner Dashboard demo: icons, buttons, labels, KPIs and hand-built SVG
// charts (one scale per chart).
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import { pctChg, THUMBS } from './data';

export { Btn, type BtnKind, Icon, type IconName, IconTile, Note } from './controls';

import { Btn, Icon, type IconName } from './controls';

const LAB_TEXT: Record<string, string> = {
  obs: 'Observed',
  ver: 'Verified order',
  unk: 'Unknown',
  rsn: 'Possible reason',
};
// Today's date, formatted like the S6-FE-14 owner shell (#139), for example "Nov 13, 2026".
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** YYYY-MM-DD in the owner's local time zone (toISOString would give the UTC day). */
const localDate = (date: Date) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((n) => String(n).padStart(2, '0'))
    .join('-');

export function TodayChip({ className, today = new Date() }: { className?: string; today?: Date }) {
  return (
    <time className={className} dateTime={localDate(today)}>
      {DATE_FORMAT.format(today)}
    </time>
  );
}

export function Lab({ k, children }: { k: string; children?: ReactNode }) {
  return <span className={`lab ${k}`}>{children || LAB_TEXT[k] || ''}</span>;
}

export function Thumb({ id, lg }: { id: string; lg?: boolean }) {
  return (
    <span className={`thumb${lg ? ' lg' : ''}`}>
      <img src={THUMBS[id]} alt="" draggable={false} />
    </span>
  );
}

export function Delta({ a, b }: { a: number; b: number }) {
  const c = pctChg(a, b);
  return (
    <span className={`delta ${c > 0 ? 'up' : ''}`}>
      {c > 0 ? '▲' : c < 0 ? '▼' : '■'} {Math.abs(c)}%
    </span>
  );
}

export function Kpi({
  label,
  value,
  unit,
  tag,
  foot,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tag?: ReactNode;
  foot: ReactNode;
}) {
  return (
    <div className="kpi">
      <span className="eyebrow">{label}</span>
      <div className="v num">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="d">{foot}</div>
      {/* Pinned to the bottom so the status label lines up across cards with different text. */}
      {tag && <div className="kpi-tag">{tag}</div>}
    </div>
  );
}

/* ---------- charts ---------- */
function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export type Series = {
  name: string;
  color: string;
  values: (number | null)[];
  dash?: string;
  label?: boolean;
  faint?: boolean;
};

export function LineChart({
  labels,
  series,
  h = 230,
  unit = '',
  desc,
}: {
  labels: string[];
  series: Series[];
  h?: number;
  unit?: string;
  desc?: string;
}) {
  const W = 640;
  const L = 38;
  const R = 18;
  const Tp = 14;
  const B = 26;
  const [hi, setHi] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const peak = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((value): value is number => value !== null)),
  );
  const max = niceMax(peak > 0 ? peak * 1.05 : 1);
  const min = 0;
  const n = labels.length;
  const x = (i: number) => L + (W - L - R) * (n === 1 ? 0.5 : i / (n - 1));
  const y = (v: number) => Tp + (h - Tp - B) * (1 - (v - min) / (max - min));
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const at = (s: Series, i: number) => s.values[i] ?? null;
  const move = (e: MouseEvent<SVGSVGElement>) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let b = 0;
    let bd = 1e9;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bd) {
        bd = d;
        b = i;
      }
    }
    setHi(b);
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setHi((v) => Math.min(n - 1, (v ?? -1) + 1));
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setHi((v) => Math.max(0, (v ?? n) - 1));
    }
  };
  return (
    <div className="chartbox">
      <svg
        ref={ref}
        className="chart"
        viewBox={`0 0 ${W} ${h}`}
        role="img"
        aria-label={
          desc ? `${desc}. Use Left and Right arrow keys to inspect each point.` : 'Line chart'
        }
        tabIndex={0}
        onMouseMove={move}
        onMouseLeave={() => setHi(null)}
        onBlur={() => setHi(null)}
        onKeyDown={key}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text
            key={l}
            x={x(i)}
            y={h - 6}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
          >
            {l}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.name}>
            <path
              className="ln"
              d={s.values
                .map((v, i) =>
                  v === null ? '' : `${i && s.values[i - 1] !== null ? 'L' : 'M'}${x(i)} ${y(v)}`,
                )
                .join(' ')}
              stroke={s.color}
              strokeDasharray={s.dash || undefined}
              opacity={s.faint ? 0.75 : 1}
            />
            {s.values.map(
              (value, i) =>
                value !== null &&
                (i === n - 1 || (at(s, i - 1) === null && at(s, i + 1) === null)) && (
                  <circle
                    key={labels[i]}
                    cx={x(i)}
                    cy={y(value)}
                    r="4.5"
                    fill={s.color}
                    stroke="var(--pp-color-white)"
                    strokeWidth="2"
                  />
                ),
            )}
            {s.label !== false && at(s, n - 1) !== null && (
              <text
                x={x(n - 1)}
                y={y(at(s, n - 1)!) - 10}
                textAnchor="end"
                style={{ fill: 'var(--ink)', fontWeight: 600 }}
              >
                {at(s, n - 1)}
                {unit}
              </text>
            )}
          </g>
        ))}
        {hi !== null && (
          <g>
            <line x1={x(hi)} x2={x(hi)} y1={Tp} y2={h - B} stroke="var(--line2)" strokeWidth="1" />
            {series.map(
              (s) =>
                at(s, hi) !== null && (
                  <circle
                    key={s.name}
                    cx={x(hi)}
                    cy={y(at(s, hi)!)}
                    r="5"
                    fill={s.color}
                    stroke="var(--pp-color-white)"
                    strokeWidth="2"
                  />
                ),
            )}
          </g>
        )}
      </svg>
      {hi !== null && (
        <div
          className="tip"
          role="status"
          aria-live="polite"
          style={{ left: `${(x(hi) / W) * 100}%`, top: '28px' }}
        >
          <b>{labels[hi]}</b>
          {series.map((s) => (
            <div key={s.name}>
              {s.name}: {at(s, hi) ?? 'Unavailable'}
              {at(s, hi) !== null && unit}
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Spark({
  values,
  color = 'var(--c1)',
  w = 84,
  h = 28,
}: {
  values: number[];
  color?: string;
  w?: number;
  h?: number;
}) {
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  const x = (i: number) => 3 + ((w - 6) * i) / (values.length - 1);
  const y = (v: number) => h - 4 - (h - 8) * ((v - mn) / (mx - mn || 1));
  const last = values[values.length - 1] ?? 0;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Trend, 4 weeks: ${values.join(', ')}`}
    >
      <path
        d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={x(values.length - 1)} cy={y(last)} r="3.2" fill={color} />
    </svg>
  );
}

export type BarRow = {
  id: string;
  label: string;
  sub?: string;
  vals: number[];
  text?: ReactNode;
  ariaValue?: (v: number, i: number) => string;
  none?: string;
  onClick?: () => void;
};
export type Segment = { name: string; color: string };

export function HBars({
  rows,
  segs,
  max,
  legend = true,
}: {
  rows: BarRow[];
  segs: Segment[];
  max?: number;
  legend?: boolean;
}) {
  const total = (r: BarRow) => r.vals.reduce((a, b) => a + b, 0);
  const mx = max || Math.max(...rows.map(total));
  return (
    <div>
      <div className="hb">
        {rows.map((r) => {
          const inner = (
            <>
              <span className="nm">
                {r.label}
                {r.sub && <small>{r.sub}</small>}
              </span>
              <span
                className="hb-track"
                role="img"
                aria-label={
                  r.none
                    ? `${r.label}: ${r.none}`
                    : `${r.label}: ${r.vals
                        .map((v, i) => {
                          const formatted = r.ariaValue
                            ? r.ariaValue(v, i)
                            : typeof r.text === 'string' && r.vals.length === 1
                              ? r.text
                              : String(v);
                          return `${segs[i]?.name} ${formatted}`;
                        })
                        .join(', ')}`
                }
              >
                {!r.none &&
                  r.vals.map((v, i) => (
                    <span
                      key={i}
                      className="hb-seg"
                      style={{ width: `${(100 * v) / mx}%`, background: segs[i]?.color }}
                      title={`${r.label}: ${segs[i]?.name} ${
                        r.ariaValue
                          ? r.ariaValue(v, i)
                          : typeof r.text === 'string' && r.vals.length === 1
                            ? r.text
                            : String(v)
                      }`}
                    />
                  ))}
              </span>
              <span className="hb-val num">{r.none ? r.none : (r.text ?? total(r))}</span>
            </>
          );
          return r.onClick ? (
            <button
              type="button"
              key={r.id}
              className={`hb-row hb-btn${r.none ? ' nodata' : ''}`}
              onClick={r.onClick}
              aria-label={`Open ${r.label}`}
            >
              {inner}
            </button>
          ) : (
            <div key={r.id} className={`hb-row${r.none ? ' nodata' : ''}`}>
              {inner}
            </div>
          );
        })}
      </div>
      {legend && segs.length > 0 && (
        <div className="legend">
          {segs.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
          {rows.some((r) => r.none) && (
            <span>
              <i
                style={{
                  background:
                    'repeating-linear-gradient(135deg,transparent 0 3px,var(--line2) 3px 5px)',
                  border: '1px solid var(--line2)',
                }}
              />
              No record (Unknown)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scrollx">
      <table className="tbl">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i ? 'r' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j ? 'r num' : ''}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartCard({
  title,
  sub,
  tag,
  head,
  rows,
  children,
  right,
}: {
  title: string;
  sub?: string;
  tag?: ReactNode;
  head?: string[];
  rows?: ReactNode[][];
  children: ReactNode;
  right?: ReactNode;
}) {
  const [tv, setTv] = useState(false);
  return (
    <section className="card">
      <div className="card-h">
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        <div className="row">
          {tag}
          {right}
          {head && (
            <Btn kind="text" type="button" aria-pressed={tv} onClick={() => setTv((v) => !v)}>
              {tv ? 'Show chart' : 'View as table'}
            </Btn>
          )}
        </div>
      </div>
      {tv && head ? <DataTable head={head} rows={rows ?? []} /> : children}
    </section>
  );
}

export type EngagementPeriodPoint = {
  label: string;
  engagedVisits: number | null;
  eligibleVisits: number | null;
  status?: 'NORMAL' | 'VALID_ZERO' | 'SUPPRESSED' | 'NOT_MEASURABLE' | 'MISSING';
};

export function EngagementPeriodChart({
  baseline,
  current,
  privacyFloor = 10,
}: {
  baseline: EngagementPeriodPoint;
  current: EngagementPeriodPoint;
  privacyFloor?: number;
}) {
  const evaluate = (point: EngagementPeriodPoint) => {
    if (point.status === 'SUPPRESSED')
      return { visible: false as const, text: 'Not enough visits yet', ratio: 0 };
    if (point.status === 'NOT_MEASURABLE')
      return { visible: false as const, text: 'Not measurable', ratio: 0 };
    if (
      point.status === 'MISSING' ||
      point.engagedVisits === null ||
      point.eligibleVisits === null
    ) {
      return { visible: false as const, text: 'No data', ratio: 0 };
    }
    if (point.eligibleVisits === 0)
      return { visible: false as const, text: 'Not measurable', ratio: 0 };
    if (point.eligibleVisits < privacyFloor)
      return { visible: false as const, text: 'Not enough visits yet', ratio: 0 };
    const ratio = point.engagedVisits / point.eligibleVisits;
    const pct = Math.round(ratio * 1000) / 10;
    return {
      visible: true as const,
      text: `${pct}%`,
      ratio,
      engagedVisits: point.engagedVisits,
      eligibleVisits: point.eligibleVisits,
    };
  };

  const prev = evaluate(baseline);
  const curr = evaluate(current);

  let takeaway = 'Engagement comparison across reporting periods.';
  if (prev.visible && curr.visible) {
    if (curr.engagedVisits > prev.engagedVisits && curr.ratio < prev.ratio) {
      takeaway = `Engaged visits increased (${prev.engagedVisits} → ${curr.engagedVisits}), while engagement rate fell from ${prev.text} to ${curr.text}.`;
    } else if (curr.engagedVisits < prev.engagedVisits && curr.ratio > prev.ratio) {
      takeaway = `Engaged visits decreased (${prev.engagedVisits} → ${curr.engagedVisits}), while engagement rate rose from ${prev.text} to ${curr.text}.`;
    } else if (curr.ratio > prev.ratio) {
      takeaway = `Engaged visits changed (${prev.engagedVisits} → ${curr.engagedVisits}) and engagement rate rose from ${prev.text} to ${curr.text}.`;
    } else if (curr.ratio < prev.ratio) {
      takeaway = `Engaged visits changed (${prev.engagedVisits} → ${curr.engagedVisits}) and engagement rate fell from ${prev.text} to ${curr.text}.`;
    } else {
      takeaway = `Engaged visits changed (${prev.engagedVisits} → ${curr.engagedVisits}) while engagement rate remained at ${curr.text}.`;
    }
  } else {
    takeaway = `Period comparison incomplete: ${baseline.label} (${prev.text}), ${current.label} (${curr.text}).`;
  }

  const rows: BarRow[] = [
    {
      id: 'baseline',
      label: baseline.label,
      ...(prev.visible
        ? {
            sub: `${prev.engagedVisits} of ${prev.eligibleVisits} eligible visits`,
            vals: [prev.ratio],
            text: prev.text,
            ariaValue: () => prev.text,
          }
        : { vals: [], none: prev.text }),
    },
    {
      id: 'current',
      label: current.label,
      ...(curr.visible
        ? {
            sub: `${curr.engagedVisits} of ${curr.eligibleVisits} eligible visits`,
            vals: [curr.ratio],
            text: curr.text,
            ariaValue: () => curr.text,
          }
        : { vals: [], none: curr.text }),
    },
  ];

  return (
    <ChartCard
      title="Did engagement change over the period?"
      sub={takeaway}
      head={['Period', 'Engaged visits', 'Eligible visits', 'Engagement rate']}
      rows={[
        [baseline.label, baseline.engagedVisits ?? '—', baseline.eligibleVisits ?? '—', prev.text],
        [current.label, current.engagedVisits ?? '—', current.eligibleVisits ?? '—', curr.text],
      ]}
    >
      <p className="muted" role="status" style={{ marginBottom: '12px' }}>
        {takeaway}
      </p>
      <HBars
        legend={false}
        max={1}
        segs={[{ name: 'Engagement rate', color: 'var(--pp-color-orange-600)' }]}
        rows={rows}
      />
    </ChartCard>
  );
}
