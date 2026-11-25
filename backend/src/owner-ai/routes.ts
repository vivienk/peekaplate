import {
  OwnerAnalysisRequestSchema,
  OwnerReportQuestionRequestSchema,
} from '@peekaplate/contracts/owner-analysis';
import { type OwnerDishReport, OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { CommandError } from '../command-error';
import type { Bindings } from '../index';
import { configuredSyntheticReportVenues } from '../owner-report-scope';
import {
  ownerWorkflowAvailable,
  productionOwnerReportingEnabled,
} from '../owner-workflow-environment';
import { logOwnerAiFailure, OwnerAiProviderFailure } from './provider';
import { answerOwnerReportQuestion } from './questions';
import {
  OWNER_REPORT_REFERENCE_HEADER,
  ownerReportSnapshot,
  readOwnerReportReference,
} from './report-reference';
import { analyzeOwnerReport, OwnerAnalysisUnavailable } from './responses';

const VenueScopeSchema = z.strictObject({ venueId: z.uuid().transform((id) => id.toLowerCase()) });
const analysisPath = '/api/v1/venues/:venueId/ai/analysis';
const questionPath = '/api/v1/venues/:venueId/ai/questions';

export function registerOwnerAnalysisRoutes(
  app: Hono<{ Bindings: Bindings }>,
  options: {
    verify: (authorization: string, env: Bindings) => Promise<string>;
    readReport?: (
      actor: string,
      venue: string,
      now: Date,
      env: Bindings,
      source: OwnerDishReport['source'],
    ) => Promise<unknown>;
    allowedOrigins: readonly string[];
    allowedOrigin?: (origin: string, env: Bindings) => string | undefined;
    syntheticVenues: readonly string[];
    syntheticLoopbackPreview?: true;
    now?: () => Date;
    fetchImpl?: typeof fetch;
  },
) {
  const allowedOrigin =
    options.allowedOrigin ??
    ((origin) => (options.allowedOrigins.includes(origin) ? origin : undefined));
  let localRequests = 0;
  let localQuestions = 0;
  for (const path of [analysisPath, questionPath]) {
    app.use(
      path,
      cors({
        origin: (origin, c) => allowedOrigin(origin, c.env ?? {}),
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', OWNER_REPORT_REFERENCE_HEADER],
        maxAge: 600,
      }),
      bodyLimit({
        maxSize: path === analysisPath ? 1024 : 4096,
        onError: (c) => c.json({ error: 'body_too_large' }, 413),
      }),
    );
  }
  async function handle(c: Context<{ Bindings: Bindings }>, questionRoute: boolean) {
    const env = c.env ?? {};
    if (questionRoute) c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actor = await options.verify(authorization, env);
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const origin = c.req.header('Origin');
    if (origin && !allowedOrigin(origin, env)) return c.json({ error: 'forbidden' }, 403);
    const source = env.APP_ENV === 'production' ? 'production' : 'synthetic';
    const preview =
      !questionRoute && options.syntheticLoopbackPreview === true && env.APP_ENV === 'local';
    const referenceSecret = env.OWNER_AI_REPORT_REFERENCE_SECRET;
    const { OWNER_AI_OPENAI_API_KEY: apiKey, OWNER_AI_OPENAI_PROJECT_ID: projectId } = env;
    if (
      env.OWNER_AI_RESPONSES_ENABLED !== 'true' ||
      !ownerWorkflowAvailable(env) ||
      (source === 'production' && !productionOwnerReportingEnabled(env)) ||
      (source === 'synthetic' &&
        !configuredSyntheticReportVenues(env, options.syntheticVenues).includes(
          scope.data.venueId,
        )) ||
      (!questionRoute && (!apiKey || !projectId)) ||
      (!referenceSecret && !preview) ||
      !options.readReport ||
      (env.APP_ENV !== 'local' && !env.OWNER_AI_RATE_LIMITER)
    ) {
      if (!questionRoute) {
        logOwnerAiFailure(
          'owner_analysis',
          new OwnerAiProviderFailure({ category: 'configuration', httpStatus: null }),
        );
      }
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const decoded = await c.req.json().catch(() => null);
    const input = questionRoute
      ? OwnerReportQuestionRequestSchema.safeParse(decoded)
      : OwnerAnalysisRequestSchema.safeParse(decoded);
    if (!input.success || new URL(c.req.url).search)
      return c.json({ error: 'invalid_request' }, 400);
    const now = options.now?.() ?? new Date();
    const reference = referenceSecret
      ? await readOwnerReportReference(
          c.req.header(OWNER_REPORT_REFERENCE_HEADER),
          { actorId: actor, venueId: scope.data.venueId },
          referenceSecret,
          now,
          source,
        )
      : null;
    if (!reference && (!preview || referenceSecret)) {
      return c.json({ error: 'report_reference_unavailable' }, 409);
    }
    if (questionRoute) {
      const allowed =
        env.APP_ENV === 'local'
          ? ++localQuestions <= 30
          : (
              await env.OWNER_AI_RATE_LIMITER!.limit({
                key: `${scope.data.venueId}:${actor}:questions`,
              })
            ).success;
      if (!allowed) return c.json({ error: 'rate_limited' }, 429);
    }
    // The existing reader checks current owner membership in a tenant-scoped read-only transaction.
    // The question is data for the report interpreter; callers never supply report data or policy.
    const report = OwnerDishReportSchema.safeParse(
      await options
        .readReport(actor, scope.data.venueId, reference?.anchor ?? now, env, source)
        .catch((error: unknown) => {
          if (!questionRoute && !(error instanceof CommandError)) {
            logOwnerAiFailure('owner_analysis', undefined, {
              category: 'internal',
              httpStatus: null,
            });
          }
          throw error;
        }),
    );
    if (
      !report.success ||
      report.data.source !== source ||
      report.data.venue_id !== scope.data.venueId
    ) {
      if (!questionRoute)
        logOwnerAiFailure('owner_analysis', undefined, { category: 'internal', httpStatus: null });
      return c.json({ error: 'service_unavailable' }, 503);
    }
    const snapshot = ownerReportSnapshot(report.data);
    if (reference && snapshot !== reference.snapshot) {
      return c.json({ error: 'report_reference_unavailable' }, 409);
    }
    if ('question' in input.data) {
      const displayActionsAllowed =
        reference?.displayActions === true &&
        (source !== 'production' || env.OWNER_REPORT_DISPLAY_ACTIONS_ENABLED === 'true');
      return c.json(
        answerOwnerReportQuestion(
          report.data,
          input.data.question,
          now,
          snapshot,
          displayActionsAllowed,
        ),
      );
    }
    if (!apiKey || !projectId) return c.json({ error: 'service_unavailable' }, 503);
    try {
      const result = await analyzeOwnerReport({
        report: report.data,
        venueId: scope.data.venueId,
        request: input.data,
        now,
        apiKey,
        projectId,
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
  }
  app.post(analysisPath, (c) => handle(c, false));
  app.post(questionPath, (c) => handle(c, true));
}
