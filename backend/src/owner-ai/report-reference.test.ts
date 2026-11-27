import {
  OWNER_PRODUCTION_DAY_VERSION,
  OWNER_PRODUCTION_TODAY_VERSION,
  type OwnerDishReport,
  OwnerDishReportSchema,
} from '@peekaplate/contracts/owner-report';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { CommandError } from '../dish-command';
import { type Bindings, createApp } from '../index';
import { ownerReportDayWindow } from '../owner-report-batches';
import {
  mintOwnerReportReference,
  OWNER_REPORT_REFERENCE_HEADER,
  ownerReportSnapshot,
  readOwnerReportReference,
} from './report-reference';

const venuePath = `/api/v1/venues/${LOCAL_AI_VENUE}`;
const origin = 'http://127.0.0.1:5174';
const productionOrigin = 'https://peekaplate.app';
const owner = 'report-fixture-owner';
const secret = 'fixture-report-reference-signing-key-for-tests-only';
const start = Date.parse('2026-11-16T12:00:00.219Z');
const restaurantVisitsQuestion = 'How many restaurant visits were there this period?';
type MenuSessionCount = NonNullable<OwnerDishReport['summary']>['current']['menu_sessions'];

afterEach(() => vi.unstubAllGlobals());

it('signs the current cutoff for both completed-day and today dish evidence', async () => {
  const now = new Date('2026-11-24T05:16:00.000Z');
  const current = {
    start_time: '2026-11-23T08:00:00.000Z',
    end_time: '2026-11-24T05:15:00.000Z',
  };
  const baseline = {
    start_time: '2026-11-22T08:00:00.000Z',
    end_time: current.start_time,
  };
  const missing = { value: null, status: 'MISSING' } as const;
  const metrics = {
    menu_sessions: missing,
    dish_opens: missing,
    avg_interaction_time_seconds: missing,
    portion_previews_shown: missing,
    verified_orders: missing,
  };
  const seed = localOwnerAiReport(now);
  const report = OwnerDishReportSchema.parse({
    ...seed,
    source: 'production',
    report_metadata: {
      ...seed.report_metadata,
      calculation_version: OWNER_PRODUCTION_DAY_VERSION,
      generated_at: current.end_time,
      date_window: { ...baseline, duration_hours: 24 },
    },
    summary: { periods: { current, baseline }, current: metrics, baseline: metrics },
  });
  const scope = { actorId: owner, venueId: LOCAL_AI_VENUE };
  const today = OwnerDishReportSchema.parse({
    ...report,
    report_metadata: {
      ...report.report_metadata,
      calculation_version: OWNER_PRODUCTION_TODAY_VERSION,
      date_window: { ...current, duration_hours: 21 },
    },
  });
  for (const snapshot of [report, today]) {
    const reference = await mintOwnerReportReference(snapshot, scope, secret, now);
    expect(await readOwnerReportReference(reference, scope, secret, now, 'production')).toEqual({
      anchor: now,
      snapshot: ownerReportSnapshot(snapshot),
    });
  }
});

function setup(
  source: 'synthetic' | 'production' = 'synthetic',
  sealedBatch: boolean | 'today' = false,
) {
  let now = start;
  const reportOrigin = source === 'production' ? productionOrigin : origin;
  const reportState = {
    allowed: true,
    fresh: true,
    rate: 0.5,
    reversed: false,
    actions: false,
    overviewOnly: false,
    menuSessions: (_cutoff: Date): MenuSessionCount => ({ value: null, status: 'MISSING' }),
    openings: (_cutoff: Date): { current: number | null; baseline: number | null } => ({
      current: null,
      baseline: null,
    }),
  };
  const readOwnerReport = vi.fn(async (actorId: string, venueId: string, anchor: Date) => {
    if (!reportState.allowed || actorId !== owner || venueId !== LOCAL_AI_VENUE) {
      throw new CommandError('forbidden', 403);
    }
    const report = OwnerDishReportSchema.parse({ ...localOwnerAiReport(anchor), source });
    if (sealedBatch === 'today') {
      const { start, end, baselineStart } = ownerReportDayWindow(anchor);
      const current = { start_time: start.toISOString(), end_time: end.toISOString() };
      const baseline = { start_time: baselineStart.toISOString(), end_time: current.start_time };
      const missing = { value: null, status: 'MISSING' } as const;
      const metrics = {
        menu_sessions: missing,
        dish_opens: missing,
        avg_interaction_time_seconds: missing,
        portion_previews_shown: missing,
        verified_orders: missing,
      };
      report.report_metadata.calculation_version = OWNER_PRODUCTION_TODAY_VERSION;
      report.report_metadata.generated_at = current.end_time;
      report.report_metadata.freshness.last_event_ingested_at = current.end_time;
      const dishStart = '2026-11-25T08:35:00.000Z';
      report.report_metadata.date_window = {
        start_time: dishStart,
        end_time: current.end_time,
        duration_hours: Math.floor((end.getTime() - Date.parse(dishStart)) / 3_600_000),
      };
      const openings = reportState.openings(end);
      const count = (value: number | null) =>
        value === null
          ? missing
          : { value, status: value === 0 ? ('VALID_ZERO' as const) : ('NORMAL' as const) };
      report.summary = {
        periods: { current, baseline },
        current: {
          ...metrics,
          dish_opens: count(openings.current),
          menu_sessions: reportState.menuSessions(end),
        },
        baseline: { ...metrics, dish_opens: count(openings.baseline) },
      };
    } else if (sealedBatch) {
      const end = Math.floor((anchor.getTime() - 60_000) / 300_000) * 300_000;
      report.report_metadata.calculation_version = 'production.batch.v1';
      report.report_metadata.date_window = {
        start_time: new Date(end - 300_000).toISOString(),
        end_time: new Date(end).toISOString(),
        duration_hours: 0,
      };
      delete report.summary;
    }
    const dish = report.dishes[0]!;
    dish.metrics.open_rate.value = reportState.rate;
    if (reportState.actions) {
      dish.display_actions = {
        portion_previews_shown: { value: 24, status: 'NORMAL' },
        comparisons_started: { value: 16, status: 'NORMAL' },
      };
    }
    report.dishes.push({
      ...dish,
      dish_id: '00000000-0000-4000-8000-000000000789',
      ...(sealedBatch === 'today' ? { name: 'Garden Salad' } : {}),
    });
    report.report_metadata.coverage = { total_dishes_monitored: 2, measurable_dishes_count: 2 };
    if (reportState.reversed) report.dishes.reverse();
    if (!reportState.fresh) report.report_metadata.freshness.is_stale = null;
    if (reportState.overviewOnly) {
      report.dishes = [];
      report.report_metadata.coverage = { total_dishes_monitored: 0, measurable_dishes_count: 0 };
      report.report_metadata.report_status = 'EMPTY';
    }
    return report;
  });
  const provider = vi.fn(async () =>
    Response.json({
      status: 'completed',
      model: 'gpt-6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"metric":"open_rate"}' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
    }),
  );
  vi.stubGlobal('fetch', provider);
  const worker = createApp({
    now: () => new Date(now),
    verify: async (authorization) => authorization.slice('Bearer '.length),
    execute: vi.fn(),
    readOwnerReport,
  });
  const limit = vi.fn(async () => ({ success: true }));
  const env: Bindings = {
    ...(source === 'production'
      ? {
          APP_ENV: 'production',
          OWNER_WORKFLOW_ENABLED: 'true',
          OWNER_PRODUCTION_REPORTS_ENABLED: 'true',
          OWNER_AI_RATE_LIMITER: { limit },
        }
      : { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: LOCAL_AI_VENUE }),
    OWNER_AI_RESPONSES_ENABLED: 'true',
    OWNER_AI_OPENAI_API_KEY: 'unused-test-provider-key',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_synthetic',
    OWNER_AI_REPORT_REFERENCE_SECRET: secret,
  };
  const get = (displayActions = false) =>
    worker.request(
      `${venuePath}/analytics/dishes?source=${source}${displayActions ? '&displayActions=true' : ''}`,
      { headers: { Authorization: `Bearer ${owner}`, Origin: reportOrigin } },
      env,
    );
  async function reference(displayActions = false) {
    const response = await get(displayActions);
    expect(response.status).toBe(200);
    const token = response.headers.get(OWNER_REPORT_REFERENCE_HEADER);
    expect(token).toBeTruthy();
    return token ?? undefined;
  }
  const analyze = (token?: string, actorId = owner, requestOrigin = reportOrigin) =>
    worker.request(
      `${venuePath}/ai/analysis`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${actorId}`,
          'Content-Type': 'application/json',
          Origin: requestOrigin,
          ...(token ? { [OWNER_REPORT_REFERENCE_HEADER]: token } : {}),
        },
        body: JSON.stringify({ dishId: LOCAL_AI_DISH, goal: 'menu' }),
      },
      env,
    );
  const ask = (
    token: string | undefined,
    body: unknown,
    actorId = owner,
    requestOrigin = reportOrigin,
    venueId = LOCAL_AI_VENUE,
  ) =>
    worker.request(
      `/api/v1/venues/${venueId}/ai/questions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${actorId}`,
          'Content-Type': 'application/json',
          Origin: requestOrigin,
          ...(token ? { [OWNER_REPORT_REFERENCE_HEADER]: token } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    );
  async function preflight(endpoint = 'analysis') {
    return worker.request(
      `${venuePath}/ai/${endpoint}`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: reportOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': OWNER_REPORT_REFERENCE_HEADER,
        },
      },
      env,
    );
  }
  return {
    get,
    reference,
    analyze,
    ask,
    preflight,
    env,
    advance(ms: number) {
      now += ms;
    },
    reportState,
    readOwnerReport,
    provider,
    limit,
  };
}

it('answers and charts the original authorized #272 dish window across its next cutoff', async () => {
  const s = setup('production', 'today');
  const signedAt = Date.parse('2026-11-25T12:00:59.000Z');
  s.advance(signedAt - start);
  delete s.env.OWNER_AI_OPENAI_API_KEY;
  delete s.env.OWNER_AI_OPENAI_PROJECT_ID;

  const preflight = await s.preflight('questions');
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(productionOrigin);
  expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
    OWNER_REPORT_REFERENCE_HEADER.toLowerCase(),
  );

  const report = await s.get();
  expect(report.status).toBe(200);
  const shown = OwnerDishReportSchema.parse(await report.json());
  const ref = report.headers.get(OWNER_REPORT_REFERENCE_HEADER) ?? undefined;
  expect(ref).toBeTruthy();
  s.advance(10_000);
  const latest = OwnerDishReportSchema.parse(await (await s.get()).json());
  expect(latest.report_metadata.date_window.end_time).toBe('2026-11-25T12:00:00.000Z');
  expect(shown.summary?.periods.current.start_time).toBe('2026-11-25T08:00:00.000Z');
  expect(shown.report_metadata.date_window.start_time).toBe('2026-11-25T08:35:00.000Z');

  const response = await s.ask(ref, {
    question: 'Show me a chart of the save rate for Garden Salad today.',
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    schemaVersion: 'owner-report-question.v1',
    venueId: shown.venue_id,
    source: 'production',
    reportSnapshot: ownerReportSnapshot(shown),
    timeWindow: { start: '2026-11-25T08:35:00.000Z', end: '2026-11-25T11:55:00.000Z' },
    status: 'answered',
    metric: 'save_rate',
    points: [{ label: 'Garden Salad', value: 0 }],
    chart: true,
  });
  expect(s.readOwnerReport.mock.calls.map((call) => call[2].getTime())).toEqual([
    signedAt,
    signedAt + 10_000,
    signedAt,
  ]);
  expect(s.limit).toHaveBeenCalledExactlyOnceWith({ key: `${LOCAL_AI_VENUE}:${owner}:questions` });
  expect(s.provider).not.toHaveBeenCalled();
});

it('reads the signed restaurant counts for both Overview periods and pins the older cutoff', async () => {
  const s = setup('production', 'today');
  const signedAt = Date.parse('2026-11-25T12:00:59.000Z');
  const nextCutoff = Date.parse('2026-11-25T12:00:00.000Z');
  s.advance(signedAt - start);
  s.reportState.openings = (cutoff) => ({
    current: cutoff.getTime() < nextCutoff ? 11 : 13,
    baseline: 10,
  });
  s.reportState.menuSessions = (cutoff) => ({
    value: cutoff.getTime() < nextCutoff ? 14 : 17,
    status: 'NORMAL',
  });
  delete s.env.OWNER_AI_OPENAI_API_KEY;
  delete s.env.OWNER_AI_OPENAI_PROJECT_ID;
  const first = await s.get();
  expect(first.status).toBe(200);
  const oldRef = first.headers.get(OWNER_REPORT_REFERENCE_HEADER) ?? undefined;
  expect(oldRef).toBeTruthy();
  const firstReport = OwnerDishReportSchema.parse(await first.json());
  const request = (token: string | undefined, question: string) => s.ask(token, { question });
  const firstWindow = { start: '2026-11-25T08:00:00.000Z', end: '2026-11-25T11:55:00.000Z' };
  const previousWindow = { start: '2026-11-24T08:00:00.000Z', end: firstWindow.start };
  const read = async (ref: string | undefined, question: string) => {
    const response = await request(ref, question);
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(firstReport.report_metadata.date_window.start_time).toBe('2026-11-25T08:35:00.000Z');
  expect(await read(oldRef, 'How many openings?')).toMatchObject({
    status: 'answered',
    metric: 'dish_opens',
    overview: { period: 'current' },
    timeWindow: firstWindow,
    reportSnapshot: ownerReportSnapshot(firstReport),
    points: [{ label: 'Current period', value: 11 }],
  });
  expect(await read(oldRef, restaurantVisitsQuestion)).toMatchObject({
    status: 'answered',
    metric: 'menu_sessions',
    overview: { period: 'current' },
    timeWindow: firstWindow,
    reportSnapshot: ownerReportSnapshot(firstReport),
    points: [{ label: 'Current period', value: 14 }],
  });
  expect(await read(oldRef, 'How many visits did Garden Salad have?')).toMatchObject({
    status: 'answered',
    metric: 'active_sessions',
    points: [{ label: 'Garden Salad', value: 20 }],
  });
  expect(await read(oldRef, 'How many openings were there in the previous period?')).toMatchObject({
    status: 'answered',
    metric: 'dish_opens',
    overview: { period: 'baseline' },
    timeWindow: previousWindow,
    points: [{ label: 'Previous period', value: 10 }],
  });
  expect(
    await read(
      oldRef,
      'Compare the dish openings for the current and previous periods as a bar chart.',
    ),
  ).toMatchObject({
    status: 'answered',
    metric: 'dish_opens',
    chart: true,
    overview: { period: 'compare', baselineWindow: previousWindow },
    timeWindow: firstWindow,
    points: [
      { label: 'Current period', value: 11 },
      { label: 'Previous period', value: 10 },
    ],
  });

  s.advance(10_000);
  const newRef = await s.reference();
  expect(newRef).not.toBe(oldRef);
  expect(await read(oldRef, 'How many openings?')).toMatchObject({
    timeWindow: firstWindow,
    reportSnapshot: ownerReportSnapshot(firstReport),
    points: [{ value: 11 }],
  });
  expect(await read(newRef, 'How many openings?')).toMatchObject({
    timeWindow: { start: firstWindow.start, end: new Date(nextCutoff).toISOString() },
    points: [{ value: 13 }],
  });
  expect(await read(oldRef, restaurantVisitsQuestion)).toMatchObject({
    timeWindow: firstWindow,
    points: [{ value: 14 }],
  });
  expect(await read(newRef, 'How many menu sessions did we have?')).toMatchObject({
    metric: 'menu_sessions',
    timeWindow: { start: firstWindow.start, end: new Date(nextCutoff).toISOString() },
    points: [{ value: 17 }],
  });
  s.reportState.openings = () => ({ current: 14, baseline: 10 });
  expect((await request(oldRef, 'How many openings?')).status).toBe(409);
  expect(s.provider).not.toHaveBeenCalled();
});

it('preserves a measured restaurant zero and abstains on missing or untrusted totals', async () => {
  const s = setup('production', 'today');
  s.advance(Date.parse('2026-11-25T12:01:09.000Z') - start);
  s.reportState.overviewOnly = true;
  s.reportState.openings = () => ({ current: 0, baseline: null });
  const zeroRef = await s.reference();
  const ask = async (question: string, reference = zeroRef) => {
    const response = await s.ask(reference, { question });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await ask('How many openings?')).toMatchObject({
    status: 'answered',
    metric: 'dish_opens',
    points: [{ value: 0 }],
  });
  const missing = await ask('Compare current and previous openings.');
  expect(missing).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
  expect(missing).not.toHaveProperty('points');
  s.reportState.openings = () => ({ current: null, baseline: 10 });
  const unknownCount = await ask('How many openings?', await s.reference());
  expect(unknownCount).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
  expect(unknownCount).not.toHaveProperty('points');
  s.reportState.openings = () => ({ current: 11, baseline: 10 });
  s.reportState.fresh = false;
  const untrusted = await ask('How many openings?', await s.reference());
  expect(untrusted).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
  expect(untrusted).not.toHaveProperty('points');
  expect(s.provider).not.toHaveBeenCalled();
});

it('preserves a measured restaurant visit zero and refuses unusable visit evidence', async () => {
  const s = setup('production', 'today');
  s.advance(Date.parse('2026-11-25T12:01:09.000Z') - start);
  s.reportState.overviewOnly = true;
  s.reportState.openings = () => ({ current: 11, baseline: 10 });
  s.reportState.menuSessions = () => ({ value: 0, status: 'VALID_ZERO' });
  const ask = async (question = restaurantVisitsQuestion) => {
    const response = await s.ask(await s.reference(), { question });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await ask()).toMatchObject({
    status: 'answered',
    metric: 'menu_sessions',
    points: [{ value: 0 }],
  });
  for (const status of ['MISSING', 'SUPPRESSED'] as const) {
    s.reportState.menuSessions = () => ({ value: null, status });
    const refusal = await ask();
    expect(refusal).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
    expect(refusal).not.toHaveProperty('points');
  }
  s.reportState.menuSessions = () => ({ value: 14, status: 'NORMAL' });
  expect(await ask('How many restaurant visits were there last Christmas?')).toMatchObject({
    status: 'abstained',
  });
  s.reportState.fresh = false;
  const refusal = await ask();
  expect(refusal).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
  expect(refusal).not.toHaveProperty('points');
  expect(s.provider).not.toHaveBeenCalled();
});

it('refuses unknown freshness and enforces original report scope without any provider calls', async () => {
  const s = setup('production', 'today');
  s.advance(Date.parse('2026-11-25T12:01:09.000Z') - start);
  s.reportState.fresh = false;
  const ref = await s.reference();
  const question = { question: 'What was the open rate for Garden Salad?' };
  expect((await s.ask(ref, { ...question, venueId: LOCAL_AI_VENUE })).status).toBe(400);
  expect((await s.ask(ref, question, 'other-owner')).status).toBe(409);
  expect(
    (await s.ask(ref, question, owner, productionOrigin, '00000000-0000-4000-8000-000000000321'))
      .status,
  ).toBe(409);
  expect((await s.ask(undefined, question)).status).toBe(409);
  expect((await s.ask(ref, question, owner, origin)).status).toBe(403);
  expect(s.readOwnerReport).toHaveBeenCalledOnce();

  const response = await s.ask(ref, question);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });

  s.reportState.allowed = false;
  expect((await s.ask(ref, question)).status).toBe(403);
  s.reportState.allowed = true;
  s.reportState.rate = 0.714;
  expect((await s.ask(ref, question)).status).toBe(409);
  s.advance(60_000);
  expect((await s.ask(ref, question)).status).toBe(409);
  expect(s.provider).not.toHaveBeenCalled();
});

it('enforces the answer budget without consuming a provider request', async () => {
  const s = setup('production', 'today');
  s.advance(Date.parse('2026-11-25T12:01:09.000Z') - start);
  const ref = await s.reference();
  s.limit.mockResolvedValueOnce({ success: false });
  const response = await s.ask(ref, { question: 'What was the open rate for Garden Salad?' });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: 'rate_limited' });
  expect(s.readOwnerReport).toHaveBeenCalledOnce();
  expect(s.provider).not.toHaveBeenCalled();
});

it('only answers display action counts when the original report exposed them and the server still allows them', async () => {
  const s = setup('production', 'today');
  s.advance(Date.parse('2026-11-25T12:01:09.000Z') - start);
  s.reportState.actions = true;
  s.env.OWNER_REPORT_DISPLAY_ACTIONS_ENABLED = 'true';
  const ask = { question: 'Plot comparison starts by dish.' };
  const hidden = await s.get();
  expect(hidden.status).toBe(200);
  expect(
    OwnerDishReportSchema.parse(await hidden.json()).dishes[0]?.display_actions,
  ).toBeUndefined();
  const hiddenRef = hidden.headers.get(OWNER_REPORT_REFERENCE_HEADER) ?? undefined;
  expect(hiddenRef).toBeTruthy();
  const hiddenAnswer = await s.ask(hiddenRef, ask);
  expect(hiddenAnswer.status).toBe(200);
  expect(await hiddenAnswer.json()).toMatchObject({
    status: 'abstained',
    reason: 'unusable_evidence',
  });

  const visible = await s.get(true);
  expect(visible.status).toBe(200);
  expect(
    OwnerDishReportSchema.parse(await visible.json()).dishes[0]?.display_actions
      ?.comparisons_started?.value,
  ).toBe(16);
  const visibleRef = visible.headers.get(OWNER_REPORT_REFERENCE_HEADER) ?? undefined;
  expect(visibleRef).toBeTruthy();
  const withOptIn = await s.ask(visibleRef, ask);
  expect(withOptIn.status).toBe(200);
  expect(await withOptIn.json()).toMatchObject({
    status: 'answered',
    metric: 'comparisons_started',
    chart: true,
    points: [
      { label: 'Garden Salad', value: 16 },
      { label: 'Synthetic development dish', value: 16 },
    ],
  });

  s.env.OWNER_REPORT_DISPLAY_ACTIONS_ENABLED = 'false';
  const featureDisabled = await s.ask(visibleRef, ask);
  expect(featureDisabled.status).toBe(200);
  expect(await featureDisabled.json()).toMatchObject({
    status: 'abstained',
    reason: 'unusable_evidence',
  });
  expect(s.provider).not.toHaveBeenCalled();
});

it('submits a sealed production batch across the next batch boundary without using unknown evidence', async () => {
  const s = setup('production', true);
  s.advance(59_000);
  s.reportState.fresh = false;
  const report = await s.get();
  expect(report.status).toBe(200);
  const { report_metadata: metadata } = OwnerDishReportSchema.parse(await report.json());
  const token = report.headers.get(OWNER_REPORT_REFERENCE_HEADER);
  expect(token).toBeTruthy();
  s.advance(10_000);

  const response = await s.analyze(token ?? undefined);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    source: 'production',
    status: 'abstained',
    reason: 'unusable_evidence',
    timeWindow: { start: metadata.date_window.start_time, end: metadata.date_window.end_time },
  });
  expect(s.readOwnerReport.mock.calls.map((call) => call[2].getTime())).toEqual([
    start + 59_000,
    start + 59_000,
  ]);
  expect(s.limit).not.toHaveBeenCalled();
  expect(s.provider).not.toHaveBeenCalled();
});

it('analyzes the same production report and sends only screened aggregate rates', async () => {
  const s = setup('production');
  const preflight = await s.preflight();
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(productionOrigin);
  const report = await s.get();
  expect(report.status).toBe(200);
  expect(report.headers.get('Access-Control-Allow-Origin')).toBe(productionOrigin);
  expect(report.headers.get('Access-Control-Expose-Headers')).toContain(
    OWNER_REPORT_REFERENCE_HEADER,
  );
  const { report_metadata: metadata } = OwnerDishReportSchema.parse(await report.json());
  const token = report.headers.get(OWNER_REPORT_REFERENCE_HEADER);
  expect(token).toBeTruthy();
  s.advance(15_000);
  const response = await s.analyze(token ?? undefined);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    source: 'production',
    status: 'review',
    value: 0.5,
    timeWindow: { start: metadata.date_window.start_time, end: metadata.date_window.end_time },
  });
  expect(s.readOwnerReport.mock.calls).toEqual([
    [owner, LOCAL_AI_VENUE, new Date(start), s.env, 'production'],
    [owner, LOCAL_AI_VENUE, new Date(start), s.env, 'production'],
  ]);
  expect(s.limit).toHaveBeenCalledExactlyOnceWith({ key: `${LOCAL_AI_VENUE}:${owner}` });
  const [, init] = (s.provider.mock.calls as unknown as [string, RequestInit][])[0]!;
  const body = JSON.parse(String(init.body));
  expect(JSON.parse(body.input)).toEqual({
    goal: 'menu',
    metrics: { open_rate: 0.5, engagement_rate: 0.3, save_rate: 0 },
  });
  expect(init.body).not.toContain(LOCAL_AI_VENUE);
  expect(init.body).not.toContain(LOCAL_AI_DISH);
});

it('rejects a synthetic reference and staging origin in production before a report read', async () => {
  const s = setup('production');
  const syntheticReference = await mintOwnerReportReference(
    OwnerDishReportSchema.parse(localOwnerAiReport(new Date(start))),
    { actorId: owner, venueId: LOCAL_AI_VENUE },
    secret,
    new Date(start),
  );
  expect((await s.analyze(syntheticReference)).status).toBe(409);
  expect((await s.analyze(syntheticReference, owner, origin)).status).toBe(403);
  expect(s.readOwnerReport).not.toHaveBeenCalled();
  expect(s.limit).not.toHaveBeenCalled();
  expect(s.provider).not.toHaveBeenCalled();
});

it('uses the authorized GET window 25 seconds later even if dish rows return in another order', async () => {
  const s = setup();
  const preflight = await s.preflight();
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
    OWNER_REPORT_REFERENCE_HEADER.toLowerCase(),
  );
  const report = await s.get();
  expect(report.status).toBe(200);
  expect(report.headers.get('Access-Control-Expose-Headers')?.toLowerCase()).toContain(
    OWNER_REPORT_REFERENCE_HEADER.toLowerCase(),
  );
  expect(report.headers.get('Cache-Control')).toBe('no-store');
  const snapshot = OwnerDishReportSchema.parse(await report.json());
  const token = report.headers.get(OWNER_REPORT_REFERENCE_HEADER);
  expect(token).toBeTruthy();
  s.advance(25_000);
  s.reportState.reversed = true;

  const response = await s.analyze(token ?? undefined);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'review',
    dishId: LOCAL_AI_DISH,
    timeWindow: {
      start: snapshot.report_metadata.date_window.start_time,
      end: snapshot.report_metadata.date_window.end_time,
    },
  });
  expect(s.readOwnerReport.mock.calls.map((call) => call[2].getTime())).toEqual([start, start]);
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('keeps owner reports available if the dedicated signing key is missing', async () => {
  const s = setup();
  delete s.env.OWNER_AI_REPORT_REFERENCE_SECRET;
  const response = await s.get();
  expect(response.status).toBe(200);
  expect(response.headers.get(OWNER_REPORT_REFERENCE_HEADER)).toBeNull();
  expect((await s.analyze()).status).toBe(503);
  expect(s.provider).not.toHaveBeenCalled();
});

it('rejects missing, modified, expired or incorrectly scoped references before the report read', async () => {
  const s = setup();
  const reference = await s.reference();
  const report = OwnerDishReportSchema.parse(localOwnerAiReport(new Date(start)));
  const otherVenue = '00000000-0000-4000-8000-000000000321';
  const wrongVenue = await mintOwnerReportReference(
    { ...report, venue_id: otherVenue },
    { actorId: owner, venueId: otherVenue },
    secret,
    new Date(start),
  );
  expect((await s.analyze()).status).toBe(409);
  expect((await s.analyze(`invalid-${reference}`)).status).toBe(409);
  expect((await s.analyze(reference, 'other-owner')).status).toBe(409);
  expect((await s.analyze(wrongVenue)).status).toBe(409);
  s.advance(60_000);
  expect((await s.analyze(reference)).status).toBe(409);
  expect(s.readOwnerReport).toHaveBeenCalledTimes(1);
  expect(s.provider).not.toHaveBeenCalled();
});

it.each(['synthetic', 'production'] as const)(
  'checks current membership again for the pinned %s read',
  async (source) => {
    const s = setup(source);
    const reference = await s.reference();
    s.reportState.allowed = false;
    expect((await s.analyze(reference)).status).toBe(403);
    expect(s.readOwnerReport).toHaveBeenCalledTimes(2);
    expect(s.limit).not.toHaveBeenCalled();
    expect(s.provider).not.toHaveBeenCalled();
  },
);

it.each(['synthetic', 'production'] as const)(
  'refuses analysis if a new observation changes the report within the pinned %s window',
  async (source) => {
    const s = setup(source);
    const reference = await s.reference();
    s.reportState.rate = 0.75;
    const response = await s.analyze(reference);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'report_reference_unavailable' });
    expect(s.limit).not.toHaveBeenCalled();
    expect(s.provider).not.toHaveBeenCalled();
  },
);

it.each(['synthetic', 'production'] as const)(
  'abstains on the pinned %s window if freshness is still unknown',
  async (source) => {
    const s = setup(source);
    s.reportState.fresh = false;
    const reference = await s.reference();
    s.advance(25_000);
    const response = await s.analyze(reference);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'abstained',
      reason: 'unusable_evidence',
    });
    expect(s.provider).not.toHaveBeenCalled();
  },
);
