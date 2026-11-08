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
  THUMBS,
  WEEKS,
  WK_ORDERS,
  WK_PREVIEWS,
  WK_TIME,
} from './data';
import {
  BackChevron,
  ChartCard,
  Delta,
  HBars,
  Icon,
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
          <Icon n="menu" />
          <h3>Your {DISH.length} dishes are listed</h3>
          <p className="muted">Each one is live on the diner menu, with a photo and description.</p>
        </div>
        <div className="stepc">
          <Icon n="report" />
          <h3>Reports appear in AI Insight Report</h3>
          <p className="muted">
            When a report period closes, a short summary appears with its evidence.
          </p>
        </div>
        <div className="stepc">
          <Icon n="chat" />
          <h3>Ask AI any time</h3>
          <p className="muted">
            Ask about dishes, comparisons and orders. Answers show their evidence.
          </p>
        </div>
      </div>
      <section className="card">
        <div className="card-h">
          <div>
            <h3>Your menu</h3>
            <div className="sub">Numbers appear once diners start using the menu.</div>
          </div>
        </div>
        <div className="dishgrid">
          {DISH.map((d) => (
            <div className="dg" key={d.id}>
              <img src={THUMBS[d.id]} alt="" />
              <b>{d.name}</b>
              <span>
                {d.cat} · {money(d.price)}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className="row">
        <button type="button" className="btn primary" onClick={() => go('menu')}>
          Review my menu
        </button>
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
}: {
  go: (p: Page) => void;
  sim: { scn: Scenario };
  acts: Acts;
  openDish: (id: string) => void;
  openInsight: (id: string) => void;
}) {
  const empty = sim.scn === 'empty';
  const sorted = bySort('open');
  const planned = INSIGHTS.filter((i) => acts[i.id]?.status === 'planned').length;
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Overview · {REST.period}</span>
        <h1>How your menu did this week</h1>
      </div>
      {empty ? (
        <Note icon="info">
          No diner data yet. Your dishes are listed below with no numbers. Data appears once diners
          use the menu.
        </Note>
      ) : (
        <div className="kpis">
          <Kpi
            label="Menu sessions"
            value={SESSIONS.now}
            foot={
              <>
                <Delta a={SESSIONS.now} b={SESSIONS.prev} /> vs last week
              </>
            }
            tag={<Lab k="obs" />}
          />
          <Kpi
            label="Dish opens"
            value={T.open}
            foot={
              <>
                <Delta a={T.open} b={PREV.open} /> vs last week
              </>
            }
            tag={<Lab k="obs" />}
          />
          <Kpi
            label="Avg time interacting"
            value={T.time}
            unit="s"
            foot={`${T.time - PREV.time > 0 ? '+' : ''}${T.time - PREV.time} s vs last week`}
            tag={<Lab k="obs" />}
          />
          <Kpi
            label="2.5D previews shown"
            value={T.p25}
            foot={
              <>
                <Delta a={T.p25} b={PREV.p25} /> vs last week
              </>
            }
            tag={<Lab k="obs" />}
          />
          <Kpi
            label="Verified orders on record"
            value={T.ord}
            foot={`${T.withRec} of ${DISH.length} dishes have a record`}
            tag={<Lab k="ver" />}
          />
        </div>
      )}
      <div className="grid g-main">
        <div className="stack">
          {!empty && (
            <ChartCard
              title="Dish opens by day"
              tag={<Lab k="obs" />}
              head={['Day', 'This week', 'Last week']}
              rows={DAYS.map((d, i) => [d, DAILY_NOW[i], DAILY_PREV[i]])}
            >
              <LineChart
                labels={DAYS}
                unit=""
                desc="Dish opens by day, this week compared with last week"
                series={[
                  { name: 'This week', color: 'var(--c1)', values: DAILY_NOW },
                  {
                    name: 'Last week',
                    color: 'var(--cg)',
                    values: DAILY_PREV,
                    dash: '5 4',
                    label: false,
                  },
                ]}
              />
            </ChartCard>
          )}
          <section className="card ov-dishes">
            <div className="card-h">
              <div>
                <h3>Your dishes</h3>
              </div>
              <button type="button" className="btn sm" onClick={() => go('perf')}>
                Dish performance
              </button>
            </div>
            <div className="dlist">
              {(empty ? DISH : sorted).map((d) => (
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
              <div className="empty">The first report appears after diners use the menu.</div>
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
                      <button type="button" className="btn sm" onClick={() => openInsight(i.id)}>
                        Read insight
                      </button>
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
            {!empty && (
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="btn primary" onClick={() => go('report')}>
                  Open the AI Insight Report
                </button>
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
              <span>{planned} planned</span>
              <button type="button" className="btn sm" onClick={() => go('actions')}>
                View actions
              </button>
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
}: {
  go: (p: Page) => void;
  acts: Acts;
  setAct: SetAct;
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
        <button type="button" className="back-link" onClick={() => go('overview')}>
          <BackChevron />
          Back to Dashboard
        </button>
        <div className="rpt-title">
          <div>
            <span
              className="eyebrow"
              style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 500 }}
            >
              Report · 1–14 Sep 2025
            </span>
            <h1>Menu activity report</h1>
          </div>
          <button
            type="button"
            className="btn sm"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
          >
            <Icon n="info" s={16} />
            Why am I seeing this?
          </button>
        </div>
        {why && <EvidencePanel />}
      </div>
      <section className="card" aria-labelledby="rs-h">
        <div className="row" style={{ gap: 10 }}>
          <h2 id="rs-h">Summary</h2>
          <span className="lab good">
            <span className="dot" />
            Evidence checked
          </span>
        </div>
        <p className="rpt-sum">
          During 1–14 Sep 2025, diners opened dish details <B>1,494 times</B> across <B>5 dishes</B>{' '}
          and started <B>111 comparisons</B>. Harvest Power Bowl received the most detail views (
          <B>412</B>); Garden Avocado Salad had the most comparison participations: <B>78</B>.
          Sample order records exist for 3 of 5 dishes; Avocado Toast and Berry Pancake Stack have
          none (unknown).
        </p>
      </section>
      <section className="card" aria-labelledby="rd-h">
        <h2 id="rd-h">Dish numbers</h2>
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
      </section>
      <section
        className={`card rpt-act${a.status === 'dismissed' ? ' dismissed' : ''}`}
        aria-labelledby="ra-h"
      >
        <div className="row" style={{ gap: 10 }}>
          <h2 id="ra-h">
            <Icon n="spark" s={17} /> Suggested action
          </h2>
          <span className={`lab ${st[1]}`}>
            <span className="dot" />
            {st[0]}
          </span>
        </div>
        {mode === 'edit' ? (
          <div className="field">
            <label htmlFor="rep-ed">Edit the wording</label>
            <textarea id="rep-ed" value={t} onChange={(e) => setT(e.target.value)} />
            <div className="row">
              <button
                type="button"
                className="btn primary sm"
                onClick={() => {
                  set({ text: t });
                  setMode('view');
                }}
              >
                Save wording
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setT(a.text);
                  setMode('view');
                }}
              >
                Cancel
              </button>
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
                <button type="button" className="btn sm" onClick={() => setMode('edit')}>
                  <Icon n="edit" s={15} />
                  Edit wording
                </button>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => set({ status: 'approved' })}
                >
                  <Icon n="check" s={15} />
                  Approve
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => set({ status: 'dismissed' })}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div className="row">
                <span className="muted">
                  {a.status === 'approved' ? 'Approved. Nothing is sent to diners.' : 'Dismissed.'}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => set({ status: 'suggested' })}
                >
                  Undo
                </button>
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
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Dish performance · {REST.period}</span>
        <h1>What diners did with each dish</h1>
        <p className="lede">
          Views, time interacting and orders, labelled by how much we know. A dish that was viewed
          but not ordered is not assumed to be rejected.
        </p>
      </div>
      <section className="card" aria-labelledby="ad-h">
        <div className="card-h">
          <div>
            <h3 id="ad-h">All dishes</h3>
            <div className="sub" aria-live="polite">
              {needle
                ? `${sorted.length} of ${DISH.length} dishes`
                : `${DISH.length} dishes · select a dish for details`}
            </div>
          </div>
        </div>
        <div className="scrollx dtable">
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
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ fontWeight: 600, textAlign: 'left' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDish(d.id);
                        }}
                      >
                        {d.name}
                      </button>
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
        </div>
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
        <button
          type="button"
          className="btn aibtn sm"
          disabled={!selDish}
          title={selDish ? '' : 'Search for one dish, or open a dish, to ask about it'}
          onClick={() => {
            if (selDish) {
              chat.ask(`dish:${selDish.id}`, true);
              openChat();
            }
          }}
        >
          <span className="dot" />
          Ask AI about this dish
        </button>
      </div>
      {body}
    </div>
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
        <button type="button" className="btn ghost sm" onClick={() => go('perf')}>
          <Icon n="back" s={16} />
          Back to Dish performance
        </button>
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
          <button
            type="button"
            className="btn aibtn"
            onClick={() => {
              chat.ask(`dish:${d.id}`, true);
              openChat();
            }}
          >
            <span className="dot" />
            Ask AI about this dish
          </button>
          <button type="button" className="btn" onClick={() => editDish(d.id)}>
            Edit dish
          </button>
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
                <button type="button" className="btn sm" onClick={() => go('report')}>
                  Open report
                </button>
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
}: {
  acts: Acts;
  setAct: SetAct;
  editDish: (id: string, from?: string) => void;
  sim: { scn: Scenario };
  openInsight: (id: string) => void;
}) {
  const list = INSIGHTS.map((i) => ({
    i,
    a: acts[i.id] || ({ status: 'suggested', text: i.action } as ActionState),
  }));
  const lbl: Record<string, string> = {
    suggested: 'Not reviewed',
    planned: 'Planned',
    done: 'Done · owner-reported',
    dismissed: 'Dismissed',
  };
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Actions</span>
        <h1>What you decided to do</h1>
        <p className="lede">
          Approving an action means you plan to do it. It is not proof the action was done, and
          nothing is sent to diners.
        </p>
      </div>
      {sim.scn === 'C' && (
        <Note kind="warn" icon="warn">
          This week’s suggestions are on hold because the evidence check did not pass.
        </Note>
      )}
      <div className="stack">
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
            <div className="row">
              {a.status === 'suggested' && (
                <button type="button" className="btn sm primary" onClick={() => openInsight(i.id)}>
                  Review in report
                </button>
              )}
              <button type="button" className="btn sm" onClick={() => openInsight(i.id)}>
                Open insight
              </button>
              {a.status === 'planned' && (
                <>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => setAct(i.id, { ...a, status: 'done', date: 'Oct 11, 2026' })}
                  >
                    Log as done
                  </button>
                  <button type="button" className="btn sm" onClick={() => editDish(i.dish, i.id)}>
                    Edit this dish
                  </button>
                </>
              )}
              {a.status === 'done' && <span className="muted">Logged {a.date}</span>}
              {(a.status === 'planned' || a.status === 'done' || a.status === 'dismissed') && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setAct(i.id, { ...a, status: 'suggested' })}
                >
                  Reset
                </button>
              )}
            </div>
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
