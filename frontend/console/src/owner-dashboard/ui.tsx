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
import { Button, type ButtonProps } from '../ui';
import action from './assets/icons/action.svg';
import back from './assets/icons/back.svg';
import chart from './assets/icons/chart.svg';
import chat from './assets/icons/chat.svg';
import check from './assets/icons/check.svg';
import edit from './assets/icons/edit.svg';
import home from './assets/icons/home.svg';
import info from './assets/icons/info.svg';
import menu from './assets/icons/menu.svg';
import plus from './assets/icons/plus.svg';
import report from './assets/icons/report.svg';
import search from './assets/icons/search.svg';
import send from './assets/icons/send.svg';
import spark from './assets/icons/spark.svg';
import store from './assets/icons/store.svg';
import warn from './assets/icons/warn.svg';
import x from './assets/icons/x.svg';
import { pctChg, THUMBS } from './data';

/* Icons exported from Rania's Figma file (l7A9n8tACJic0FIhY49Zjw), unchanged:
   - "PeekaPlate Icons" set 356:5320: home, report, chart, menu, action, store, check, search,
     x (cross-small), back (Arrow-left), warn (warning), edit (Edit);
   - "Rounded Corners_Regular" set 343:8163 (the icon family the Buttons component uses):
     info (fi-rr-info), plus (fi-rr-plus), chat (fi-rr-comment);
   - "AI panel" component (owner S12, 2346:6265): spark, send. */
const ICONS = {
  action,
  back,
  chart,
  chat,
  check,
  edit,
  home,
  info,
  menu,
  plus,
  report,
  search,
  send,
  spark,
  store,
  warn,
  x,
};
export type IconName = keyof typeof ICONS;

/** Draws the Figma SVG as a mask, so the icon keeps Figma's exact shape and takes the
 *  surrounding text colour (nav states, buttons, notes) instead of a fixed fill. */
export function Icon({ n, s = 20 }: { n: IconName; s?: number }) {
  const style = { width: s, height: s, '--ic': `url("${ICONS[n]}")` } as CSSProperties;
  return <span className="ic" aria-hidden="true" style={style} />;
}

/** Reusable icon container for feature/step cards: a fixed box with no background fill. */
export function IconTile({ n, s = 20 }: { n: IconName; s?: number }) {
  return (
    <span className="icontile">
      <Icon n={n} s={s} />
    </span>
  );
}

/* Owner buttons follow Rania's Figma components, built on the shared @peekaplate/ui Button:
   - kind "primary" / "outlined" = "Owner dashboard_Button" 1563:8484 (Type=Primary/Outlined);
     size "md" = Size=Medium (40px, 16px label), "lg" = Size=Large (48px, 18px label);
   - kind "text" = "Text link" 1449:11145 (Tone=Accent), for low-emphasis actions such as
     Back, Dismiss and Undo. An optional leading icon is the component's "Show Icon" slot. */
export type BtnKind = 'primary' | 'outlined' | 'text';
const VARIANT = { primary: 'action', outlined: 'outline', text: 'text' } as const;

export function Btn({
  kind = 'outlined',
  size = 'lg',
  icon,
  className,
  children,
  ...rest
}: Omit<ButtonProps, 'variant'> & { kind?: BtnKind; size?: 'md' | 'lg'; icon?: IconName }) {
  const classes = ['ob', `ob--${kind}`, `ob--${size}`, className].filter(Boolean).join(' ');
  return (
    <Button variant={VARIANT[kind]} className={classes} {...rest}>
      {icon && <Icon n={icon} s={kind === 'text' ? 16 : 20} />}
      {children}
    </Button>
  );
}

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
