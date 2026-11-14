// One fictional dataset for the Owner Dashboard V2 demo; every screen reads from here. Nothing
// is real restaurant or diner data, and nothing is fetched or sent.
import avotoast from './assets/avotoast.webp';
import benedict from './assets/benedict.webp';
import berrypancakes from './assets/berrypancakes.webp';
import frenchtoast from './assets/frenchtoast.webp';
import greek from './assets/greek.webp';
import harvest from './assets/harvest.webp';
import poke from './assets/poke.webp';

export const THUMBS: Record<string, string> = {
  avotoast,
  greek,
  benedict,
  harvest,
  poke,
  berrypancakes,
  frenchtoast,
};

export const REST = { name: 'Simple & Quick', period: 'Oct 5–11, 2026', prev: 'Sep 28–Oct 4' };
export const SESSIONS = { now: 412, prev: 389 };
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAILY_NOW = [82, 79, 88, 91, 119, 141, 88];
export const DAILY_PREV = [80, 75, 87, 90, 109, 126, 87];
export const WEEKS = ['Sep 14', 'Sep 21', 'Sep 28', 'Oct 5'];
export const WK_PREVIEWS = [96, 111, 124, 143];
export const WK_TIME = [57, 59, 61, 63];
export const WK_ORDERS = [47, 50, 52, 58];

// open = dish opens, again = opened again, cmp = in a comparison, p25 = 2.5D previews shown,
// fb = tapped 2.5D and saw the photo, time = avg seconds interacting per open,
// ord = verified orders on record (null = no record), weekly = opens over 4 weeks.
export type Dish = {
  id: string;
  name: string;
  cat: string;
  price: number;
  open: number;
  again: number;
  cmp: number;
  p25: number;
  fb: number;
  time: number;
  ord: number | null;
  weekly: number[];
  has25: boolean;
  desc: string;
  ing: string[];
};

export const DISH: Dish[] = [
  {
    id: 'avotoast',
    name: 'Avocado Toast',
    cat: 'Breakfast',
    price: 14,
    open: 148,
    again: 41,
    cmp: 33,
    p25: 62,
    fb: 0,
    time: 74,
    ord: 21,
    weekly: [112, 121, 133, 148],
    has25: true,
    desc: 'Toasted seeded bread with smashed avocado, a poached egg, cherry tomatoes, chili flakes and microgreens.',
    ing: ['Seeded bread', 'Avocado', 'Poached egg', 'Cherry tomato', 'Chili flakes', 'Microgreens'],
  },
  {
    id: 'benedict',
    name: 'Classic Eggs Benedict',
    cat: 'Breakfast',
    price: 16,
    open: 96,
    again: 19,
    cmp: 24,
    p25: 0,
    fb: 22,
    time: 52,
    ord: 14,
    weekly: [90, 93, 97, 96],
    has25: false,
    desc: 'Poached eggs and ham on toasted English muffins, finished with warm hollandaise and chives.',
    ing: ['English muffin', 'Ham', 'Poached egg', 'Hollandaise', 'Chives'],
  },
  {
    id: 'berrypancakes',
    name: 'Berry Pancake Stack',
    cat: 'Breakfast',
    price: 15,
    open: 71,
    again: 12,
    cmp: 18,
    p25: 0,
    fb: 14,
    time: 47,
    ord: null,
    weekly: [60, 66, 70, 71],
    has25: false,
    desc: 'Fluffy buttermilk pancakes topped with fresh strawberries, blueberries, maple syrup, and whipped cream.',
    ing: ['Buttermilk pancakes', 'Strawberries', 'Blueberries', 'Maple syrup', 'Whipped cream'],
  },
  {
    id: 'frenchtoast',
    name: 'Brioche French Toast',
    cat: 'Breakfast',
    price: 16,
    open: 64,
    again: 9,
    cmp: 15,
    p25: 0,
    fb: 11,
    time: 44,
    ord: null,
    weekly: [58, 61, 66, 64],
    has25: false,
    desc: 'Golden brioche French toast topped with seasonal berries, powdered sugar, and maple syrup.',
    ing: ['Brioche', 'Seasonal berries', 'Powdered sugar', 'Maple syrup'],
  },
  {
    id: 'harvest',
    name: 'Harvest Power Bowl',
    cat: 'Brunch Bowls',
    price: 18,
    open: 119,
    again: 38,
    cmp: 29,
    p25: 57,
    fb: 0,
    time: 81,
    ord: 17,
    weekly: [88, 97, 108, 119],
    has25: true,
    desc: 'Greens, wild rice, grilled chicken, roasted sweet potato and brussels sprouts, with a creamy lemon dressing on the side.',
    ing: [
      'Mixed greens',
      'Wild rice',
      'Grilled chicken',
      'Sweet potato',
      'Kale',
      'Brussels sprouts',
      'Feta',
      'Apple',
      'Toasted nuts',
      'Lemon dressing',
    ],
  },
  {
    id: 'poke',
    name: 'Salmon Poke Bowl',
    cat: 'Brunch Bowls',
    price: 19,
    open: 132,
    again: 29,
    cmp: 40,
    p25: 0,
    fb: 31,
    time: 58,
    ord: 6,
    weekly: [118, 124, 128, 132],
    has25: false,
    desc: 'Cubed salmon over sushi rice with avocado, edamame, cucumber and pickled ginger.',
    ing: [
      'Sushi rice',
      'Salmon',
      'Avocado',
      'Edamame',
      'Cucumber',
      'Carrot',
      'Pickled ginger',
      'Nori',
      'Sesame',
    ],
  },
  {
    id: 'greek',
    name: 'Garden Avocado Salad',
    cat: 'Salads',
    price: 15,
    open: 58,
    again: 8,
    cmp: 11,
    p25: 24,
    fb: 0,
    time: 69,
    ord: null,
    weekly: [44, 50, 52, 58],
    has25: true,
    desc: 'Mixed baby greens with avocado, cherry tomatoes, cucumber, radish and crumbled blue cheese, finished with pumpkin seeds and cracked pepper.',
    ing: [
      'Mixed greens',
      'Avocado',
      'Cherry tomato',
      'Cucumber',
      'Radish',
      'Blue cheese',
      'Pumpkin seeds',
      'Red onion',
    ],
  },
];

export const PAIRS: [string, string, number][] = [
  ['poke', 'harvest', 22],
  ['avotoast', 'benedict', 19],
  ['berrypancakes', 'frenchtoast', 14],
];

export const byId = (id: string): Dish => {
  const dish = DISH.find((d) => d.id === id);
  if (!dish) throw new Error(`Unknown dish ${id}`);
  return dish;
};
const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

const WITH = DISH.filter((d) => d.has25);
const WITHOUT = DISH.filter((d) => !d.has25);
const totalOpen = sum(DISH, (d) => d.open);
const totalCmp = sum(DISH, (d) => d.cmp);
const totalP25 = sum(DISH, (d) => d.p25);
const totalFb = sum(DISH, (d) => d.fb);
const openWith = sum(WITH, (d) => d.open);
const openWithout = sum(WITHOUT, (d) => d.open);

export const T = {
  open: totalOpen,
  again: sum(DISH, (d) => d.again),
  cmp: totalCmp,
  p25: totalP25,
  fb: totalFb,
  ord: sum(DISH, (d) => d.ord || 0),
  withRec: DISH.filter((d) => d.ord !== null).length,
  time: Math.round(sum(DISH, (d) => d.time * d.open) / totalOpen),
  comparisons: Math.round(totalCmp / 2),
  openWith,
  openWithout,
  tapRateWith: Math.round((100 * totalP25) / openWith),
  tapRateWithout: Math.round((100 * totalFb) / openWithout),
  timeWith: Math.round(sum(WITH, (d) => d.time * d.open) / openWith),
  timeWithout: Math.round(sum(WITHOUT, (d) => d.time * d.open) / openWithout),
};

export const PREV = {
  open: sum(DISH, (d) => d.weekly[2] ?? 0),
  ord: 52,
  p25: 124,
  time: 61,
  sessions: SESSIONS.prev,
};
export const pctChg = (a: number, b: number) => Math.round((1000 * (a - b)) / b) / 10;
export type SortKey = 'open' | 'again' | 'time' | 'p25' | 'cmp' | 'ord' | 'name';
const sortValue = (d: Dish, k: SortKey): number => (k === 'name' ? 0 : (d[k] ?? -1));
export const bySort = (k: SortKey, desc = true) =>
  [...DISH].sort((a, b) =>
    desc ? sortValue(b, k) - sortValue(a, k) : sortValue(a, k) - sortValue(b, k),
  );
export const money = (n: number | string) => `$${n}`;
export const pc = (a: number, b: number) => Math.round((100 * a) / b);

/* ---------- insights (report content) ---------- */
export type InsightItem = {
  id: string;
  rank: string;
  dish: string;
  title: string;
  happened: string;
  evidence: string[];
  uncertain: string[];
  matters: string;
  reasons: string[];
  action: string;
};

const p = byId('poke');
const g = byId('greek');
export const INSIGHTS: InsightItem[] = [
  {
    id: 'i1',
    rank: 'Top suggestion',
    dish: 'poke',
    title: 'Diners tapped “View in 2.5D” on dishes that don’t have one yet',
    happened: `${T.fb} taps on 4 dishes without a preview showed the photo instead. The Salmon Poke Bowl had the most: ${p.fb} taps in ${p.open} opens.`,
    evidence: [
      `Salmon Poke Bowl: ${p.fb} taps (${Math.round((100 * p.fb) / p.open)}% of its opens)`,
      `Classic Eggs Benedict ${byId('benedict').fb} · Berry Pancake Stack ${byId('berrypancakes').fb} · Brioche French Toast ${byId('frenchtoast').fb}`,
      `Dishes with a preview: ${T.p25} previews in ${T.openWith} opens (${T.tapRateWith}%)`,
      `Dishes without: ${T.fb} taps in ${T.openWithout} opens (${T.tapRateWithout}%)`,
    ],
    uncertain: [
      'We do not know how diners felt about seeing the photo instead.',
      `Dishes with a preview had longer interaction (${T.timeWith} s vs ${T.timeWithout} s on average), but they are different dishes, so this does not show the preview caused it.`,
    ],
    matters:
      'The button appears on every dish. A diner who taps it and sees a photo may not get the closer look they wanted.',
    reasons: [
      'Diners may want to see the ingredients of bowls and plated dishes (inferred, not verified).',
      'The button may simply be easy to tap (not tested).',
    ],
    action:
      'Consider adding a 2.5D preview for the Salmon Poke Bowl first, since it had the most taps.',
  },
  {
    id: 'i2',
    rank: 'Also worth considering',
    dish: 'poke',
    title: 'The Salmon Poke Bowl is opened often, with fewer verified orders on record',
    happened: `It had ${p.open} opens, second only to Avocado Toast (${byId('avotoast').open}), and ${p.ord} verified orders on record. The other dishes with a record have ${byId('benedict').ord}–${byId('avotoast').ord}.`,
    evidence: [
      `${p.open} opens · ${p.again} opened again · in ${p.cmp} comparisons`,
      '22 comparisons were with the Harvest Power Bowl',
      `Order records exist for ${T.withRec} of ${DISH.length} dishes and are entered by hand`,
    ],
    uncertain: [
      'A dish that was viewed but not ordered is not assumed to be rejected.',
      `Orders may be unrecorded, so ${p.ord} may be too low.`,
    ],
    matters:
      'If diners are choosing between the two bowls, how each dish is described could affect the choice.',
    reasons: [
      'Diners may be choosing between the Poke Bowl and the Harvest Power Bowl (22 comparisons, inferred).',
      'Some orders may not have been recorded (possible).',
    ],
    action:
      'Consider checking that Poke Bowl orders are being recorded, then review its description and ingredients for clarity.',
  },
  {
    id: 'i3',
    rank: 'Also worth considering',
    dish: 'greek',
    title: 'Three dishes have no order record, so their outcome is unknown',
    happened: `Berry Pancake Stack, Brioche French Toast and Garden Avocado Salad have no verified order record this week. Together they had ${byId('berrypancakes').open + byId('frenchtoast').open + g.open} opens.`,
    evidence: [
      `Berry Pancake Stack ${byId('berrypancakes').open} opens · Brioche French Toast ${byId('frenchtoast').open} · Garden Avocado Salad ${g.open}`,
      `Garden Avocado Salad: ${g.p25} 2.5D previews in ${g.open} opens (${Math.round((100 * g.p25) / g.open)}%)`,
    ],
    uncertain: [
      'No record is shown as Unknown. It does not mean no one ordered them.',
      'We cannot say whether these dishes are doing well or poorly.',
    ],
    matters:
      'Without order records, a report can show attention but not outcomes for these dishes.',
    reasons: ['Orders may not be entered by hand for these dishes (possible).'],
    action:
      'Consider recording verified orders for these three dishes so future reports can show them.',
  },
];

/* ---------- AI chat: sample answers built from the same data ---------- */
export type SectionKind = 'obs' | 'ver' | 'unk' | 'rsn';
export type Answer = {
  short: string;
  secs: { k: SectionKind; items: string[] }[];
  ev: string[];
  follow: string[];
};

export const SEC: Record<SectionKind, string> = {
  obs: 'Observed',
  ver: 'Verified order',
  unk: 'Unknown',
  rsn: 'Possible reasons (AI hypotheses)',
};
export const EVT =
  'Events used: menu_opened, dish_detail_opened, dish_revisited, compare_started, compare_dish_replaced, preview_failed, fallback_shown. Not used: ready_to_order_tapped.';
const topN = (k: SortKey, n = 3) => bySort(k).slice(0, n);
const first = <T>(a: T[]): T => {
  const item = a[0];
  if (item === undefined) throw new Error('Empty list');
  return item;
};
const second = <T>(a: T[]): T => first(a.slice(1));
const biggestRise = first(
  [...DISH].sort((a, b) => b.open - (b.weekly[2] ?? 0) - (a.open - (a.weekly[2] ?? 0))),
);

export const QUICK = ['top', 'orders', 'interact', 'improve', 'week'];

export const ANSWERS: Record<string, () => Answer> = {
  top: () => {
    const t = topN('open');
    return {
      short: `${first(t).name} (${first(t).open} opens) and ${second(t).name} (${second(t).open}) drew the most attention this week.`,
      secs: [
        {
          k: 'obs',
          items: [
            `Most opens: ${t.map((d) => `${d.name} ${d.open}`).join(' · ')}`,
            `Longest average interaction: ${bySort('time')
              .slice(0, 2)
              .map((d) => `${d.name} ${d.time} s`)
              .join(' · ')}`,
            `Opened again most often: ${bySort('again')
              .slice(0, 2)
              .map((d) => `${d.name} ${d.again}`)
              .join(' · ')}`,
          ],
        },
        {
          k: 'unk',
          items: ['Attention is not a preference. Opens do not show whether a diner ordered.'],
        },
      ],
      ev: [
        `Period ${REST.period}, ${SESSIONS.now} menu sessions, ${T.open} dish opens in total.`,
        EVT,
      ],
      follow: ['orders', 'interact'],
    };
  },
  orders: () => ({
    short: `The Salmon Poke Bowl is opened often (${p.open} opens, second most) and has ${p.ord} verified orders on record, the lowest of the dishes that have a record.`,
    secs: [
      {
        k: 'obs',
        items: [
          `${p.open} opens · ${p.again} opened again · in ${p.cmp} comparisons`,
          '22 of those comparisons were with the Harvest Power Bowl',
        ],
      },
      { k: 'ver', items: DISH.filter((d) => d.ord !== null).map((d) => `${d.name}: ${d.ord}`) },
      {
        k: 'unk',
        items: [
          'Berry Pancake Stack, Brioche French Toast and Garden Avocado Salad have no order record. Their outcome is Unknown, not zero.',
          `Order records are entered by hand and may be incomplete, so ${p.ord} may undercount.`,
        ],
      },
      {
        k: 'rsn',
        items: [
          'Diners may be choosing between the two bowls (inferred from comparisons, not verified).',
          'Some Poke Bowl orders may be unrecorded (possible).',
        ],
      },
    ],
    ev: [
      `Orders: manual records for ${T.withRec} of ${DISH.length} dishes.`,
      'I do not describe a viewed dish as rejected or lost.',
      EVT,
    ],
    follow: ['premise', 'improve'],
  }),
  interact: () => ({
    short: `Across ${SESSIONS.now} menu sessions, diners opened ${T.open} dishes, about ${(T.open / SESSIONS.now).toFixed(1)} per session.`,
    secs: [
      {
        k: 'obs',
        items: [
          `${T.again} dish openings (${pc(T.again, T.open)}%) were a diner opening a dish again`,
          `${T.comparisons} comparisons started`,
          `${T.p25} 2.5D previews shown, plus ${T.fb} taps that showed the photo instead`,
          `Average interaction time: ${T.time} s per dish opening (sample measure)`,
        ],
      },
      {
        k: 'unk',
        items: ['How interaction time is captured is not final, so treat it as a rough guide.'],
      },
      {
        k: 'rsn',
        items: ['Diners who open a dish again may be deciding between options (inferred).'],
      },
    ],
    ev: [EVT],
    follow: ['p25', 'compare'],
  }),
  improve: () => ({
    short: 'Two options look worth considering this week. They are suggestions, not predictions.',
    secs: [
      {
        k: 'obs',
        items: [
          `${p.fb} taps on “View in 2.5D” for the Salmon Poke Bowl showed the photo only`,
          '3 dishes have no order record',
        ],
      },
      { k: 'unk', items: ['We do not know how the photo fallback affected any order.'] },
      {
        k: 'rsn',
        items: [
          'Add a 2.5D preview for the Salmon Poke Bowl first (most taps).',
          'Record verified orders for Berry Pancake Stack, Brioche French Toast and Garden Avocado Salad.',
        ],
      },
    ],
    ev: ['Both come from the report. Nothing is sent to diners.', EVT],
    follow: ['p25', 'week'],
  }),
  week: () => ({
    short: `Menu activity rose this week: ${T.open} dish opens vs ${PREV.open} last week (${pctChg(T.open, PREV.open) > 0 ? '+' : ''}${pctChg(T.open, PREV.open)}%).`,
    secs: [
      {
        k: 'obs',
        items: [
          `Menu sessions ${SESSIONS.now} vs ${SESSIONS.prev}`,
          `2.5D previews shown ${T.p25} vs ${PREV.p25}`,
          `Average interaction ${T.time} s vs ${PREV.time} s`,
          `Biggest rise in opens: ${biggestRise.name} (+${biggestRise.open - (biggestRise.weekly[2] ?? 0)})`,
        ],
      },
      {
        k: 'ver',
        items: [
          `${T.ord} verified orders on record vs ${PREV.ord} last week, for ${T.withRec} of ${DISH.length} dishes only`,
        ],
      },
      { k: 'unk', items: [`Orders for the other ${DISH.length - T.withRec} dishes are Unknown.`] },
    ],
    ev: [
      `Weeks compared: ${REST.period} and ${REST.prev}. A change in numbers is an association, not a cause.`,
      EVT,
    ],
    follow: ['top', 'improve'],
  }),
  p25: () => ({
    short:
      'Diners tap “View in 2.5D” on dishes without a preview about half as often as on dishes with one, and then see the photo.',
    secs: [
      {
        k: 'obs',
        items: [
          `Dishes with a preview: ${T.p25} previews in ${T.openWith} opens (${T.tapRateWith}%)`,
          `Dishes without: ${T.fb} taps in ${T.openWithout} opens (${T.tapRateWithout}%) that showed the photo`,
        ],
      },
      {
        k: 'unk',
        items: ['We do not know whether the photo fallback changed any diner’s decision.'],
      },
      { k: 'rsn', items: ['Diners may want to see ingredients (inferred, not verified).'] },
    ],
    ev: ['Events: fallback_shown, preview_failed.'],
    follow: ['improve', 'compare'],
  }),
  compare: () => ({
    short: `${T.comparisons} comparisons started. Most were between similar dishes.`,
    secs: [
      {
        k: 'obs',
        items: PAIRS.map((pr) => `${byId(pr[0]).name} × ${byId(pr[1]).name}: ${pr[2]}`).concat([
          `Other pairs: ${T.comparisons - PAIRS.reduce((s, pr) => s + pr[2], 0)}`,
        ]),
      },
      { k: 'rsn', items: ['Diners may be choosing between similar options (inferred).'] },
    ],
    ev: ['Events: compare_started, compare_dish_replaced.'],
    follow: ['orders', 'top'],
  }),
  premise: () => ({
    short:
      'I can’t tell from this data whether a dish was rejected. A dish that was viewed but not ordered is not assumed to be rejected.',
    secs: [
      {
        k: 'obs',
        items: ['I can show what diners did: opens, opens again, comparisons, time interacting.'],
      },
      {
        k: 'unk',
        items: ['With no verified order record, an outcome is Unknown, not lost and not negative.'],
      },
      {
        k: 'rsn',
        items: ['Reasons are hypotheses, shown with their evidence. I will not state one as fact.'],
      },
    ],
    ev: ['This follows the labels used across the dashboard.'],
    follow: ['orders', 'top'],
  }),
  cant: () => ({
    short:
      'I can’t answer that from the diner events and order records I have. I don’t want to guess.',
    secs: [
      {
        k: 'unk',
        items: [
          'Try a question about opens, comparisons, 2.5D previews, verified orders or the weekly change.',
        ],
      },
    ],
    ev: [EVT],
    follow: ['top', 'orders', 'week'],
  }),
  empty: () => ({
    short: 'There are no diner events yet, so I have nothing to analyze.',
    secs: [{ k: 'unk', items: ['Data appears once diners use the menu.'] }],
    ev: [],
    follow: [],
  }),
};

for (const i of INSIGHTS) {
  ANSWERS[`ins:${i.id}`] = () => ({
    short: `About “${i.title}”: ${i.happened}`,
    secs: [
      { k: 'obs', items: i.evidence },
      { k: 'unk', items: i.uncertain },
      { k: 'rsn', items: i.reasons },
    ],
    ev: [`Why it might matter: ${i.matters}`, EVT],
    follow:
      i.id === 'i1'
        ? ['p25', 'improve']
        : i.id === 'i2'
          ? ['orders', 'compare']
          : ['orders', 'week'],
  });
}
for (const d of DISH) {
  ANSWERS[`dish:${d.id}`] = () => ({
    short: `${d.name}: ${d.open} opens this week, ${d.open >= T.open / DISH.length ? 'above' : 'below'} the average of ${Math.round(T.open / DISH.length)} per dish.`,
    secs: [
      {
        k: 'obs',
        items: [
          `${d.open} opens · ${d.again} opened again · in ${d.cmp} comparisons`,
          `Average interaction ${d.time} s`,
          d.has25
            ? `${d.p25} 2.5D previews shown`
            : `${d.fb} taps on “View in 2.5D” showed the photo (no preview yet)`,
        ],
      },
      d.ord !== null
        ? { k: 'ver', items: [`${d.ord} verified orders on record`] }
        : { k: 'unk', items: ['No order record. Outcome is Unknown, not zero.'] },
      { k: 'rsn', items: ['The data does not point to a clear reason, so I won’t offer one.'] },
    ],
    ev: [EVT],
    follow: ['top', 'orders'],
  });
}

const NAMEMAP: [string, string][] = [
  ['pancake', 'berrypancakes'],
  ['french', 'frenchtoast'],
  ['salad', 'greek'],
  ['avocado toast', 'avotoast'],
  ['toast', 'avotoast'],
  ['poke', 'poke'],
  ['benedict', 'benedict'],
  ['harvest', 'harvest'],
  ['power bowl', 'harvest'],
];

export function route(q: string): string | null {
  const s = q.toLowerCase();
  if (/reject|\blost\b|didn.?t like|dislike|hate|failed? dish/.test(s)) return 'premise';
  if (/(view|open).*(order)|fewer.*order|few.*order|verified|not order|orders?\b/.test(s))
    return 'orders';
  if (/most attention|popular|most viewed|top dish|best|attention/.test(s)) return 'top';
  if (/interact|behav|customers|diners.*(menu|use)|browse/.test(s)) return 'interact';
  if (/improv|suggest|recommend|should i|consider/.test(s)) return 'improve';
  if (/2\.?5|preview/.test(s)) return 'p25';
  if (/compar/.test(s)) return 'compare';
  if (/week|perform|summary|overall|trend/.test(s)) return 'week';
  for (const [w, id] of NAMEMAP) if (s.includes(w)) return `dish:${id}`;
  return null;
}

export const QUESTIONS: Record<string, string> = {
  top: 'Which dishes are getting the most attention?',
  orders: 'Which dishes are viewed often but have fewer verified orders?',
  interact: 'How are customers interacting with my menu?',
  improve: 'What improvements should I consider?',
  week: 'How did my menu perform this week?',
  p25: 'How are diners using the 2.5D preview?',
  compare: 'Which dishes do diners compare?',
  premise: 'Which dishes are customers rejecting?',
};
INSIGHTS.forEach((i, n) => {
  QUESTIONS[`ins:i${n + 1}`] = `Tell me more about: ${i.title}`;
});
for (const d of DISH) QUESTIONS[`dish:${d.id}`] = `How is the ${d.name} doing?`;

/* ---------- editable menu ---------- */
export const CATS = ['Breakfast', 'Brunch Bowls', 'Salads'];

export type MenuItem = {
  id: string | null;
  name: string;
  cat: string;
  price: number | string;
  desc: string;
  ing: string[];
  aiIng: string[];
  upload: string | null;
  rights: boolean;
  aiUsed: boolean;
  aiReviewed: boolean;
  has25: boolean;
  status: 'draft' | 'ready' | 'live';
  dishVerificationStatus?: 'not_verified' | 'verified';
  photoVerificationStatus?: 'not_verified' | 'verified' | 'rejected';
  photoId?: string | null;
};

export const imgOf = (m: Pick<MenuItem, 'upload' | 'id'>) =>
  m.upload || (m.id ? THUMBS[m.id] : '') || '';
export const newDraft = (): MenuItem => ({
  id: null,
  name: '',
  cat: 'Breakfast',
  price: '',
  desc: '',
  ing: [],
  aiIng: [],
  upload: null,
  rights: false,
  aiUsed: false,
  aiReviewed: false,
  has25: false,
  status: 'draft',
});
export const initialMenu = (): MenuItem[] =>
  DISH.map((d) => ({
    id: d.id,
    name: d.name,
    cat: d.cat,
    price: d.price,
    desc: d.desc,
    ing: [...d.ing],
    aiIng: [],
    upload: null,
    rights: false,
    aiUsed: false,
    aiReviewed: false,
    has25: d.has25,
    status: 'live',
  }));

export function suggestIng(name: string): string[] {
  const s = name.toLowerCase();
  const out: string[] = [];
  if (/avocado/.test(s)) out.push('Avocado');
  if (/salmon/.test(s)) out.push('Salmon');
  if (/egg/.test(s)) out.push('Eggs');
  if (/bowl/.test(s)) out.push('Rice', 'Mixed greens');
  if (/salad/.test(s)) out.push('Mixed greens', 'Cherry tomato');
  if (/pancake|toast|waffle/.test(s)) out.push('Maple syrup', 'Seasonal berries');
  return out.length ? [...new Set(out)] : ['Seasonal vegetables', 'Fresh herbs'];
}

export type ActionStatus = 'suggested' | 'planned' | 'done' | 'dismissed' | 'approved';
export type ActionState = { status: ActionStatus; text: string; reason?: string; date?: string };
export type Scenario = 'A' | 'B' | 'C' | 'empty';
