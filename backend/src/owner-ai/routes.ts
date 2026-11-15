import { z } from 'zod';

const VenueScopeSchema = z.strictObject({ venueId: z.uuid().transform((id) => id.toLowerCase()) });

import { OwnerAnalysisRequestSchema } from '@peekaplate/contracts/owner-analysis';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Bindings } from '../index';
import { analyzeOwnerReport, OwnerAnalysisUnavailable } from './responses';

export function registerOwnerAnalysisRoutes(
  app: Hono<{ Bindings: Bindings }>,
  options: {
    verify: (authorization: string, env: Bindings) => Promise<string>;
    readReport?: (
      actor: string,
      venue: string,
      now: Date,
      env: Bindings,
      source: 'synthetic',
    ) => Promise<unknown>;
    allowedOrigins: readonly string[];
    syntheticVenues: readonly string[];
    now?: () => Date;
    fetchImpl?: typeof fetch;
  },
) {
  const route = '/api/v1/venues/:venueId/ai/analysis';
  let localRequests = 0;
  app.use(
    route,
    cors({
      origin: [...options.allowedOrigins],
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(
    route,
    bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) }),
  );
  app.post(route, async (c) => {
    const env = c.env ?? {};
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actor = await options.verify(authorization, env);
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const origin = c.req.header('Origin');
    if (origin && !options.allowedOrigins.includes(origin))
      return c.json({ error: 'forbidden' }, 403);
    if (
      env.OWNER_AI_RESPONSES_ENABLED !== 'true' ||
      !['local', 'staging'].includes(env.APP_ENV ?? '') ||
      !options.syntheticVenues.includes(scope.data.venueId) ||
      scope.data.venueId !== env.SYNTHETIC_REPORT_VENUE_ID ||
      !env.OWNER_AI_OPENAI_API_KEY ||
      !env.OWNER_AI_OPENAI_PROJECT_ID ||
      !options.readReport ||
      (env.APP_ENV === 'staging' && !env.OWNER_AI_RATE_LIMITER)
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const input = OwnerAnalysisRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success || new URL(c.req.url).search)
      return c.json({ error: 'invalid_request' }, 400);
    const now = options.now?.() ?? new Date();
    // The existing reader checks current owner membership in a tenant-scoped read-only transaction.
    // No browser report, metrics, prompt, model, policy or credential is accepted.
    const report = await options.readReport(actor, scope.data.venueId, now, env, 'synthetic');
    try {
      const result = await analyzeOwnerReport({
        report,
        venueId: scope.data.venueId,
        request: input.data,
        now,
        apiKey: env.OWNER_AI_OPENAI_API_KEY,
        projectId: env.OWNER_AI_OPENAI_PROJECT_ID,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        reserveRequest: async () => {
          if (env.APP_ENV === 'local') return ++localRequests <= 10;
          return (await env.OWNER_AI_RATE_LIMITER!.limit({ key: `${scope.data.venueId}:${actor}` }))
            .success;
        },
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof OwnerAnalysisUnavailable || error instanceof Error) {
        return c.json({ error: 'service_unavailable' }, 503);
      }
      throw error;
    }
  });
}
