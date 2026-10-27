import {
  type ApproveDishDraftRequest,
  ApproveDishDraftRequestSchema,
  type BoundedRetrievalResult,
  CreateDishRevisionSchema,
  type DishRevision,
  DishRevisionScopeSchema,
  DraftScopeSchema,
  type HealthResponse,
  JobScopeSchema,
  type SubmitMenuIngestionRequest,
  SubmitMenuIngestionRequestSchema,
  TeamAnalyticsQuerySchema,
  TeamAnalyticsResponseSchema,
  VenueScopeSchema,
} from '@peekaplate/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Client } from 'pg';
import { AuthenticationError, AuthUnavailableError, createStaffVerifier } from './auth';
import { CommandError, createDishRevision } from './dish-command';
import {
  type PythonExtractor,
  processIngestionQueueBatch,
  type QueueMessage,
  type ReportStorage,
  submitMenuIngestion,
} from './ingestion/orchestrator';
import {
  approveDishDraft,
  type DishDraftRow,
  getIngestionJob,
  IngestionError,
  listDishDrafts,
  type MenuIngestionJobRow,
} from './ingestion/repository';
import { createHttpPythonExtractor } from './ingestion/transport';
import { retrieveMenuEvidence } from './retrieval';
import { readTeamAnalytics } from './team-analytics';
import { verifyTeamCollaborator } from './team-auth';

export type Bindings = {
  APP_ENV?: string;
  AUTH_ISSUER?: string;
  LOCAL_DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  POSTHOG_PROJECT_ID?: string;
  TEAM_GITHUB_TOKEN?: string;
  LOCAL_GITHUB_API_URL?: string;
  INGESTION_QUEUE?: { send(message: unknown): Promise<void> };
  INGESTION_REPORTS_BUCKET?: {
    put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>;
    get?(key: string): Promise<unknown>;
  };
  EXTRACTION_SERVICE_URL?: string;
  EXTRACTION_SERVICE_SECRET?: string;
  EXTRACTION_TIMEOUT_MS?: string;
};

type Dependencies = {
  verify: (authorization: string, env: Bindings) => Promise<string>;
  execute: (
    actorId: string,
    venueId: string,
    input: Parameters<typeof createDishRevision>[3],
    env: Bindings,
  ) => ReturnType<typeof createDishRevision>;
  authorizeVenue?: (actorId: string, venueId: string, env: Bindings) => Promise<void>;
  retrieve?: (request: unknown) => Promise<BoundedRetrievalResult>;
  readAnalytics?: (
    projectId: number,
    kind: 'events' | 'summary',
    query: Parameters<typeof readTeamAnalytics>[3],
    env: Bindings,
  ) => ReturnType<typeof readTeamAnalytics>;
  verifyTeam?: (authorization: string, env: Bindings) => Promise<void>;
  submitIngestion?: (
    actorId: string,
    venueId: string,
    request: SubmitMenuIngestionRequest,
    env: Bindings,
  ) => Promise<MenuIngestionJobRow>;
  getIngestionJob?: (
    actorId: string,
    venueId: string,
    jobId: string,
    env: Bindings,
  ) => Promise<MenuIngestionJobRow | null>;
  listDrafts?: (
    actorId: string,
    venueId: string,
    filter: {
      status?: 'pending' | 'accepted' | 'rejected' | 'edited' | 'superseded';
      jobId?: string;
    },
    env: Bindings,
  ) => Promise<DishDraftRow[]>;
  approveDraft?: (
    actorId: string,
    venueId: string,
    draftId: string,
    options: ApproveDishDraftRequest,
    env: Bindings,
  ) => Promise<{ draft: DishDraftRow; publishedRevision: DishRevision }>;
  extractor?: PythonExtractor;
  reportStorage?: ReportStorage;
  processQueueBatch?: typeof processIngestionQueueBatch;
};

export async function authorizeStaffVenue(
  client: Client,
  actorId: string,
  venueId: string,
): Promise<void> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );

    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? '')) {
      throw new CommandError('forbidden', 403);
    }

    await client.query('COMMIT');
    started = false;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback failure preserved
      }
    }
    throw error;
  }
}

let verifier: { issuer: string; local: boolean; verify: ReturnType<typeof createStaffVerifier> };
const dependencies: Dependencies = {
  async verify(authorization, env) {
    if (!env.AUTH_ISSUER) throw new AuthUnavailableError();
    const local = env.APP_ENV === 'local';
    if (!verifier || verifier.issuer !== env.AUTH_ISSUER || verifier.local !== local) {
      verifier = {
        issuer: env.AUTH_ISSUER,
        local,
        verify: createStaffVerifier({ issuer: env.AUTH_ISSUER, allowLocalIssuer: local }),
      };
    }
    return verifier.verify(authorization);
  },
  async execute(actorId, venueId, input, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await createDishRevision(client, actorId, venueId, input);
    } finally {
      await client.end();
    }
  },
  async authorizeVenue(actorId, venueId, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      await authorizeStaffVenue(client, actorId, venueId);
    } finally {
      await client.end();
    }
  },
  async retrieve(request) {
    return retrieveMenuEvidence(request);
  },
  verifyTeam: verifyTeamCollaborator,
  async readAnalytics(projectId, kind, query, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await readTeamAnalytics(client, projectId, kind, query);
    } finally {
      await client.end();
    }
  },
};

export function createApp(services: Dependencies = dependencies) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Request-ID', crypto.randomUUID());
    await next();
  });
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'peekaplate-api',
      stage: 'foundation',
    } satisfies HealthResponse),
  );
  app.use(
    '/venues/*',
    bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'body_too_large' }, 413) }),
  );
  app.get('/team/analytics/:kind', async (c) => {
    const env = c.env ?? {};
    if (!['local', 'staging'].includes(env.APP_ENV ?? ''))
      return c.json({ error: 'not_found' }, 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    if (!services.verifyTeam) throw new AuthUnavailableError();
    await services.verifyTeam(authorization, env);
    const kind = c.req.param('kind');
    if (kind !== 'events' && kind !== 'summary') return c.json({ error: 'not_found' }, 404);
    const params = new URL(c.req.url).searchParams;
    const parsed = TeamAnalyticsQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const projectId = Number(env.POSTHOG_PROJECT_ID);
    if (
      !/^[1-9][0-9]*$/.test(env.POSTHOG_PROJECT_ID ?? '') ||
      !Number.isSafeInteger(projectId) ||
      projectId > 2147483647 ||
      !services.readAnalytics
    ) {
      throw new AuthUnavailableError();
    }
    const result = await services.readAnalytics(projectId, kind, parsed.data, env);
    return c.json(TeamAnalyticsResponseSchema.parse(result));
  });
  app.post('/venues/:venueId/dishes/:dishId/revisions', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = DishRevisionScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = CreateDishRevisionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const result = await services.execute(
      actorId,
      scope.data.venueId,
      {
        ...parsed.data,
        dishId: scope.data.dishId,
      },
      c.env ?? {},
    );
    return c.json(result);
  });
  app.post('/venues/:venueId/menu-evidence', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    if (services.authorizeVenue) {
      await services.authorizeVenue(actorId, scope.data.venueId, c.env ?? {});
    }

    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (body && typeof body === 'object' && 'venue_id' in body && body.venue_id !== undefined) {
      if (body.venue_id !== scope.data.venueId) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    const retrievalRequest =
      body && typeof body === 'object' ? { ...body, venue_id: scope.data.venueId } : body;

    const retrieverFn = services.retrieve ?? retrieveMenuEvidence;
    const result = await retrieverFn(retrievalRequest);
    return c.json(result);
  });
  app.post('/venues/:venueId/menus/jobs', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = SubmitMenuIngestionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const submitFn =
      services.submitIngestion ??
      (async (actorId, venueId, req, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          await authorizeStaffVenue(client, actorId, venueId);
          const queueProducer = env.INGESTION_QUEUE
            ? { send: (msg: unknown) => env.INGESTION_QUEUE!.send(msg) }
            : undefined;
          return await submitMenuIngestion(client, { venueId, ...req }, queueProducer);
        } finally {
          await client.end();
        }
      });

    const job = await submitFn(actorId, scope.data.venueId, parsed.data, c.env ?? {});
    return c.json({ job }, 202);
  });
  app.get('/venues/:venueId/menus/jobs/:jobId', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = JobScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    const getJobFn =
      services.getIngestionJob ??
      (async (actorId, venueId, jobId, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          await authorizeStaffVenue(client, actorId, venueId);
          return await getIngestionJob(client, venueId, jobId);
        } finally {
          await client.end();
        }
      });

    const job = await getJobFn(actorId, scope.data.venueId, scope.data.jobId, c.env ?? {});
    if (!job) return c.json({ error: 'not_found' }, 404);
    return c.json({ job });
  });
  app.get('/venues/:venueId/drafts', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    const params = new URL(c.req.url).searchParams;
    const statusParam = (params.get('status') ?? undefined) as any;
    const jobIdParam = params.get('jobId') ?? undefined;

    const listFn =
      services.listDrafts ??
      (async (actorId, venueId, filter, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          await authorizeStaffVenue(client, actorId, venueId);
          return await listDishDrafts(client, {
            tenantId: venueId,
            ...(filter.status !== undefined ? { reviewStatus: filter.status } : {}),
            ...(filter.jobId !== undefined ? { jobId: filter.jobId } : {}),
          });
        } finally {
          await client.end();
        }
      });

    const drafts = await listFn(
      actorId,
      scope.data.venueId,
      {
        ...(statusParam !== undefined ? { status: statusParam } : {}),
        ...(jobIdParam !== undefined ? { jobId: jobIdParam } : {}),
      },
      c.env ?? {},
    );
    return c.json({ drafts });
  });
  app.post('/venues/:venueId/drafts/:draftId/approve', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = DraftScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is acceptable for defaults
    }
    const parsed = ApproveDishDraftRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const approveFn =
      services.approveDraft ??
      (async (actorId, venueId, draftId, options, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          await authorizeStaffVenue(client, actorId, venueId);

          const draftRes = await client.query<{ name: string; description: string | null }>(
            `SELECT name, description FROM app_private.dish_drafts
             WHERE tenant_id = $1 AND id = $2 AND review_status = 'pending'
             FOR UPDATE;`,
            [venueId, draftId],
          );
          const draft = draftRes.rows[0];
          if (!draft) throw new IngestionError('draft_not_pending_or_not_found', 404);

          const newDishId = crypto.randomUUID();
          const revision = await createDishRevision(client, actorId, venueId, {
            commandId: options.commandId ?? crypto.randomUUID(),
            dishId: newDishId,
            expectedVersion: options.expectedVersion ?? 0,
            name: draft.name,
            description: draft.description ?? draft.name,
          });

          const updatedDraft = await approveDishDraft(client, {
            actorId,
            tenantId: venueId,
            draftId,
            publishedDishId: revision.dishId,
          });

          return { draft: updatedDraft, publishedRevision: revision };
        } finally {
          await client.end();
        }
      });

    const result = await approveFn(
      actorId,
      scope.data.venueId,
      scope.data.draftId,
      parsed.data,
      c.env ?? {},
    );
    return c.json(result);
  });
  app.onError((error, c) => {
    if (error instanceof AuthenticationError) return c.json({ error: 'unauthorized' }, 401);
    if (error instanceof AuthUnavailableError) return c.json({ error: 'service_unavailable' }, 503);
    if (error instanceof CommandError) return c.json({ error: error.code }, error.status);
    if (error instanceof IngestionError) return c.json({ error: error.code }, error.status as any);
    // Never log bearer tokens, request bodies or database errors containing row data.
    console.error(
      JSON.stringify({ event: 'command_failed', requestId: c.res.headers.get('X-Request-ID') }),
    );
    return c.json({ error: 'service_unavailable' }, 503);
  });
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

/**
 * Handles incoming Cloudflare Queue message batches for menu ingestion.
 */
export async function handleQueueBatch(
  batch: { messages: readonly QueueMessage<unknown>[] },
  env: Bindings,
  services: Dependencies = dependencies,
): Promise<void> {
  const connectionString =
    env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    for (const msg of batch.messages) msg.retry();
    return;
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const extractionTimeoutMs =
      env.EXTRACTION_TIMEOUT_MS && /^\d+$/.test(env.EXTRACTION_TIMEOUT_MS)
        ? Number.parseInt(env.EXTRACTION_TIMEOUT_MS, 10)
        : undefined;

    const extractor =
      services.extractor ??
      (env.EXTRACTION_SERVICE_URL
        ? createHttpPythonExtractor({
            serviceUrl: env.EXTRACTION_SERVICE_URL,
            ...(env.EXTRACTION_SERVICE_SECRET !== undefined
              ? { authToken: env.EXTRACTION_SERVICE_SECRET }
              : {}),
            ...(extractionTimeoutMs !== undefined ? { timeoutMs: extractionTimeoutMs } : {}),
          })
        : async () => {
            throw new IngestionError(
              'extractor_unavailable',
              503,
              'Python extraction boundary not configured in current environment',
            );
          });

    const reportStorage: ReportStorage | undefined =
      services.reportStorage ??
      (env.INGESTION_REPORTS_BUCKET
        ? {
            async put(key: string, data: string): Promise<void> {
              await env.INGESTION_REPORTS_BUCKET!.put(key, data);
            },
            async get(key: string): Promise<string | null> {
              if (!env.INGESTION_REPORTS_BUCKET?.get) return null;
              const res = await env.INGESTION_REPORTS_BUCKET.get(key);
              if (!res) return null;
              return typeof res === 'string'
                ? res
                : (res as any).text
                  ? await (res as any).text()
                  : String(res);
            },
          }
        : undefined);

    const processBatchFn = services.processQueueBatch ?? processIngestionQueueBatch;
    await processBatchFn(client, batch, extractor, {
      ...(reportStorage !== undefined ? { reportStorage } : {}),
      leaseTimeoutMinutes: 15,
    });
  } catch {
    for (const msg of batch.messages) {
      try {
        msg.retry();
      } catch {}
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const defaultApp = createApp();
(defaultApp as any).queue = async (batch: any, env: Bindings) => {
  await handleQueueBatch(batch, env);
};

export default defaultApp;
