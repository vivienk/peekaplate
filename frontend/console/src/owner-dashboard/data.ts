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
export const WK_ORDERS: (number | null)[] = [null, null, null, null];

// open = dish opens, again = opened again, cmp = in a comparison, p25 = 2.5D previews shown,
// fb = tapped 2.5D and saw the photo, time = avg seconds interacting per open,
// ord = verified orders on record (null = no record), weekly = opens over 4 weeks,
// seen = menu visits that showed the dish (of SESSIONS.now). Fictional sample values.
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
  seen: number;
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
    seen: 360,
    cmp: 33,
    p25: 62,
    fb: 0,
    time: 74,
    ord: null,
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
    seen: 210,
    cmp: 24,
    p25: 0,
    fb: 22,
    time: 52,
    ord: null,
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
    seen: 280,
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
    seen: 140,
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
    seen: 300,
    cmp: 29,
    p25: 57,
    fb: 0,
    time: 81,
    ord: null,
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
    seen: 330,
    cmp: 40,
    p25: 0,
    fb: 31,
    time: 58,
    ord: null,
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
    seen: 250,
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
  ord: null,
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
    title: 'The Salmon Poke Bowl is opened often (verified order outcomes are unavailable in P0)',
    happened: `It had ${p.open} opens, second only to Avocado Toast (${byId('avotoast').open}). Verified order outcomes are unavailable in the synthetic P0 scope.`,
    evidence: [
      `${p.open} opens · ${p.again} opened again · in ${p.cmp} comparisons`,
      '22 comparisons were with the Harvest Power Bowl',
      `Verified order outcomes are unavailable in the synthetic P0 scope'A dish that was viewed but not ordered is not assumed to be rejected.',
      `Orders may be unrecorded, so ${p.ord} may be too low.`,
    ],
    matters:
      'If diners are choosing between the two bowls, how each dish is described could affect the choice.',
    reasons: [
      'Diners may be choosing between the Poke Bowl and the Harvest Power Bowl (22 comparisons, inferred).',
      'Only descriptive diner observation metrics are supported in P0.',
    ],
    action:
      'Review the Poke Bowl description, ingredients, and 2.5D preview coverage; verified orders are unavailable in P0.',
  },
  {
    id: 'i3',
    rank: 'Also worth considering',
    dish: 'greek',
    title: 'Three dishes have high opens; verified order outcomes are unavailable in P0',
    happened: `Berry Pancake Stack, Brioche French Toast and Garden Avocado Salad had ${byId('pancakes').open + byId('french').open + byId('salad').open} combined opens this week, while verified orders remain unavailable in P0.`,
    evidence: [
      `Berry Pancake Stack ${byId('berrypancakes').open} opens · Brioche French Toast ${byId('frenchtoast').open} · Garden Avocado Salad ${g.open}`,
      `Garden Avocado Salad: ${g.p25} 2.5D previews in ${g.open} opens (${Math.round((100 * g.p25) / g.open)}%)`,
    ],
    uncertain: [
      'Verified orders are unavailable in the synthetic P0 scope and are never inferred as zero or lost.',
      'We cannot say whether these dishes are doing well or poorly.',
    ],
    matters:
      'Without order records, a report can show attention but not outcomes for these dishes.',
    reasons: ['No verified order source is connected in P0.'],
    action:
      'Verified orders are unavailable in the synthetic P0 scope; rely on descriptive observation metrics.',
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

// "Opened after being seen": visits that opened the dish ÷ visits that showed it, the same idea as
// the owner report's open_rate. A visit counts once however often it reopened the dish, so opened
// visits are opens minus re-opens. Dishes seen in fewer than PRIVACY_FLOOR visits are left out,
// as the owner report does.
const PRIVACY_FLOOR = 10;
export type Attention = { dish: Dish; opened: number; seen: number; rate: number };
export function attentionRanking(dishes: Dish[] = DISH): Attention[] {
  return dishes
    .filter((d) => d.seen >= PRIVACY_FLOOR)
    .map((d) => {
      const opened = Math.max(0, Math.min(d.seen, d.open - d.again));
      return { dish: d, opened, seen: d.seen, rate: opened / d.seen };
    })
    .sort((a, b) => b.rate - a.rate || b.seen - a.seen || a.dish.name.localeCompare(b.dish.name));
}
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
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
    const ranked = attentionRanking();
    const [a, b] = [first(ranked), second(ranked)];
    const mostOpens = first(bySort('open'));
    return {
      short: `${a.dish.name} (${pct(a.rate)}) and ${b.dish.name} (${pct(b.rate)}) were opened most often after diners saw them this week.`,
      secs: [
        {
          k: 'obs',
          items: [
            ...ranked
              .slice(0, 3)
              .map(
                (r) =>
                  `${r.dish.name}: opened in ${r.opened} of ${r.seen} visits that showed it (${pct(r.rate)})`,
              ),
            `Most opens in total: ${mostOpens.name} (${mostOpens.open}), shown in ${mostOpens.seen} visits.`,
          ],
        },
        {
          k: 'unk',
          items: [
            'Attention is not a preference. Opening a dish does not show whether a diner ordered it.',
          ],
        },
      ],
      ev: [
        'Open rate = visits that opened the dish ÷ visits that showed it. Reopening in the same visit counts once.',
        `Period ${REST.period}, ${SESSIONS.now} menu sessions. Dishes shown in fewer than ${PRIVACY_FLOOR} visits are left out.`,
        EVT,
      ],
      follow: ['orders', 'interact'],
    };
  },
  orders: () => ({
    title: 'Verified orders are unavailable in P0',
    short: 'Verified orders are unavailable in the synthetic P0 scope because no verified POS or checkout order source is connected.',
    evidence: [
      { k: 'unk', items: ['Verified orders status: Unavailable (no verified order source in P0).'] },
      { k: 'obs', items: ['Supported descriptive metrics remain active: menu sessions, dish opens, interaction time, timing coverage, save rate, and engagement rate.'] },
    ],
    caveat: 'Synthetic P0 datasets never fabricate order counts or revenue; only descriptive observation metrics are reported.',
    follow: ['top', 'interact', 'week'],
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
        items: ['Try a question about opens, comparisons, 2.5D previews, or the weekly change.'],
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
      { k: 'unk', items: ['Verified orders: Unavailable in synthetic P0 scope (no verified order source).'] },
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
  orders: 'Are verified orders available in this report?',
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
  /** Screen 9 serving size in whole people (1–100), required before review. */
  size: string;
  desc: string;
  ing: string[];
  aiIng: string[];
  /** Allergens the owner listed on Screen 9; hidden from diners until approved. */
  alg: string[];
  aiAlg: string[];
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
  cat: '',
  price: '',
  size: '',
  desc: '',
  ing: [],
  aiIng: [],
  alg: [],
  aiAlg: [],
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
    size: '',
    desc: d.desc,
    ing: [...d.ing],
    aiIng: [],
    alg: [],
    aiAlg: [],
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

// Demo stand-in for "Suggest with AI" on allergens: keyword rules over the name and ingredients.
// Suggestions are proposals only; the owner must review them before diners can see anything.
export function suggestAlg(name: string, ing: string[]): string[] {
  const s = [name, ...ing].join(' ').toLowerCase();
  const out: string[] = [];
  if (/bread|toast|pancake|waffle|wheat|flour|pasta/.test(s)) out.push('Gluten');
  if (/egg/.test(s)) out.push('Eggs');
  if (/milk|cheese|butter|cream|yogurt|feta/.test(s)) out.push('Milk');
  if (/salmon|tuna|fish/.test(s)) out.push('Fish');
  if (/shrimp|prawn|crab/.test(s)) out.push('Shellfish');
  if (/peanut/.test(s)) out.push('Peanuts');
  if (/almond|walnut|pecan|cashew|hazelnut/.test(s)) out.push('Tree nuts');
  if (/sesame|tahini/.test(s)) out.push('Sesame');
  if (/soy|tofu/.test(s)) out.push('Soy');
  return out;
}

export type ActionStatus = 'suggested' | 'planned' | 'done' | 'dismissed' | 'approved';
export type ActionState = { status: ActionStatus; text: string; reason?: string; date?: string };
export type Scenario = 'A' | 'B' | 'C' | 'empty';
