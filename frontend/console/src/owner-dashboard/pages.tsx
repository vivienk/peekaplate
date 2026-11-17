import type { OwnerDishReport } from '@peekaplate/contracts/owner-report';
// Owner Dashboard screens: welcome, overview, report, dish performance, dish detail, actions.
import { type ReactNode, useState } from 'react';
import type { Chat } from './chat';
import {
  type ActionState,
  byId,
  bySort,
  DAILY_NOW,
  DAILY_PREV,
  DAYS,
  DISH,
  type Dish,
  EVT,
  INSIGHTS,
  money,
  PAIRS,
  PREV,
  pc,
  REST,
  type Scenario,
  SESSIONS,
  type SortKey,
  T,
  WEEKS,
  WK_ORDERS,
  WK_PREVIEWS,
  WK_TIME,
} from './data';
import {
  Btn,
  ChartCard,
  Delta,
  HBars,
  Icon,
  IconTile,
  Kpi,
  Lab,
  LineChart,
  Note,
  Spark,
  Thumb,
} from './ui';

export type Page =
  | 'welcome'
  | 'overview'
  | 'report'
  | 'perf'
  | 'data'
  | 'menu'
  | 'actions'
  | 'dish';
export type Acts = Record<string, ActionState>;
export type SetAct = (id: string, v: ActionState) => void;

/** Explicit live inputs never fall back to the prototype's restaurant or evidence. */
export interface LiveDashboardInput {
  restaurantName: string;
  period?: string | undefined;
  reportContent?: ReactNode;
  summary?: OwnerDishReport['summary'];
  summaryFreshness?: boolean | null | undefined;
}

type OverviewSummary = NonNullable<OwnerDishReport['summary']>;
type OverviewMetric = keyof OverviewSummary['current'];
function overviewMetric(summary: OverviewSummary | undefined, key: OverviewMetric) {
  const display = (
    cell: OverviewSummary['current'][OverviewMetric] | undefined,
    withUnit = true,
  ) => {
    if ((cell?.status === 'NORMAL' || cell?.status === 'VALID_ZERO') && cell.value !== null)
      return `${key === 'avg_interaction_time_seconds' ? cell.value : cell.value.toLocaleString('en-US')}${withUnit && key === 'avg_interaction_time_seconds' ? ' s' : ''}`;
    switch (cell?.status) {
      case 'SUPPRESSED':
        return 'Not enough visits yet';
      case 'NOT_MEASURABLE':
        return 'Not measurable';
      case 'STALE':
        return 'Out of date';
      case 'EVIDENCE_CHECK_FAILED':
        return 'Couldn’t verify';
      default:
        return 'Unavailable';
    }
  };
  const current = summary?.current[key];
  const observed = current?.status === 'NORMAL' || current?.status === 'VALID_ZERO';
  return {
    value: display(current, false),
    ...(observed && key === 'avg_interaction_time_seconds' ? { unit: 's' } : {}),
    foot: `Previous period: ${display(summary?.baseline[key])}`,
    tag: <Lab k={observed ? (key === 'verified_orders' ? 'ver' : 'obs') : 'unk'} />,
  };
}
const overviewWindow = (period: { start_time: string; end_time: string }) =>
  `${period.start_time.replace('T', ' ').replace(/\.000Z$|Z$/, ' UTC')} – ${period.end_time.replace('T', ' ').replace(/\.000Z$|Z$/, ' UTC')}`;
export interface LiveMenuRow {
  id: string;
  name: string;
  category: string;
  priceLabel: string;
  imageUrl?: string | null;
}
export interface LiveSavedAction {
  id: string;
  title: string;
  text: string;
  status: ActionState['status'] | 'active' | 'archived';
}

export function Welcome({ go }: { go: (p: Page) => void }) {
  return (
    <div className="welcome">
      <div className="pagehead">
        <span className="eyebrow">Welcome</span>
        <h1>{REST.name} is set up on PeekaPlate</h1>
        <p className="lede">
          The PeekaPlate team added your menu during onboarding. Here is what is ready, and where
          your weekly reports will appear.
        </p>
      </div>
      <div className="steps">
        <div className="stepc">
          <IconTile n="menu" />
          <h3>Your {DISH.length} dishes are listed</h3>
          <p className="muted">Each one is live on the diner menu, with a photo and description.</p>
        </div>
        <div className="stepc">
          <IconTile n="report" />
          <h3>Reports appear in AI Insight Report</h3>
          <p className="muted">
            When a report period closes, a short summary appears with its evidence.
          </p>
        </div>
        <div className="stepc">
          <IconTile n="chat" />
          <h3>Ask AI any time</h3>
          <p className="muted">
            Ask about dishes, comparisons and orders. Answers show their evidence.
          </p>
        </div>
      </div>
      {/* Design review (Rania, Nov 9): plain section without a card border or fill, and a compact
          vertical list instead of large stacked dish cards. */}
      <section className="menu-plain" aria-labelledby="ym-h">
        <div className="card-h">
          <div>
            <h3 id="ym-h">Your menu</h3>
            <div className="sub">Numbers appear once diners start using the menu.</div>
          </div>
        </div>
        <ul className="dlist menu-plain-list">
          {DISH.map((d) => (
            <li className="drow menu-plain-row" key={d.id}>
              <Thumb id={d.id} />
              <span className="dn">
                {d.name}
                <small>{d.cat}</small>
              </span>
              <span className="num">{money(d.price)}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="row">
        <Btn kind="primary" size="lg" type="button" onClick={() => go('menu')}>
          Review my menu
        </Btn>
      </div>
    </div>
  );
}

function ReportVersionBadge({ scn }: { scn: Scenario }) {
  return (
    <span className={`lab ${scn === 'A' ? 'good' : 'warn'}`}>
      {scn === 'A'
        ? 'Version A · normal report'
        : scn === 'B'
          ? 'Version B · not enough data'
          : 'Version C · evidence check failed'}
    </span>
  );
}

export function Overview({
  go,
  sim,
  acts,
  openDish,
  openInsight,
  live,
}: {
  go: (p: Page) => void;
  sim: { scn: Scenario };
  acts: Acts;
  openDish: (id: string) => void;
  openInsight: (id: string) => void;
  live?: LiveDashboardInput & { menu: readonly LiveMenuRow[] };
}) {
  const empty = !!live || sim.scn === 'empty';
  const daily = live?.summary?.daily_opens;
  const dailyLabels = daily?.current.map(
    (bucket) => `${bucket.start_time.slice(11, 16)}–${bucket.end_time.slice(11, 16)} UTC`,
  );
  const dailyValue = (bucket: NonNullable<OverviewSummary['daily_opens']>['current'][number]) =>
    bucket.opens.value ??
    (bucket.opens.status === 'SUPPRESSED' ? 'Not enough visits yet' : 'Unavailable');
  const sorted = bySort('open');
  const planned = INSIGHTS.filter((i) => acts[i.id]?.status === 'planned').length;
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Overview · {live ? live.restaurantName : REST.period}</span>
        <h1>{live ? 'How your menu did this period' : 'How your menu did this week'}</h1>
      </div>
      {empty && (
        <Note icon="info">
          {live
            ? live.summary
              ? `Current period: ${overviewWindow(live.summary.periods.current)}. Previous period: ${overviewWindow(live.summary.periods.baseline)}. ${live.summaryFreshness === null || live.summaryFreshness === undefined ? 'Freshness not known.' : live.summaryFreshness ? 'Report is out of date.' : 'Report is up to date.'}`
              : 'Summary unavailable. Your saved dishes are listed below; no measurements are inferred.'
            : 'No diner data yet. Your dishes are listed below with no numbers. Data appears once diners use the menu.'}
        </Note>
      )}
      {(live || !empty) && (
        <div className="kpis">
          <Kpi
            label="Menu sessions"
            {...(live
              ? overviewMetric(live.summary, 'menu_sessions')
              : {
                  value: SESSIONS.now,
                  foot: (
                    <>
                      <Delta a={SESSIONS.now} b={SESSIONS.prev} /> vs last week
                    </>
                  ),
                  tag: <Lab k="obs" />,
                })}
          />
          <Kpi
            label="Dish opens"
            {...(live
              ? overviewMetric(live.summary, 'dish_opens')
              : {
                  value: T.open,
                  foot: (
                    <>
                      <Delta a={T.open} b={PREV.open} /> vs last week
                    </>
                  ),
                  tag: <Lab k="obs" />,
                })}
          />
          <Kpi
            label="Avg time interacting"
            {...(live
              ? overviewMetric(live.summary, 'avg_interaction_time_seconds')
              : {
                  value: T.time,
                  unit: 's',
                  foot: `${T.time - PREV.time > 0 ? '+' : ''}${T.time - PREV.time} s vs last week`,
                  tag: <Lab k="obs" />,
                })}
          />
          <Kpi
            label="2.5D previews shown"
            {...(live
              ? overviewMetric(live.summary, 'portion_previews_shown')
              : {
                  value: T.p25,
                  foot: (
                    <>
                      <Delta a={T.p25} b={PREV.p25} /> vs last week
                    </>
                  ),
                  tag: <Lab k="obs" />,
                })}
          />
          <Kpi
            label="Verified orders on record"
            {...(live
              ? overviewMetric(live.summary, 'verified_orders')
              : {
                  value: T.ord,
                  foot: `${T.withRec} of ${DISH.length} dishes have a record`,
                  tag: <Lab k="ver" />,
                })}
          />
        </div>
      )}
      <div className="grid g-main">
        <div className="stack">
          {(live || !empty) && (
            <ChartCard
              title="Dish opens by day"
              tag={
                <Lab
                  k={
                    !live ||
                    (daily &&
                      [...daily.current, ...daily.baseline].some(
                        (bucket) => bucket.opens.value !== null,
                      ))
                      ? 'obs'
                      : 'unk'
                  }
                />
              }
              {...(live && {
                sub: 'UTC days clipped to each reporting period. Unavailable measurements are gaps, not zero.',
              })}
              head={
                live
                  ? ['UTC bucket', 'Current period', 'Previous period']
                  : ['Day', 'This week', 'Last week']
              }
              rows={
                live
                  ? (daily?.current.map((bucket, i) => [
                      dailyLabels![i],
                      dailyValue(bucket),
                      daily.baseline[i] ? dailyValue(daily.baseline[i]!) : 'Unavailable',
                    ]) ?? [])
                  : DAYS.map((d, i) => [d, DAILY_NOW[i], DAILY_PREV[i]])
              }
            >
              {live && !daily ? (
                <div className="empty">Daily openings unavailable.</div>
              ) : (
                <LineChart
                  labels={live ? (dailyLabels ?? []) : DAYS}
                  unit=""
                  desc={
                    live
                      ? 'Dish opens by clipped UTC day, current period compared with previous period'
                      : 'Dish opens by day, this week compared with last week'
                  }
                  series={
                    live && daily
                      ? [
                          {
                            name: 'Current period',
                            color: 'var(--c1)',
                            values: daily.current.map((bucket) => bucket.opens.value),
                          },
                          {
                            name: 'Previous period',
                            color: 'var(--cg)',
                            values: daily.baseline.map((bucket) => bucket.opens.value),
                            dash: '5 4',
                            label: false,
                          },
                        ]
                      : [
                          { name: 'This week', color: 'var(--c1)', values: DAILY_NOW },
                          {
                            name: 'Last week',
                            color: 'var(--cg)',
                            values: DAILY_PREV,
                            dash: '5 4',
                            label: false,
                          },
                        ]
                  }
                />
              )}
            </ChartCard>
          )}
          <section className="card ov-dishes">
            <div className="card-h">
              <div>
                <h3>Your dishes</h3>
              </div>
              <Btn kind="outlined" size="md" type="button" onClick={() => go('perf')}>
                Dish performance
              </Btn>
            </div>
            <div className="dlist">
              {live && live.menu.length === 0 && (
                <div className="empty">No saved dishes available.</div>
              )}
              {live
                ? live.menu.map((d) => (
                    <button
                      type="button"
                      key={d.id}
                      className="drow"
                      onClick={() => openDish(d.id)}
                      aria-label={d.name}
                    >
                      <span className="thumb">
                        {d.imageUrl ? <img src={d.imageUrl} alt="" /> : <Icon n="menu" />}
                      </span>
                      <span className="dn">
                        {d.name}
                        <small>
                          {d.category} · {d.priceLabel}
                        </small>
                      </span>
                      <span className="hidem muted">Open saved dishes</span>
                    </button>
                  ))
                : (empty ? DISH : sorted).map((d) => (
                    <button
                      type="button"
                      key={d.id}
                      className="drow"
                      onClick={() => openDish(d.id)}
                      aria-label={d.name + (empty ? '' : `, ${d.open} opens`)}
                    >
                      <Thumb id={d.id} />
                      <span className="dn">
                        {d.name}
                        <small>
                          {d.cat} · {money(d.price)}
                        </small>
                      </span>
                      <span className="hidem">
                        {empty ? (
                          <span className="muted">No data yet</span>
                        ) : (
                          <Spark values={d.weekly} />
                        )}
                      </span>
                      <span className="num" style={{ textAlign: 'right', fontWeight: 600 }}>
                        {empty ? '' : `${d.open} opens`}
                      </span>
                    </button>
                  ))}
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="card ov-ins">
            <div className="card-h">
              <div>
                <h3>Insights</h3>
              </div>
              {!empty && <ReportVersionBadge scn={sim.scn} />}
            </div>
            {empty ? (
              <div className="empty">
                {live
                  ? 'No validated insights are available here. Open the report to check its availability.'
                  : 'The first report appears after diners use the menu.'}
              </div>
            ) : sim.scn === 'B' ? (
              <p>
                There is not enough data this week for a full report. Counts only, no suggestion.
              </p>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                {INSIGHTS.map((i) => (
                  <div key={i.id} className="prev">
                    <div className="row" style={{ gap: 6 }}>
                      {i.rank === 'Top suggestion' && sim.scn === 'A' && (
                        <span className="lab rsn">Top suggestion</span>
                      )}
                      {acts[i.id] && acts[i.id]?.status !== 'suggested' && (
                        <span className="lab st">{acts[i.id]?.status}</span>
                      )}
                    </div>
                    <b style={{ fontWeight: 700 }}>{i.title}</b>
                    <div className="row" style={{ gap: 8 }}>
                      <Btn
                        kind="outlined"
                        size="md"
                        type="button"
                        onClick={() => openInsight(i.id)}
                      >
                        Read insight
                      </Btn>
                    </div>
                  </div>
                ))}
                {sim.scn === 'C' && (
                  <Note kind="warn" icon="warn">
                    Suggestion held back. The evidence check did not pass, so only the evidence is
                    shown.
                  </Note>
                )}
              </div>
            )}
            {(!empty || live) && (
              <div className="row" style={{ marginTop: 16 }}>
                <Btn kind="primary" size="lg" type="button" onClick={() => go('report')}>
                  Open the AI Insight Report
                </Btn>
              </div>
            )}
          </section>
          <section className="card ov-act">
            <div className="card-h">
              <div>
                <h3>Your actions</h3>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{live ? 'See saved actions' : `${planned} planned`}</span>
              <Btn kind="outlined" size="md" type="button" onClick={() => go('actions')}>
                View actions
              </Btn>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EvidencePanel() {
  return (
    <div className="ins-box" role="region" aria-label="Why am I seeing this?">
      <h4>Why am I seeing this?</h4>
      <p>
        The AI drafted this from recorded diner events, then an evidence check ran before it was
        published.
      </p>
      <ul style={{ marginTop: 8 }}>
        <li>Every claim traces to a recorded diner event.</li>
        <li>Counts add up (opened, opened again, compared).</li>
        <li>No “lost order” wording and no guessed reasons or diets.</li>
        <li>Unknown outcomes are labelled Unknown.</li>
      </ul>
      <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
        {EVT}
      </p>
    </div>
  );
}

const RPT_ROWS: [string, number, number, number, string, number | null][] = [
  ['Harvest Power Bowl', 412, 96, 59, '38s', 58],
  ['Garden Avocado Salad', 356, 71, 78, '44s', 61],
  ['Avocado Toast', 298, 52, 47, '29s', null],
  ['Classic Eggs Benedict', 241, 38, 39, '33s', 37],
  ['Berry Pancake Stack', 187, 22, 18, '21s', null],
];
const RPT_ACT =
  'Start keeping a verified order record for Avocado Toast so its ordered quantity is no longer unknown in the next report.';

function B({ children }: { children: ReactNode }) {
  return <b>{children}</b>;
}

export function Report({
  go,
  acts,
  setAct,
  live,
}: {
  go: (p: Page) => void;
  acts: Acts;
  setAct: SetAct;
  live?: LiveDashboardInput;
}) {
  const [why, setWhy] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const a = acts.rep || { status: 'suggested', text: RPT_ACT };
  const [t, setT] = useState(a.text);
  const set = (p: Partial<ActionState>) => setAct('rep', { ...a, ...p });
  const st =
    a.status === 'suggested'
      ? ['Awaiting review', 'st']
      : a.status === 'approved'
        ? ['Approved', 'good']
        : ['Dismissed', 'st'];
  return (
    <div className="stack">
      <div className="rpt-head">
        <Btn
          kind="text"
          icon="back"
          type="button"
          className="back-link"
          onClick={() => go('overview')}
        >
          Back to Dashboard
        </Btn>
        <div className="rpt-title">
          <div>
            <span
              className="eyebrow"
              style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 500 }}
            >
              {live
                ? `Report · ${live.restaurantName}${live.period ? ` · ${live.period}` : ''}`
                : 'Report · 1–14 Sep 2025'}
            </span>
            <h1>Menu activity report</h1>
          </div>
          <Btn
            kind="outlined"
            size="md"
            icon="info"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
          >
            Why am I seeing this?
          </Btn>
        </div>
        {why &&
          (live ? (
            <div className="ins-box" role="region" aria-label="Why am I seeing this?">
              Only validated report measurements are shown. Missing or suppressed evidence is not a
              measured zero.
            </div>
          ) : (
            <EvidencePanel />
          ))}
      </div>
      <section className="card" aria-labelledby="rs-h">
        <div className="row" style={{ gap: 10 }}>
          <h2 id="rs-h">Summary</h2>
          {!live && (
            <span className="lab good">
              <span className="dot" />
              Evidence checked
            </span>
          )}
        </div>
        {live ? (
          <p className="rpt-sum">
            {live.reportContent
              ? 'Report availability and dish measurements are shown below. No aggregate totals or generated recommendations are inferred.'
              : 'Report unavailable. No validated report has been loaded for this restaurant.'}
          </p>
        ) : (
          <p className="rpt-sum">
            During 1–14 Sep 2025, diners opened dish details <B>1,494 times</B> across{' '}
            <B>5 dishes</B> and started <B>111 comparisons</B>. Harvest Power Bowl received the most
            detail views (<B>412</B>); Garden Avocado Salad had the most comparison participations:{' '}
            <B>78</B>. Sample order records exist for 3 of 5 dishes; Avocado Toast and Berry Pancake
            Stack have none (unknown).
          </p>
        )}
      </section>
      <section className="card" aria-labelledby="rd-h">
        <h2 id="rd-h">Dish numbers</h2>
        {live ? (
          (live.reportContent ?? <div className="empty">Report unavailable</div>)
        ) : (
          <>
            <div className="scrollx">
              <table className="tbl rpt-tbl">
                <thead>
                  <tr>
                    <th>Dish</th>
                    <th className="r">Detail views</th>
                    <th className="r">Repeat opens</th>
                    <th className="r">Comparison participations</th>
                    <th className="r">Avg. active time</th>
                    <th className="r">Ordered items</th>
                  </tr>
                </thead>
                <tbody>
                  {RPT_ROWS.map((r) => (
                    <tr key={r[0]}>
                      <td>{r[0]}</td>
                      <td className="r num">{r[1]}</td>
                      <td className="r num">{r[2]}</td>
                      <td className="r num">{r[3]}</td>
                      <td className="r num">{r[4]}</td>
                      <td className="r">
                        {r[5] === null ? <Lab k="unk" /> : <span className="num">{r[5]}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rpt-note">
              <b>Unknown outcomes:</b> Avocado Toast and Berry Pancake Stack have no sample order
              record, so the outcome is unknown, not zero and not rejected.
            </p>
          </>
        )}
      </section>
      <section
        className={`card rpt-act${a.status === 'dismissed' ? ' dismissed' : ''}`}
        aria-labelledby="ra-h"
      >
        <div className="row" style={{ gap: 10 }}>
          <h2 id="ra-h">
            <Icon n="spark" s={17} /> Suggested action
          </h2>
          <span className={`lab ${live ? 'st' : st[1]}`}>
            <span className="dot" />
            {live ? 'No suggestion available' : st[0]}
          </span>
        </div>
        {live ? (
          <p className="rpt-rec">No validated suggested action is available here.</p>
        ) : mode === 'edit' ? (
          <div className="field">
            <label htmlFor="rep-ed">Edit the wording</label>
            <textarea id="rep-ed" value={t} onChange={(e) => setT(e.target.value)} />
            <div className="row">
              <Btn
                kind="primary"
                size="md"
                type="button"
                onClick={() => {
                  set({ text: t });
                  setMode('view');
                }}
              >
                Save wording
              </Btn>
              <Btn
                kind="outlined"
                size="md"
                type="button"
                onClick={() => {
                  setT(a.text);
                  setMode('view');
                }}
              >
                Cancel
              </Btn>
            </div>
          </div>
        ) : (
          <>
            <p className="rpt-rec">{a.text}</p>
            <p className="rpt-why">
              <b>Why:</b> Avocado Toast had 298 detail views and 47 comparison participations,
              third-highest on both, but no sample order record. Without one, the report cannot show
              any ordered quantity for it.
            </p>
            {a.status === 'suggested' ? (
              <div className="row">
                <Btn
                  kind="outlined"
                  size="md"
                  icon="edit"
                  type="button"
                  onClick={() => setMode('edit')}
                >
                  Edit wording
                </Btn>
                <Btn
                  kind="primary"
                  size="md"
                  icon="check"
                  type="button"
                  onClick={() => set({ status: 'approved' })}
                >
                  Approve
                </Btn>
                <Btn kind="text" type="button" onClick={() => set({ status: 'dismissed' })}>
                  Dismiss
                </Btn>
              </div>
            ) : (
              <div className="row">
                <span className="muted">
                  {a.status === 'approved' ? 'Approved. Nothing is sent to diners.' : 'Dismissed.'}
                </span>
                <Btn kind="text" type="button" onClick={() => set({ status: 'suggested' })}>
                  Undo
                </Btn>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

const TABS: [string, string][] = [
  ['views', 'Views'],
  ['time', 'Interaction time'],
  ['p25', '2.5D preview'],
  ['cmp', 'Comparisons'],
  ['ord', 'Verified orders'],
  ['trend', 'Trends'],
];

export function Perf({
  sim,
  openDish,
  chat,
  openChat,
}: {
  sim: { scn: Scenario };
  openDish: (id: string) => void;
  chat: Chat;
  openChat: () => void;
}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('views');
  const [sk, setSk] = useState<SortKey>('open');
  const [desc, setDesc] = useState(true);
  if (sim.scn === 'empty')
    return (
      <div className="stack">
        <div className="pagehead">
          <span className="eyebrow">Dish performance</span>
          <h1>Numbers will appear here</h1>
        </div>
        <div className="empty">
          Data appears once diners use the menu. Your dishes are listed in Menu.
        </div>
      </div>
    );
  const s = bySort('open');
  const byTaps = [...DISH].sort((a, b) => b.p25 + b.fb - (a.p25 + a.fb));
  let body: ReactNode = null;
  if (tab === 'views')
    body = (
      <ChartCard
        title="Dish opens"
        sub="How often each dish was opened this week"
        tag={<Lab k="obs" />}
        head={['Dish', 'First opens', 'Opened again', 'Total']}
        rows={s.map((d) => [d.name, d.open - d.again, d.again, d.open])}
      >
        <HBars
          segs={[
            { name: 'First opens', color: 'var(--c1)' },
            { name: 'Opened again', color: 'var(--cg)' },
          ]}
          rows={s.map((d) => ({
            id: d.id,
            label: d.name,
            sub: d.cat,
            vals: [d.open - d.again, d.again],
            text: d.open,
            onClick: () => openDish(d.id),
          }))}
        />
      </ChartCard>
    );
  if (tab === 'time') {
    const t = bySort('time');
    body = (
      <ChartCard
        title="Average time interacting"
        sub="Seconds per dish opening (sample measure, capture method not final)"
        tag={<Lab k="obs" />}
        head={['Dish', 'Seconds']}
        rows={t.map((d) => [d.name, d.time])}
      >
        <HBars
          segs={[{ name: 'Average seconds interacting', color: 'var(--c1)' }]}
          rows={t.map((d) => ({
            id: d.id,
            label: d.name,
            sub: d.has25 ? '2.5D preview available' : 'No preview yet',
            vals: [d.time],
            text: `${d.time} s`,
            onClick: () => openDish(d.id),
          }))}
        />
      </ChartCard>
    );
  }
  if (tab === 'p25')
    body = (
      <div className="stack">
        <ChartCard
          title="2.5D preview engagement"
          sub="Taps on “View in 2.5D”: preview shown vs photo shown because no preview exists"
          tag={<Lab k="obs" />}
          head={['Dish', 'Preview shown', 'Photo shown (no preview)', 'Opens']}
          rows={byTaps.map((d) => [d.name, d.p25, d.fb, d.open])}
        >
          <HBars
            segs={[
              { name: '2.5D preview shown', color: 'var(--c1)' },
              { name: 'Tapped, photo shown (no preview yet)', color: 'var(--c2)' },
            ]}
            rows={byTaps.map((d) => ({
              id: d.id,
              label: d.name,
              sub: `${pc(d.p25 + d.fb, d.open)}% of opens tapped`,
              vals: [d.p25, d.fb],
              text: d.p25 + d.fb,
              onClick: () => openDish(d.id),
            }))}
          />
        </ChartCard>
        <Note icon="info">
          Dishes with a preview: {T.p25} in {T.openWith} opens ({T.tapRateWith}%). Dishes without:{' '}
          {T.fb} taps in {T.openWithout} opens ({T.tapRateWithout}%). This does not show why diners
          tap.
        </Note>
      </div>
    );
  if (tab === 'cmp') {
    const t = bySort('cmp');
    body = (
      <div className="stack">
        <ChartCard
          title="Dishes in comparisons"
          sub={`${T.comparisons} comparisons started this week`}
          tag={<Lab k="obs" />}
          head={['Dish', 'In comparisons']}
          rows={t.map((d) => [d.name, d.cmp])}
        >
          <HBars
            segs={[{ name: 'Times in a comparison', color: 'var(--c1)' }]}
            rows={t.map((d) => ({
              id: d.id,
              label: d.name,
              vals: [d.cmp],
              onClick: () => openDish(d.id),
            }))}
          />
        </ChartCard>
        <ChartCard
          title="Most compared pairs"
          tag={<Lab k="obs" />}
          head={['Pair', 'Comparisons']}
          rows={PAIRS.map((p) => [`${byId(p[0]).name} × ${byId(p[1]).name}`, p[2]])}
        >
          <HBars
            segs={[{ name: 'Comparisons', color: 'var(--c1)' }]}
            rows={PAIRS.map((p, i) => ({
              id: `p${i}`,
              label: `${byId(p[0]).name} × ${byId(p[1]).name}`,
              vals: [p[2]],
            }))}
          />
        </ChartCard>
      </div>
    );
  }
  if (tab === 'ord') {
    const t = [...DISH].sort((a, b) => (b.ord ?? -1) - (a.ord ?? -1));
    body = (
      <div className="stack">
        <ChartCard
          title="Verified orders"
          sub="Only where a restaurant order record exists. Entered by hand, so it may be incomplete."
          tag={<Lab k="ver" />}
          head={['Dish', 'Verified orders']}
          rows={t.map((d) => [d.name, d.ord === null ? 'Unknown (no record)' : d.ord])}
        >
          <HBars
            segs={[{ name: 'Verified orders', color: 'var(--c3)' }]}
            rows={t.map((d) =>
              d.ord === null
                ? { id: d.id, label: d.name, none: 'No record', vals: [] }
                : { id: d.id, label: d.name, vals: [d.ord], onClick: () => openDish(d.id) },
            )}
            max={25}
          />
        </ChartCard>
        <Note icon="info">
          No record means Unknown. It does not mean nobody ordered the dish, and it is never shown
          as zero or as lost.
        </Note>
      </div>
    );
  }
  if (tab === 'trend') {
    const weeklyOpens = WEEKS.map((_, i) => DISH.reduce((a, d) => a + (d.weekly[i] ?? 0), 0));
    body = (
      <div className="grid g2">
        <ChartCard
          title="Dish opens per week"
          tag={<Lab k="obs" />}
          head={['Week of', 'Opens']}
          rows={WEEKS.map((w, i) => [w, weeklyOpens[i]])}
        >
          <LineChart
            h={190}
            labels={WEEKS}
            desc="Dish opens per week over four weeks"
            series={[{ name: 'Dish opens', color: 'var(--c1)', values: weeklyOpens }]}
          />
        </ChartCard>
        <ChartCard
          title="2.5D previews per week"
          tag={<Lab k="obs" />}
          head={['Week of', 'Previews']}
          rows={WEEKS.map((w, i) => [w, WK_PREVIEWS[i]])}
        >
          <LineChart
            h={190}
            labels={WEEKS}
            desc="2.5D previews shown per week"
            series={[{ name: 'Previews shown', color: 'var(--c1)', values: WK_PREVIEWS }]}
          />
        </ChartCard>
        <ChartCard
          title="Average interaction time (s)"
          tag={<Lab k="obs" />}
          head={['Week of', 'Seconds']}
          rows={WEEKS.map((w, i) => [w, WK_TIME[i]])}
        >
          <LineChart
            h={190}
            labels={WEEKS}
            desc="Average interaction time in seconds per week"
            series={[{ name: 'Seconds', color: 'var(--c1)', values: WK_TIME }]}
          />
        </ChartCard>
        <ChartCard
          title="Verified orders on record per week"
          sub="Only dishes with a record"
          tag={<Lab k="ver" />}
          head={['Week of', 'Orders']}
          rows={WEEKS.map((w, i) => [w, WK_ORDERS[i]])}
        >
          <LineChart
            h={190}
            labels={WEEKS}
            desc="Verified orders on record per week"
            series={[{ name: 'Verified orders', color: 'var(--c3)', values: WK_ORDERS }]}
          />
        </ChartCard>
      </div>
    );
  }
  const needle = q.trim().toLowerCase();
  const val = (d: Dish) => (sk === 'name' ? -1 : (d[sk] ?? -1));
  const sorted = [...DISH]
    .filter((d) => !needle || d.name.toLowerCase().includes(needle))
    .sort((a, b) => (desc ? val(b) - val(a) : val(a) - val(b)));
  const selDish = needle && sorted.length === 1 ? sorted[0] : null;
  const th = (k: SortKey, l: string) => (
    <th
      className={k === 'name' ? '' : 'r'}
      aria-sort={sk === k ? (desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => {
          if (sk === k) setDesc(!desc);
          else {
            setSk(k);
            setDesc(true);
          }
        }}
      >
        {l}
        {sk === k ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
  return (
    <PerfFrame
      period={REST.period}
      description="Views, time interacting and orders, labelled by how much we know. A dish that was viewed but not ordered is not assumed to be rejected."
      summary={
        needle
          ? `${sorted.length} of ${DISH.length} dishes`
          : `${DISH.length} dishes · select a dish for details`
      }
      table={
        <>
          {' '}
          <table className="tbl">
            <thead>
              <tr>
                {th('name', 'Dish')}
                {th('open', 'Opens')}
                {th('again', 'Opened again')}
                {th('time', 'Avg time')}
                {th('p25', '2.5D')}
                {th('cmp', 'Compared')}
                {th('ord', 'Verified orders')}
                <th className="r">4 weeks</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={d.id} className="click" onClick={() => openDish(d.id)}>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <Thumb id={d.id} />
                      <Btn
                        kind="text"
                        type="button"
                        style={{ fontWeight: 600, textAlign: 'left' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDish(d.id);
                        }}
                      >
                        {d.name}
                      </Btn>
                    </div>
                  </td>
                  <td className="r num">{d.open}</td>
                  <td className="r num">{d.again}</td>
                  <td className="r num">{d.time} s</td>
                  <td className="r num">
                    {d.has25 ? d.p25 : <span className="muted">{d.fb} photo</span>}
                  </td>
                  <td className="r num">{d.cmp}</td>
                  <td className="r">
                    {d.ord === null ? <Lab k="unk" /> : <span className="num">{d.ord}</span>}
                  </td>
                  <td className="r">
                    <Spark values={d.weekly} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <div className="empty">No dishes match “{q.trim()}”.</div>}
        </>
      }
      q={q}
      setQ={setQ}
      tab={tab}
      setTab={setTab}
      action={
        <Btn
          kind="primary"
          size="md"
          icon="spark"
          disabled={!selDish}
          title={selDish ? '' : 'Search for one dish, or open a dish, to ask about it'}
          onClick={() => {
            if (selDish) {
              chat.ask(`dish:${selDish.id}`, true);
              openChat();
            }
          }}
        >
          Ask AI about this dish
        </Btn>
      }
      body={body}
    />
  );
}

export function DishDetail({
  id,
  go,
  editDish,
  chat,
  openChat,
}: {
  id: string;
  go: (p: Page) => void;
  editDish: (id: string) => void;
  chat: Chat;
  openChat: () => void;
}) {
  const d = byId(id);
  const rel = INSIGHTS.filter((i) => i.dish === id);
  return (
    <div className="stack">
      <div>
        <Btn kind="text" icon="back" type="button" onClick={() => go('perf')}>
          Back to Dish performance
        </Btn>
      </div>
      <div className="row" style={{ gap: 18, alignItems: 'center' }}>
        <Thumb id={d.id} lg />
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <span className="eyebrow">
            {d.cat} · {money(d.price)}
          </span>
          <h1>{d.name}</h1>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <span className={`lab ${d.has25 ? 'good' : 'st'}`}>
              {d.has25 ? '2.5D preview available' : 'No 2.5D preview'}
            </span>
            <span className="lab st">Live on diner menu</span>
          </div>
        </div>
        <div className="row">
          <Btn
            kind="primary"
            size="lg"
            icon="spark"
            onClick={() => {
              chat.ask(`dish:${d.id}`, true);
              openChat();
            }}
          >
            Ask AI about this dish
          </Btn>
          <Btn kind="outlined" size="lg" type="button" onClick={() => editDish(d.id)}>
            Edit dish
          </Btn>
        </div>
      </div>
      <div className="kpis">
        <Kpi
          label="Opens"
          value={d.open}
          foot={`${pc(d.open, T.open)}% of all dish opens`}
          tag={<Lab k="obs" />}
        />
        <Kpi
          label="Opened again"
          value={d.again}
          foot={`${pc(d.again, d.open)}% of its opens`}
          tag={<Lab k="obs" />}
        />
        <Kpi
          label="Avg time interacting"
          value={d.time}
          unit="s"
          foot={`All dishes: ${T.time} s`}
          tag={<Lab k="obs" />}
        />
        <Kpi
          label="In comparisons"
          value={d.cmp}
          foot="Times compared with another dish"
          tag={<Lab k="obs" />}
        />
        {d.ord === null ? (
          <Kpi
            label="Verified orders"
            value="No record"
            foot="Outcome is Unknown, not zero"
            tag={<Lab k="unk" />}
          />
        ) : (
          <Kpi
            label="Verified orders"
            value={d.ord}
            foot="From a hand-entered record"
            tag={<Lab k="ver" />}
          />
        )}
      </div>
      <div className="grid g2">
        <ChartCard
          title="Opens over four weeks"
          tag={<Lab k="obs" />}
          head={['Week of', 'Opens']}
          rows={WEEKS.map((w, i) => [w, d.weekly[i]])}
        >
          <LineChart
            h={200}
            labels={WEEKS}
            desc={`${d.name} opens over four weeks`}
            series={[{ name: 'Opens', color: 'var(--c1)', values: d.weekly }]}
          />
        </ChartCard>
        <ChartCard
          title="How diners used this dish"
          sub="Share of its opens"
          tag={<Lab k="obs" />}
          head={['Behaviour', 'Share of opens']}
          rows={[
            ['Opened again', `${pc(d.again, d.open)}%`],
            ['In a comparison', `${pc(d.cmp, d.open)}%`],
            ['Tapped 2.5D', `${pc(d.p25 + d.fb, d.open)}%`],
          ]}
        >
          <HBars
            legend={false}
            max={100}
            segs={[{ name: 'Share', color: 'var(--c1)' }]}
            rows={[
              {
                id: 'a',
                label: 'Opened again',
                vals: [pc(d.again, d.open)],
                text: `${pc(d.again, d.open)}%`,
              },
              {
                id: 'b',
                label: 'In a comparison',
                vals: [pc(d.cmp, d.open)],
                text: `${pc(d.cmp, d.open)}%`,
              },
              {
                id: 'c',
                label: d.has25 ? 'Tapped 2.5D (preview shown)' : 'Tapped 2.5D (photo shown)',
                vals: [pc(d.p25 + d.fb, d.open)],
                text: `${pc(d.p25 + d.fb, d.open)}%`,
              },
            ]}
          />
        </ChartCard>
      </div>
      {rel.length > 0 && (
        <section className="card">
          <div className="card-h">
            <h3>Related insights</h3>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {rel.map((i) => (
              <div key={i.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{i.title}</span>
                <Btn kind="outlined" size="md" type="button" onClick={() => go('report')}>
                  Open report
                </Btn>
              </div>
            ))}
          </div>
        </section>
      )}
      <Note icon="info">
        Opens show attention, not preference.{' '}
        {d.ord === null
          ? 'With no order record, what happened after viewing is Unknown.'
          : 'Order counts come from a hand-entered record and may be incomplete.'}
      </Note>
    </div>
  );
}

export function Actions({
  acts,
  setAct,
  editDish,
  sim,
  openInsight,
  live,
}: {
  acts: Acts;
  setAct: SetAct;
  editDish: (id: string, from?: string) => void;
  sim: { scn: Scenario };
  openInsight: (id: string) => void;
  live?: LiveDashboardInput & {
    actions?: readonly LiveSavedAction[];
    actionsStatus?: 'loading' | 'unavailable' | 'ready';
  };
}) {
  const list = live
    ? (live.actions ?? []).map((action) => ({
        i: { id: action.id, title: action.title, dish: '' },
        a: { status: action.status, text: action.text } as ActionState,
      }))
    : INSIGHTS.map((i) => ({
        i,
        a: acts[i.id] || ({ status: 'suggested', text: i.action } as ActionState),
      }));
  const lbl: Record<string, string> = {
    approved: 'Approved',
    active: 'Active',
    archived: 'Archived',
    suggested: 'Not reviewed',
    planned: 'Planned',
    done: 'Done · owner-reported',
    dismissed: 'Dismissed',
  };
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Actions{live ? ` · ${live.restaurantName}` : ''}</span>
        <h1>What you decided to do</h1>
        <p className="lede">
          Approving an action means you plan to do it. It is not proof the action was done, and
          nothing is sent to diners.
        </p>
      </div>
      {!live && sim.scn === 'C' && (
        <Note kind="warn" icon="warn">
          This week’s suggestions are on hold because the evidence check did not pass.
        </Note>
      )}
      <div className="stack">
        {live && list.length === 0 && (
          <section className="card">
            <div className="empty">
              {live.actionsStatus === 'loading'
                ? 'Loading saved actions…'
                : live.actionsStatus === 'unavailable'
                  ? 'Saved actions unavailable. No action records could be loaded.'
                  : 'No saved actions are available for this restaurant.'}
            </div>
          </section>
        )}
        {list.map(({ i, a }) => (
          <section key={i.id} className="card">
            <div className="card-h">
              <div>
                <h3>{i.title}</h3>
                <div className="sub">{a.text}</div>
              </div>
              <span
                className={`lab ${a.status === 'planned' || a.status === 'done' ? 'good' : 'st'}`}
              >
                {lbl[a.status]}
              </span>
            </div>
            {!live && (
              <div className="row">
                {a.status === 'suggested' && (
                  <Btn kind="primary" size="md" type="button" onClick={() => openInsight(i.id)}>
                    Review in report
                  </Btn>
                )}
                <Btn kind="outlined" size="md" type="button" onClick={() => openInsight(i.id)}>
                  Open insight
                </Btn>
                {a.status === 'planned' && (
                  <>
                    <Btn
                      kind="primary"
                      size="md"
                      type="button"
                      onClick={() => setAct(i.id, { ...a, status: 'done', date: 'Oct 11, 2026' })}
                    >
                      Log as done
                    </Btn>
                    <Btn
                      kind="outlined"
                      size="md"
                      type="button"
                      onClick={() => editDish(i.dish, i.id)}
                    >
                      Edit this dish
                    </Btn>
                  </>
                )}
                {a.status === 'done' && <span className="muted">Logged {a.date}</span>}
                {(a.status === 'planned' || a.status === 'done' || a.status === 'dismissed') && (
                  <Btn
                    kind="outlined"
                    size="md"
                    type="button"
                    onClick={() => setAct(i.id, { ...a, status: 'suggested' })}
                  >
                    Reset
                  </Btn>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
      <section className="card">
        <div className="card-h">
          <div>
            <h3>Track improvements</h3>
            <div className="sub">
              <span className="lab prop">Proposed · not confirmed in the journey map</span>
            </div>
          </div>
        </div>
        <p>
          Once an action is logged as done, later reports can show dish numbers before and after.
          That is an observation, not proof the action caused the change. Orders with no record stay
          Unknown.
        </p>
      </section>
    </div>
  );
}

function PerfFrame({
  period,
  description,
  summary,
  table,
  notice,
  q,
  setQ,
  tab,
  setTab,
  action,
  body,
}: {
  period: string;
  description: ReactNode;
  summary: ReactNode;
  table: ReactNode;
  notice?: ReactNode;
  q: string;
  setQ: (value: string) => void;
  tab: string;
  setTab: (value: string) => void;
  action?: ReactNode;
  body: ReactNode;
}) {
  return (
    <div className="performance-page stack">
      <div className="pagehead">
        <span className="eyebrow">Dish performance · {period}</span>
        <h1>What diners did with each dish</h1>
        <p className="lede">{description}</p>
      </div>
      {notice}
      <section className="card" aria-labelledby="ad-h">
        <div className="card-h">
          <div>
            <h2 id="ad-h">All dishes</h2>
            <div className="sub" aria-live="polite">
              {summary}
            </div>
          </div>
        </div>
        <div className="scrollx dtable">{table}</div>
      </section>
      <div className="tabs" role="group" aria-label="Metric" style={{ margin: 0 }}>
        {TABS.map(([k, l]) => (
          <button type="button" key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="ctlrow">
        <div className="dsearch">
          <Icon n="search" s={16} />
          <label className="sr" htmlFor="dish-q">
            Search dishes
          </label>
          <input
            id="dish-q"
            type="search"
            placeholder="Search dishes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
            }}
            autoComplete="off"
          />
          {q && (
            <button
              type="button"
              className="dclear"
              aria-label="Clear search"
              onClick={() => {
                setQ('');
                document.getElementById('dish-q')?.focus();
              }}
            >
              <Icon n="x" s={15} />
            </button>
          )}
        </div>
        {action}
      </div>
      {body}
    </div>
  );
}

export function LivePerf({
  report,
  period,
  summary,
  notice,
  columns,
  display,
}: {
  report: OwnerDishReport;
  period: string;
  summary: ReactNode;
  notice: ReactNode;
  columns: [
    keyof OwnerDishReport['dishes'][number]['metrics'],
    string,
    'count' | 'seconds' | 'rate',
  ][];
  display: (
    cell: OwnerDishReport['dishes'][number]['metrics']['open_rate'],
    kind: 'count' | 'seconds' | 'rate',
  ) => ReactNode;
}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('views');
  const dishes = report.dishes.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()));
  const column = columns.find(
    ([key]) => key === (tab === 'views' ? 'open_rate' : 'avg_interaction_time_seconds'),
  );
  const supported = tab === 'views' || tab === 'time';
  const body =
    supported && column ? (
      <ChartCard
        title={tab === 'views' ? 'Open rate' : 'Average time interacting'}
        sub={
          tab === 'views'
            ? 'Share of visits that opened each dish; opening counts are unavailable.'
            : 'Average active seconds from completed timed openings.'
        }
        head={['Dish', column[1]]}
        rows={dishes.map((d) => [d.name, display(d.metrics[column[0]], column[2])])}
      >
        <HBars
          legend={false}
          max={
            tab === 'views' ? 1 : Math.max(1, ...dishes.map((d) => d.metrics[column[0]].value ?? 0))
          }
          segs={[{ name: column[1], color: 'var(--pp-color-orange-600)' }]}
          rows={dishes.map((d) => {
            const cell = d.metrics[column[0]];
            const visible = cell.status === 'NORMAL' || cell.status === 'VALID_ZERO';
            return {
              id: d.dish_id,
              label: d.name,
              vals: visible && cell.value !== null ? [cell.value] : [],
              text: display(cell, column[2]),
              ...(!visible ? { none: display(cell, column[2]) as string } : {}),
            };
          })}
        />
      </ChartCard>
    ) : (
      <section className="card">
        <div className="card-h">
          <h3>{TABS.find(([key]) => key === tab)?.[1]}</h3>
        </div>
        <div className="empty">
          These measurements are not available in this report. No values are inferred.
        </div>
      </section>
    );
  return (
    <PerfFrame
      period={period}
      description="Views and time interacting, labelled by how much we know. Orders and other measurements appear only when supported by the report."
      summary={
        <>
          {dishes.length} of {report.dishes.length} dishes · {summary}
        </>
      }
      notice={notice}
      q={q}
      setQ={setQ}
      tab={tab}
      setTab={setTab}
      body={body}
      table={
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th>Dish</th>
                {columns.map(([key, label]) => (
                  <th key={key} className="r">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dishes.map((d) => (
                <tr key={d.dish_id}>
                  <td>
                    <b>{d.name}</b>
                  </td>
                  {columns.map(([key, , kind]) => (
                    <td key={key} className="r num">
                      {display(d.metrics[key], kind)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {dishes.length === 0 && (
            <div className="empty">
              {report.dishes.length
                ? 'No dishes match your search.'
                : 'Numbers will appear here once measurable report data is available.'}
            </div>
          )}
        </>
      }
    />
  );
}
