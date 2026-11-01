import {
  ApproveMenuRevisionSchema,
  type BoundedRetrievalResult,
  CreateDishRevisionSchema,
  DishRevisionScopeSchema,
  type HealthResponse,
  MenuScopeSchema,
  ObservationBatchV2Schema,
  type ObservationQueueEnvelope,
  ObservationQueueEnvelopeSchema,
  type PublicMenuResponse,
  PublishMenuSchema,
  TeamAnalyticsQuerySchema,
  TeamAnalyticsResponseSchema,
  VenueScopeSchema,
  WithdrawMenuSchema,
} from '@peekaplate/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Client } from 'pg';
import { AuthenticationError, AuthUnavailableError, createStaffVerifier } from './auth';
import { CommandError, createDishRevision } from './dish-command';
import {
  createMenuTokenVerifier,
  type MenuAuthority,
  MenuTokenAuthenticationError,
  MenuTokenAuthorizationError,
  MenuTokenUnavailableError,
} from './menu-token';
import { ingestObservations } from './observation-ingest';
import {
  createPublicMenuResponse,
  menuJwks,
  type PublicMenuRecord,
  readPublicMenu,
} from './public-menu';
import {
  approveMenuRevision,
  PublicationCommandError,
  publishMenu,
  withdrawMenu,
} from './publication-command';
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
  MENU_TOKEN_ISSUER?: string;
  MENU_TOKEN_SIGNING_JWK?: string;
  OBSERVATION_QUEUE?: { send(message: ObservationQueueEnvelope): Promise<void> };
  OBSERVATION_RATE_LIMITER_MINUTE?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  OBSERVATION_RATE_LIMITER_BURST?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
};

type Dependencies = {
  verify: (authorization: string, env: Bindings) => Promise<string>;
  execute: (
    actorId: string,
    venueId: string,
    input: Parameters<typeof createDishRevision>[3],
    env: Bindings,
  ) => ReturnType<typeof createDishRevision>;
  approve?: (
    actorId: string,
    venueId: string,
    input: Parameters<typeof approveMenuRevision>[3],
    env: Bindings,
  ) => ReturnType<typeof approveMenuRevision>;
  publish?: (
    actorId: string,
    venueId: string,
    input: Parameters<typeof publishMenu>[3],
    env: Bindings,
  ) => ReturnType<typeof publishMenu>;
  withdraw?: (
    actorId: string,
    venueId: string,
    input: Parameters<typeof withdrawMenu>[3],
    env: Bindings,
  ) => ReturnType<typeof withdrawMenu>;
  authorizeVenue?: (actorId: string, venueId: string, env: Bindings) => Promise<void>;
  retrieve?: (request: unknown) => Promise<BoundedRetrievalResult>;
  readAnalytics?: (
    projectId: number,
    kind: 'events' | 'summary',
    query: Parameters<typeof readTeamAnalytics>[3],
    env: Bindings,
  ) => ReturnType<typeof readTeamAnalytics>;
  verifyTeam?: (authorization: string, env: Bindings) => Promise<void>;
  verifyMenu?: (authorization: string, env: Bindings) => Promise<MenuAuthority>;
  consumeObservationRateLimit?: (
    jti: string,
    env: Bindings,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  enqueueObservation?: (message: ObservationQueueEnvelope, env: Bindings) => Promise<void>;
  now?: () => Date;
  readPublicMenu?: (
    venueId: string,
    menuId: string,
    env: Bindings,
  ) => Promise<PublicMenuRecord | undefined>;
  issuePublicMenu?: (menu: PublicMenuRecord, env: Bindings) => Promise<PublicMenuResponse>;
  readMenuJwks?: (env: Bindings) => Promise<{ keys: unknown[] }>;
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
let menuVerifier: {
  issuer: string;
  local: boolean;
  verify: ReturnType<typeof createMenuTokenVerifier>;
};
/**
 * Exact diner-origin allowlist aligned with PR #43 and staging/production deployments.
 * Preview and arbitrary origins are rejected; wildcard '*' is not used.
 */
export const DINER_CORS_ALLOWED_ORIGINS = [
  'https://diner.peekaplate.com',
  'https://peekaplate-diner-staging.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

/**
 * Native rate limiting for token-scoped observation ingestion.
 * Note: Cloudflare Worker rate limiting bindings enforce approximate per-location limits
 * across edge locations, not a strict globally synchronized token bucket.
 */
export async function consumeJtiRateLimit(
  jti: string,
  env: Bindings,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!env.OBSERVATION_RATE_LIMITER_MINUTE || !env.OBSERVATION_RATE_LIMITER_BURST) {
    throw new MenuTokenUnavailableError();
  }
  const minute = await env.OBSERVATION_RATE_LIMITER_MINUTE.limit({ key: jti });
  const burst = await env.OBSERVATION_RATE_LIMITER_BURST.limit({ key: jti });
  if (!minute.success) return { allowed: false, retryAfterSeconds: 60 };
  if (!burst.success) return { allowed: false, retryAfterSeconds: 10 };
  return { allowed: true, retryAfterSeconds: 1 };
}

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
  async verifyMenu(authorization, env) {
    if (!env.MENU_TOKEN_ISSUER) throw new MenuTokenUnavailableError();
    const local = env.APP_ENV === 'local';
    if (
      !menuVerifier ||
      menuVerifier.issuer !== env.MENU_TOKEN_ISSUER ||
      menuVerifier.local !== local
    ) {
      menuVerifier = {
        issuer: env.MENU_TOKEN_ISSUER,
        local,
        verify: createMenuTokenVerifier({
          issuer: env.MENU_TOKEN_ISSUER,
          allowLocalIssuer: local,
        }),
      };
    }
    return menuVerifier.verify(authorization);
  },
  consumeObservationRateLimit: consumeJtiRateLimit,
  async enqueueObservation(message, env) {
    if (!env.OBSERVATION_QUEUE) throw new MenuTokenUnavailableError();
    await env.OBSERVATION_QUEUE.send(ObservationQueueEnvelopeSchema.parse(message));
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
  async approve(actorId, venueId, input, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await approveMenuRevision(client, actorId, venueId, input);
    } finally {
      await client.end();
    }
  },
  async publish(actorId, venueId, input, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await publishMenu(client, actorId, venueId, input);
    } finally {
      await client.end();
    }
  },
  async withdraw(actorId, venueId, input, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await withdrawMenu(client, actorId, venueId, input);
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
  async readPublicMenu(venueId, menuId, env) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await readPublicMenu(client, venueId, menuId);
    } finally {
      await client.end();
    }
  },
  async issuePublicMenu(menu, env) {
    if (!env.MENU_TOKEN_ISSUER || !env.MENU_TOKEN_SIGNING_JWK) throw new AuthUnavailableError();
    return createPublicMenuResponse(menu, {
      issuer: env.MENU_TOKEN_ISSUER,
      signingJwk: env.MENU_TOKEN_SIGNING_JWK,
      allowLocalIssuer: env.APP_ENV === 'local',
    });
  },
  async readMenuJwks(env) {
    if (!env.MENU_TOKEN_ISSUER || !env.MENU_TOKEN_SIGNING_JWK) throw new AuthUnavailableError();
    return menuJwks({
      issuer: env.MENU_TOKEN_ISSUER,
      signingJwk: env.MENU_TOKEN_SIGNING_JWK,
      allowLocalIssuer: env.APP_ENV === 'local',
    });
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
  app.get('/.well-known/jwks.json', async (c) => {
    if (!services.readMenuJwks) throw new AuthUnavailableError();
    c.header('Content-Type', 'application/jwk-set+json');
    return c.json(await services.readMenuJwks(c.env ?? {}));
  });
  app.use(
    '/venues/*',
    bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'body_too_large' }, 413) }),
  );
  app.get('/public/venues/:venueId/menus/:menuId', async (c) => {
    const scope = MenuScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    if (!services.readPublicMenu || !services.issuePublicMenu) throw new AuthUnavailableError();
    const menu = await services.readPublicMenu(scope.data.venueId, scope.data.menuId, c.env ?? {});
    if (!menu) return c.json({ error: 'not_found' }, 404);
    return c.json(await services.issuePublicMenu(menu, c.env ?? {}));
  });
  app.use(
    '/observations',
    cors({
      origin: [...DINER_CORS_ALLOWED_ORIGINS],
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400,
    }),
  );
  app.use(
    '/observations',
    bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ error: 'body_too_large' }, 413) }),
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
  app.post('/observations', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!services.verifyMenu || !services.consumeObservationRateLimit) {
      throw new MenuTokenUnavailableError();
    }
    const authority = await services.verifyMenu(authorization, c.env ?? {});
    const rate = await services.consumeObservationRateLimit(authority.jti, c.env ?? {});
    if (!rate.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterSeconds))));
      return c.json({ error: 'rate_limited' }, 429);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    if (
      body &&
      typeof body === 'object' &&
      Array.isArray((body as Record<string, unknown>).events) &&
      ((body as Record<string, unknown>).events as unknown[]).length > 25
    ) {
      return c.json({ error: 'body_too_large' }, 413);
    }
    const parsed = ObservationBatchV2Schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_envelope' }, 400);
    if (!services.enqueueObservation) throw new MenuTokenUnavailableError();
    const enqueueObservation = services.enqueueObservation;
    const result = await ingestObservations(parsed.data.events, authority, {
      enqueue: (message) => enqueueObservation(message, c.env ?? {}),
      ...(services.now ? { now: services.now } : {}),
    });
    if (result.queueUnavailable) return c.json({ error: 'queue_unavailable' }, 503);
    return c.json(result.response);
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
  const publicationRoute = (
    path: string,
    schema: typeof ApproveMenuRevisionSchema | typeof PublishMenuSchema | typeof WithdrawMenuSchema,
    execute:
      | NonNullable<Dependencies['approve']>
      | NonNullable<Dependencies['publish']>
      | NonNullable<Dependencies['withdraw']>
      | undefined,
  ) => {
    app.post(path, async (c) => {
      const authorization = c.req.header('Authorization');
      if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const actorId = await services.verify(authorization, c.env ?? {});
      const scope = MenuScopeSchema.safeParse(c.req.param());
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
      const parsed = schema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      if (!execute) throw new AuthUnavailableError();
      const result = await execute(
        actorId,
        scope.data.venueId,
        { ...parsed.data, menuId: scope.data.menuId } as never,
        c.env ?? {},
      );
      return c.json(result);
    });
  };
  publicationRoute(
    '/venues/:venueId/menus/:menuId/approvals',
    ApproveMenuRevisionSchema,
    services.approve,
  );
  publicationRoute(
    '/venues/:venueId/menus/:menuId/publications',
    PublishMenuSchema,
    services.publish,
  );
  publicationRoute(
    '/venues/:venueId/menus/:menuId/withdrawals',
    WithdrawMenuSchema,
    services.withdraw,
  );
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
  app.onError((error, c) => {
    if (error instanceof AuthenticationError) return c.json({ error: 'unauthorized' }, 401);
    if (error instanceof MenuTokenAuthenticationError)
      return c.json({ error: 'unauthorized' }, 401);
    if (error instanceof MenuTokenAuthorizationError) return c.json({ error: 'forbidden' }, 403);
    if (error instanceof MenuTokenUnavailableError)
      return c.json({ error: 'service_unavailable' }, 503);
    if (error instanceof AuthUnavailableError) return c.json({ error: 'service_unavailable' }, 503);
    if (error instanceof CommandError) return c.json({ error: error.code }, error.status);
    if (error instanceof PublicationCommandError)
      return c.json({ error: error.code }, error.status);
    // Never log bearer tokens, request bodies or database errors containing row data.
    console.error(
      JSON.stringify({ event: 'command_failed', requestId: c.res.headers.get('X-Request-ID') }),
    );
    return c.json({ error: 'service_unavailable' }, 503);
  });
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

export default createApp();
