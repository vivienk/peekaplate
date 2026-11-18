import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { AuthUnavailableError } from '../auth';
import { CommandError } from '../command-error';
import type { Bindings } from '../index';
import { mintOwnerReportReference, OWNER_REPORT_REFERENCE_HEADER } from './report-reference';
import { registerOwnerAnalysisRoutes } from './routes';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const now = new Date('2026-11-12T12:00:00Z');
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError((error, c) =>
    error instanceof CommandError
      ? c.json({ error: error.code }, error.status)
      : c.json({ error: 'service_unavailable' }, 503),
  );
  const verify = vi.fn(async () => 'actor');
  const readReport = vi.fn(async (): Promise<unknown> => localOwnerAiReport(now));
  const fetchImpl = vi.fn(async () =>
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
  registerOwnerAnalysisRoutes(app, {
    verify,
    readReport,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => now,
    allowedOrigins: ['http://127.0.0.1:5174'],
    syntheticVenues: [LOCAL_AI_VENUE],
  });
  const secret = 'fixture-secret-for-router-tests-not-used-in-production';
  const env: Bindings = {
    APP_ENV: 'local',
    SYNTHETIC_REPORT_VENUE_ID: LOCAL_AI_VENUE,
    OWNER_AI_RESPONSES_ENABLED: 'true',
    OWNER_AI_OPENAI_API_KEY: 'synthetic',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_synthetic',
    OWNER_AI_REPORT_REFERENCE_SECRET: secret,
  };
  const run = async (
    body: unknown = { dishId: LOCAL_AI_DISH, goal: 'menu' },
    extra: Record<string, string> = {},
  ) =>
    app.request(
      `/api/v1/venues/${LOCAL_AI_VENUE}/ai/analysis`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          [OWNER_REPORT_REFERENCE_HEADER]: await mintOwnerReportReference(
            OwnerDishReportSchema.parse(localOwnerAiReport(now)),
            { actorId: 'actor', venueId: LOCAL_AI_VENUE },
            secret,
            now,
          ),
          ...extra,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { app, env, run, verify, readReport, fetchImpl };
}
it('returns the generic public error while retaining safe provider diagnostics on the server', async () => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(
    Response.json(
      { error: { code: 'model_not_found', message: 'sk-private-provider-message' } },
      { status: 404 },
    ),
  );
  const response = await s.run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
    operation: 'owner_analysis',
    category: 'provider_http',
    httpStatus: 404,
    providerCode: 'model_not_found',
  });
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
});
it('uses the same additive venue configuration as JSON reports', async () => {
  const s = setup();
  delete s.env.SYNTHETIC_REPORT_VENUE_ID;
  s.env.SYNTHETIC_REPORT_VENUE_IDS = LOCAL_AI_VENUE;
  expect((await s.run()).status).toBe(200);
  expect(s.readReport).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'invalid'])(
  'diagnoses an %s internal report reread before any provider request',
  async (failure) => {
    const s = setup();
    if (failure === 'unavailable') s.readReport.mockRejectedValue(new AuthUnavailableError());
    else s.readReport.mockResolvedValue({ privateDatabaseDetails: 'fixture' });
    const response = await s.run();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
      operation: 'owner_analysis',
      category: 'internal',
      httpStatus: null,
      providerCode: null,
    });
  },
);

it('fails closed on an invalid additive venue configuration before reading or calling a provider', async () => {
  const s = setup();
  s.env.SYNTHETIC_REPORT_VENUE_IDS = 'not-a-venue';
  expect((await s.run()).status).toBe(503);
  expect(s.readReport).not.toHaveBeenCalled();
  expect(s.fetchImpl).not.toHaveBeenCalled();
});

it('checks owner membership through the reader before sending a single provider request', async () => {
  const s = setup();
  expect((await s.run()).status).toBe(200);
  expect(s.readReport).toHaveBeenCalledWith(
    'actor',
    LOCAL_AI_VENUE,
    expect.any(Date),
    s.env,
    'synthetic',
  );
  expect(s.readReport.mock.invocationCallOrder[0]).toBeLessThan(
    s.fetchImpl.mock.invocationCallOrder[0]!,
  );
});
it('denies absent authentication and revoked membership without a model call', async () => {
  const s = setup();
  expect((await s.run(undefined, { Authorization: '' })).status).toBe(401);
  s.readReport.mockRejectedValue(new CommandError('forbidden', 403));
  expect((await s.run()).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});
it('accepts a bounded multibyte question only with the authenticated report reference', async () => {
  const s = setup();
  const body = { dishId: LOCAL_AI_DISH, goal: 'menu', question: '菜'.repeat(500) };
  expect((await s.run(body, { [OWNER_REPORT_REFERENCE_HEADER]: 'invalid' })).status).toBe(409);
  expect(s.readReport).not.toHaveBeenCalled();
  expect(s.fetchImpl).not.toHaveBeenCalled();
  s.fetchImpl.mockResolvedValue(
    Response.json({
      status: 'completed',
      model: 'gpt-6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: '{"operation":"highest","metric":"save_rate","limit":1}',
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
    }),
  );
  const response = await s.run(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'answered', reason: 'report_fact' });
});
it.each(['production', '', 'staging'])(
  'fails closed in unconfigured environment %s',
  async (appEnv) => {
    const s = setup();
    s.env.APP_ENV = appEnv;
    expect((await s.run()).status).toBe(503);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  },
);
it('rejects browser-supplied metrics/prompts and off-origin requests', async () => {
  const s = setup();
  expect(
    (await s.run({ dishId: LOCAL_AI_DISH, goal: 'menu', metrics: { open_rate: 1 } })).status,
  ).toBe(400);
  expect((await s.run(undefined, { Origin: 'https://untrusted.example' })).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('caps local provider calls at ten including concurrent requests', async () => {
  const s = setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => s.run()));
  expect(results.filter((r) => r.status === 200)).toHaveLength(10);
  expect(s.fetchImpl).toHaveBeenCalledTimes(10);
});
it('requires and consumes the staging rate limiter', async () => {
  const s = setup();
  s.env.APP_ENV = 'staging';
  s.env.OWNER_AI_RATE_LIMITER = { limit: vi.fn(async () => ({ success: false })) };
  expect((await s.run()).status).toBe(503);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
