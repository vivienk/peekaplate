import {
  type OwnerReportQuestionResult,
  OwnerReportQuestionResultSchema,
} from '@peekaplate/contracts/owner-analysis';
import {
  OWNER_PRODUCTION_TODAY_VERSION,
  type OwnerDishReport,
  ownerReportMidnight,
} from '@peekaplate/contracts/owner-report';

type Dish = OwnerDishReport['dishes'][number];
type Answer = Extract<OwnerReportQuestionResult, { status: 'answered' }>;
type Refusal = Extract<OwnerReportQuestionResult, { status: 'abstained' }>;

const metricPhrases: readonly [Answer['metric'], RegExp][] = [
  ['open_rate', /\b(?:open|opening|view) rates?\b/gu],
  ['save_rate', /\b(?:save|saving|favorite|favourite) rates?\b/gu],
  ['engagement_rate', /\bengagement rates?\b/gu],
  ['active_sessions', /\b(?:active sessions?|sessions?|(?:dish )?visits?)\b/gu],
  ['timing_coverage', /\b(?:interaction )?timing coverage\b/gu],
  [
    'avg_interaction_time_seconds',
    /\b(?:avg|average) (?:dish )?(?:interaction|active) (?:time|duration)(?: in seconds)?\b/gu,
  ],
  ['portion_previews_shown', /\b(?:(?:2 5d )?portion|2 5d) previews?(?: shown| viewed)?\b/gu],
  ['comparisons_started', /\b(?:comparisons?(?: started| starts?)?|compare starts?)\b/gu],
];
const chartRequestPrefix = /^(?:can|could|would) you (?:please )?/;
const chartPrefix =
  /^(?:please )?(?:(?:(?:show(?: me)?|make|draw|create|generate|give(?: me)?) (?:a |the )?)?(?:bar )?(?:chart|graph)|plot|visualize) (?:of |for )?/;
const chartSuffix =
  / (?:and |as |in )(?:(?:show )?(?:a |the )(?:bar )?(?:chart|graph)|(?:plot|chart|graph) (?:it|them))$/;
const readPrefix =
  /^(?:please )?(?:(?:what (?:is|are|was|were)|how many|show(?: me)?|give(?: me)?|tell(?: me)?) )?(?:the )?/;
const windowSuffix =
  / (?:in|for|during) (?:(?:this|the) (?:report|window)|the (?:current|displayed) (?:report|window))$/;
const maxPoints = 20;
const ranks: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const countMetrics = new Set<Answer['metric']>([
  'active_sessions',
  'portion_previews_shown',
  'comparisons_started',
]);

function normalize(text: string) {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/['’]s\b/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

type Selection = {
  metric: Answer['metric'];
  dishes: readonly Dish[];
  chart: boolean;
  rank?: { order: 'high' | 'low'; size: number };
};

function interpretQuestion(question: string, report: OwnerDishReport, now: Date): Selection | null {
  let query = normalize(question).replace(chartRequestPrefix, '').replace(windowSuffix, '');
  const chart = chartPrefix.test(query) || chartSuffix.test(query);
  query = query.replace(chartPrefix, '').replace(chartSuffix, '').replace(windowSuffix, '');
  if (
    report.source === 'production' &&
    report.report_metadata.calculation_version === OWNER_PRODUCTION_TODAY_VERSION &&
    ownerReportMidnight(new Date(report.report_metadata.date_window.start_time)).getTime() ===
      ownerReportMidnight(now).getTime()
  ) {
    query = query.replace(/ (?:for )?today$/, '');
  }

  // Match whole names in longest-first order. Ambiguous names never select a row.
  const names = new Map<string, Dish | null>();
  for (const dish of report.dishes) {
    const name = normalize(dish.name);
    if (name && query.includes(name)) names.set(name, names.has(name) ? null : dish);
  }
  const mentions: Dish[] = [];
  for (const [name, dish] of [...names].sort(([left], [right]) => right.length - left.length)) {
    const match = new RegExp(`(^| )${name}(?= |$)`, 'gu');
    if (dish === null && match.test(query)) return null;
    query = query.replace(match, (_name, boundary: string) => {
      if (dish) mentions.push(dish);
      return `${boundary}@dish`;
    });
  }

  const usesVisitAlias = /\bvisits?\b/u.test(query);
  const matches = new Set<Answer['metric']>();
  for (const [metric, phrase] of metricPhrases) {
    query = query.replace(phrase, () => {
      matches.add(metric);
      return '@metric';
    });
  }
  if (matches.size !== 1) return null;
  const [metric] = matches;
  if (!metric) return null;
  query = query.replace(readPrefix, '');

  if (
    mentions.length === 1 &&
    (/^(?:@metric (?:for|of|on) (?:the )?@dish|@dish @metric)$/.test(query) ||
      (countMetrics.has(metric) && /^@metric did (?:the )?@dish have$/.test(query)))
  ) {
    return { metric, dishes: mentions, chart };
  }
  if (
    mentions.length === 2 &&
    mentions[0]?.dish_id !== mentions[1]?.dish_id &&
    (/^compar(?:e|ing) (?:the )?(?:@dish (?:and|with|to|vs|versus) @dish (?:by|on|for) (?:the )?@metric|@metric (?:of|for|between) @dish (?:and|with|vs|versus) @dish)$/.test(
      query,
    ) ||
      (chart && /^@metric (?:for|of) @dish (?:and|vs|versus) @dish$/.test(query)))
  ) {
    // The replacement pass ran longest-first, so recover the order the owner asked for.
    const input = ` ${normalize(question)} `;
    mentions.sort(
      (left, right) =>
        input.indexOf(` ${normalize(left.name)} `) - input.indexOf(` ${normalize(right.name)} `),
    );
    return { metric, dishes: mentions, chart };
  }
  if (mentions.length) return null;
  if (
    (!usesVisitAlias || chart) &&
    /^(?:compare )?@metric (?:by dish|(?:for|across|by) (?:all )?dishes)$/.test(query)
  ) {
    return { metric, dishes: report.dishes, chart };
  }
  // A vague request for visits could refer to the overview rather than dish active sessions.
  if (usesVisitAlias) return null;
  if (chart && query === '@metric') return { metric, dishes: report.dishes, chart };
  const singleRank = /^which dish(?:es)? (?:had|has|have) (?:the )?(highest|lowest) @metric$/.exec(
    query,
  );
  const groupRank =
    /^(?:the )?(top|bottom) (\d{1,2}|one|two|three|four|five) dishes? (?:by|for|with) @metric$/.exec(
      query,
    );
  const metricRank = /^(?:the )?(\d{1,2}|one|two|three|four|five) (highest|lowest) @metric$/.exec(
    query,
  );
  if (!singleRank && !groupRank && !metricRank) return null;
  const quantity = groupRank?.[2] ?? metricRank?.[1] ?? 'one';
  const size = ranks[quantity] ?? Number(quantity);
  if (!Number.isInteger(size) || size < 1 || size > maxPoints) return null;
  const direction = singleRank?.[1] ?? groupRank?.[1] ?? metricRank?.[2];
  const order = direction === 'lowest' || direction === 'bottom' ? 'low' : 'high';
  return { metric, dishes: report.dishes, chart, rank: { order, size } };
}

export function answerOwnerReportQuestion(
  report: OwnerDishReport,
  question: string,
  now: Date,
  reportSnapshot: string,
  displayActionsAllowed = false,
): OwnerReportQuestionResult {
  const metadata = report.report_metadata;
  const timeWindow = {
    start: metadata.date_window.start_time,
    end: metadata.date_window.end_time,
  };
  const base = {
    schemaVersion: 'owner-report-question.v1',
    venueId: report.venue_id,
    source: report.source,
    reportSnapshot,
    timeWindow,
  } as const;
  const abstain = (reason: Refusal['reason']) =>
    OwnerReportQuestionResultSchema.parse({ ...base, status: 'abstained', reason });
  if (
    metadata.report_status !== 'NORMAL' ||
    metadata.freshness.is_stale !== false ||
    Date.parse(metadata.generated_at) > now.getTime() ||
    Date.parse(timeWindow.end) > now.getTime() ||
    Date.parse(timeWindow.start) >= Date.parse(timeWindow.end)
  ) {
    return abstain('unusable_evidence');
  }
  const selection = interpretQuestion(question, report, now);
  if (!selection) return abstain('unsupported_question');
  const { metric } = selection;
  const usesDisplayActions =
    metric === 'portion_previews_shown' || metric === 'comparisons_started';
  if (
    (usesDisplayActions && !displayActionsAllowed) ||
    (selection.dishes === report.dishes &&
      report.dishes.length !== metadata.coverage.total_dishes_monitored)
  ) {
    return abstain('unusable_evidence');
  }

  const points: Answer['points'] = [];
  const labels = new Set<string>();
  for (const dish of selection.dishes) {
    const cell = usesDisplayActions ? dish.display_actions?.[metric] : dish.metrics[metric];
    const label = normalize(dish.name);
    // Do not silently drop protected dishes and present a partial ranking or comparison as complete.
    if (
      dish.evidence_state !== 'NORMAL' ||
      !cell ||
      (cell.status !== 'NORMAL' && cell.status !== 'VALID_ZERO') ||
      cell.value === null ||
      labels.has(label)
    ) {
      return abstain('unusable_evidence');
    }
    labels.add(label);
    points.push({ label: dish.name, value: cell.value });
  }

  const { rank } = selection;
  if (rank) {
    points.sort((left, right) => {
      const difference =
        rank.order === 'high' ? right.value - left.value : left.value - right.value;
      return difference || left.label.localeCompare(right.label);
    });
    const boundary = points[rank.size - 1];
    // Keep ties at the requested cutoff so a same-value dish never disappears arbitrarily.
    let end = rank.size;
    while (boundary && points[end]?.value === boundary.value) end++;
    points.splice(end);
  } else if (selection.dishes === report.dishes) {
    points.sort((left, right) => left.label.localeCompare(right.label));
  }
  if (points.length === 0 || points.length > maxPoints) return abstain('unusable_evidence');
  const result = OwnerReportQuestionResultSchema.safeParse({
    ...base,
    status: 'answered',
    metric: selection.metric,
    chart: selection.chart,
    points,
  });
  return result.success ? result.data : abstain('unusable_evidence');
}
