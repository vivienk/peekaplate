import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { CommandError } from '../dish-command';
import { type Bindings, createApp } from '../index';
import { mintOwnerReportReference, OWNER_REPORT_REFERENCE_HEADER } from './report-reference';

const venuePath = `/api/v1/venues/${LOCAL_AI_VENUE}`;
const origin = 'http://127.0.0.1:5174';
const productionOrigin = 'https://peekaplate.app';
const owner = 'report-fixture-owner';
const secret = 'fixture-report-reference-signing-key-for-tests-only';
const start = Date.parse('2026-11-16T12:00:00.219Z');

afterEach(() => vi.unstubAllGlobals());

function setup(source: 'synthetic' | 'production' = 'synthetic', sealedBatch = false) {
  let now = start;
  const reportOrigin = source === 'production' ? productionOrigin : origin;
  const reportState = { allowed: true, fresh: true, rate: 0.5, reversed: false };
  const readOwnerReport = vi.fn(async (actorId: string, venueId: string, anchor: Date) => {
    if (!reportState.allowed || actorId !== owner || venueId !== LOCAL_AI_VENUE) {
      throw new CommandError('forbidden', 403);
    }
    const report = OwnerDishReportSchema.parse({ ...localOwnerAiReport(anchor), source });
    if (sealedBatch) {
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
    report.dishes.push({ ...dish, dish_id: '00000000-0000-4000-8000-000000000789' });
    report.report_metadata.coverage = { total_dishes_monitored: 2, measurable_dishes_count: 2 };
    if (reportState.reversed) report.dishes.reverse();
    if (!reportState.fresh) report.report_metadata.freshness.is_stale = null;
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
  const get = () =>
    worker.request(
      `${venuePath}/analytics/dishes?source=${source}`,
      { headers: { Authorization: `Bearer ${owner}`, Origin: reportOrigin } },
      env,
    );
  async function reference() {
    const response = await get();
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
  async function preflight() {
    return worker.request(
      `${venuePath}/ai/analysis`,
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
