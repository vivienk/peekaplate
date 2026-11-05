// Shared pieces of the Owner Dashboard demo: icons, labels, KPIs and hand-built SVG charts
// (one scale per chart).
import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from 'react';
import { pctChg, THUMBS } from './data';

const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  report: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  chart: 'M4 20V9M10 20V4M16 20v-8M22 20H2',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  menu: 'M5 6h14M5 12h14M5 18h14',
  action: 'M5 12l4 4 10-10M4 20h16',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  send: 'M4 12l16-8-6 16-3-7z',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 12l4 4 10-10',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.2-4.2',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  store:
    'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 2.7 3S9.3 10.7 9.3 9c0 1.7 1.3 3 2.7 3s2.7-1.3 2.7-3c0 1.7 1.3 3 2.7 3S20 10.7 20 9M10 20v-5h4v5',
  spark:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
};
export type IconName = keyof typeof ICONS;

export function Icon({ n, s = 20 }: { n: IconName; s?: number }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[n]} />
    </svg>
  );
}

export function BackChevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

const LAB_TEXT: Record<string, string> = {
  obs: 'Observed',
  ver: 'Verified order',
  unk: 'Unknown',
  rsn: 'Possible reason',
};
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

export function Note({
  kind,
  icon = 'info',
  children,
}: {
  kind?: string;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div
      className={`note ${kind || ''}`}
      role={kind === 'warn' || kind === 'coral' ? 'status' : undefined}
    >
      <Icon n={icon} s={18} />
      <div>{children}</div>
    </div>
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
      {tag && <div>{tag}</div>}
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
  values: number[];
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
  const max = niceMax(Math.max(...series.flatMap((s) => s.values)) * 1.05);
  const min = 0;
  const n = labels.length;
  const x = (i: number) => L + (W - L - R) * (n === 1 ? 0.5 : i / (n - 1));
  const y = (v: number) => Tp + (h - Tp - B) * (1 - (v - min) / (max - min));
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const at = (s: Series, i: number) => s.values[i] ?? 0;
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
        aria-label={desc || 'Line chart'}
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
              d={s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ')}
              stroke={s.color}
              strokeDasharray={s.dash || undefined}
              opacity={s.faint ? 0.75 : 1}
            />
            <circle
              cx={x(n - 1)}
              cy={y(at(s, n - 1))}
              r="4.5"
              fill={s.color}
              stroke="var(--pp-color-white)"
              strokeWidth="2"
            />
            {s.label !== false && (
              <text
                x={x(n - 1)}
                y={y(at(s, n - 1)) - 10}
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
            {series.map((s) => (
              <circle
                key={s.name}
                cx={x(hi)}
                cy={y(at(s, hi))}
                r="5"
                fill={s.color}
                stroke="var(--pp-color-white)"
                strokeWidth="2"
              />
            ))}
          </g>
        )}
      </svg>
      {hi !== null && (
        <div className="tip" style={{ left: `${(x(hi) / W) * 100}%`, top: '28px' }}>
          <b>{labels[hi]}</b>
          {series.map((s) => (
            <div key={s.name}>
              {s.name}: {at(s, hi)}
              {unit}
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
                    : `${r.label}: ${r.vals.map((v, i) => `${segs[i]?.name} ${v}`).join(', ')}`
                }
              >
                {!r.none &&
                  r.vals.map((v, i) => (
                    <span
                      key={i}
                      className="hb-seg"
                      style={{ width: `${(100 * v) / mx}%`, background: segs[i]?.color }}
                      title={`${r.label}: ${segs[i]?.name} ${v}`}
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
            <button
              type="button"
              className="btn ghost sm"
              aria-pressed={tv}
              onClick={() => setTv((v) => !v)}
            >
              {tv ? 'Show chart' : 'View as table'}
            </button>
          )}
        </div>
      </div>
      {tv && head ? <DataTable head={head} rows={rows ?? []} /> : children}
    </section>
  );
}
