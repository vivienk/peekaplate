import crypto from 'node:crypto';
import {
  type ApproveDishDraftRequest,
  ApproveDishDraftRequestSchema,
  ApproveMenuRevisionSchema,
  type BoundedRetrievalResult,
  CandidateReviewScopeSchema,
  CreateDishRevisionSchema,
  type CreateOwnerInsightActionRequest,
  CreateOwnerInsightActionRequestSchema,
  type DishRevision,
  DishRevisionScopeSchema,
  DraftScopeSchema,
  ExtractionReviewScopeSchema,
  type ExtractionReviewSessionResponse,
  type HealthResponse,
  JobScopeSchema,
  MAX_ORDER_OUTCOME_FILE_BYTES,
  MenuScopeSchema,
  ObservationBatchV2Schema,
  type ObservationQueueEnvelope,
  ObservationQueueEnvelopeSchema,
  type OrderOutcomeImportResponse,
  OwnerInsightActionIdSchema,
  type OwnerInsightActionListQuery,
  OwnerInsightActionListQuerySchema,
  type PublicMenuResponse,
  PublishMenuSchema,
  type ReviewCandidateCommand,
  ReviewCandidateCommandSchema,
  type ReviewCandidateItemResponse,
  type SubmitMenuIngestionRequest,
  SubmitMenuIngestionRequestSchema,
  TeamAnalyticsQuerySchema,
  TeamAnalyticsResponseSchema,
  type UpdateOwnerInsightActionRequest,
  UpdateOwnerInsightActionRequestSchema,
  type UpsertExtractionReviewSessionRequest,
  UpsertExtractionReviewSessionRequestSchema,
  VenueScopeSchema,
  WithdrawMenuSchema,
} from '@peekaplate/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Client } from 'pg';
import { AuthenticationError, AuthUnavailableError, createStaffVerifier } from './auth';
import {
  type ConsumerBindings,
  createQueueHandler as createObservationQueueHandler,
  type QueueHandlerServices,
} from './consumer';
import { CommandError, createDishRevision, type DishRevisionResult } from './dish-command';
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
import { readMenuUpload, storeAndDispatchUpload } from './ingestion/upload';
import {
  createMenuTokenVerifier,
  type MenuAuthority,
  MenuTokenAuthenticationError,
  MenuTokenAuthorizationError,
  MenuTokenUnavailableError,
} from './menu-token';
import { ingestObservations } from './observation-ingest';
import {
  cleanupOrphanedOrderImports,
  importOrderOutcomes as importOrderOutcomesService,
  OrderImportError,
  type OrderOutcomeStorage,
} from './order-ingestion/service';
import {
  createOwnerInsightAction,
  listOwnerInsightActions,
  OwnerInsightActionError,
  updateOwnerInsightAction,
} from './owner-insight-actions';
import { readOwnerReport as queryOwnerReport } from './owner-report';
import { buildOwnerReportExportFilename, serializeOwnerReportCsv } from './owner-report-export';
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
import { type ReviewArtifactObject, verifyReviewArtifact } from './review-artifact';
import {
  getExtractionReviewSession,
  ReviewCommandError,
  saveCandidateReviewCommand,
  upsertExtractionReviewSession,
} from './review-command';
import { readTeamAnalytics } from './team-analytics';
import { verifyTeamCollaborator } from './team-auth';

export const SYNTHETIC_REPORT_VENUE_ALLOWLIST: readonly [string, ...string[]] = [
  '00000000-0000-4000-8000-000000000123',
];

export type Bindings = {
  APP_ENV?: string;
  SYNTHETIC_REPORT_VENUE_ID?: string;
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
  INGESTION_QUEUE?: { send(message: unknown): Promise<void> };
  /**
   * Private bucket: ingestion writes reports with put(); the review verifier reads the extraction
   * host's attempt bundles with get(). get stays optional because ingestion-only environments and
   * tests bind put() alone; without it, review sessions outside local fail as artifact_unavailable.
   */
  INGESTION_REPORTS_BUCKET?: {
    put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>;
    get?(key: string): Promise<ReviewArtifactObject | null>;
  };
  ORDER_OUTCOME_ARCHIVE_BUCKET?: OrderOutcomeStorage;
  ORDER_IMPORT_BUCKET?: OrderOutcomeStorage;
  ORDER_IMPORT_HISTORICAL_DAYS?: string;
  ORDER_IMPORT_RETENTION_DAYS?: string;
  ORDER_IMPORT_GRACE_PERIOD_MS?: string;
  EXTRACTION_SERVICE_URL?: string;
  EXTRACTION_SERVICE_SECRET?: string;
  EXTRACTION_SOURCE_SIGNING_SECRET?: string;
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
  readOwnerReport?: (
    actorId: string,
    venueId: string,
    now: Date,
    env: Bindings,
    source: 'synthetic',
  ) => ReturnType<typeof queryOwnerReport>;
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
  importOrderOutcomes?: (
    actorId: string,
    venueId: string,
    csvText: string,
    sourceFilename: string,
    env: Bindings,
  ) => Promise<OrderOutcomeImportResponse>;
  upsertReviewSession?: (
    actorId: string,
    venueId: string,
    input: UpsertExtractionReviewSessionRequest,
    env: Bindings,
  ) => Promise<ExtractionReviewSessionResponse>;
  getReviewSession?: (
    actorId: string,
    venueId: string,
    extractionId: string,
    env: Bindings,
  ) => Promise<ExtractionReviewSessionResponse>;
  saveCandidateReview?: (
    actorId: string,
    venueId: string,
    extractionId: string,
    candidateId: string,
    input: ReviewCandidateCommand,
    env: Bindings,
  ) => Promise<ReviewCandidateItemResponse>;
  createOwnerAction?: (
    actorId: string,
    venueId: string,
    input: CreateOwnerInsightActionRequest,
    env: Bindings,
  ) => ReturnType<typeof createOwnerInsightAction>;
  updateOwnerAction?: (
    actorId: string,
    venueId: string,
    actionId: string,
    input: UpdateOwnerInsightActionRequest,
    env: Bindings,
  ) => ReturnType<typeof updateOwnerInsightAction>;
  listOwnerActions?: (
    actorId: string,
    venueId: string,
    query: OwnerInsightActionListQuery,
    env: Bindings,
  ) => ReturnType<typeof listOwnerInsightActions>;
};

export async function submitAuthorizedMenuIngestion(
  client: Client,
  actorId: string,
  venueId: string,
  request: Parameters<typeof submitMenuIngestion>[1],
  queue?: { send(message: unknown): Promise<void> },
) {
  await client.query('BEGIN');
  let job: MenuIngestionJobRow;
  try {
    await authorizeStaffVenue(client, actorId, venueId, true);
    job = await submitMenuIngestion(client, request, undefined, { inTransaction: true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  if (queue)
    await queue.send({
      version: 1,
      tenantId: venueId,
      jobId: job.id,
      queuedAt: new Date().toISOString(),
    });
  return job;
}

export async function authorizeStaffVenue(
  client: Client,
  actorId: string,
  venueId: string,
  inTransaction = false,
): Promise<void> {
  let started = false;
  try {
    if (!inTransaction) {
      await client.query('BEGIN');
      started = true;
    }
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

    if (!inTransaction) await client.query('COMMIT');
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
  signingJwk: string;
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
 * Exact console-origin allowlist for the owner report route only (S3-RES-03; agreed with Sai,
 * 10 Nov). The owner dashboard calls the report from the browser with the owner's bearer token.
 * No wildcard, preview or other console origins; other routes keep their own lists.
 */
export const CONSOLE_REPORT_CORS_ALLOWED_ORIGINS = [
  'https://peekaplate-console-staging.pages.dev',
  'http://127.0.0.1:5174',
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

async function withDatabase<T>(env: Bindings, run: (client: Client) => Promise<T>): Promise<T> {
  const connectionString =
    env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
  if (!connectionString) throw new AuthUnavailableError();
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.end();
  }
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
    if (!env.MENU_TOKEN_ISSUER || !env.MENU_TOKEN_SIGNING_JWK)
      throw new MenuTokenUnavailableError();
    const local = env.APP_ENV === 'local';
    if (
      !menuVerifier ||
      menuVerifier.issuer !== env.MENU_TOKEN_ISSUER ||
      menuVerifier.local !== local ||
      menuVerifier.signingJwk !== env.MENU_TOKEN_SIGNING_JWK
    ) {
      menuVerifier = {
        issuer: env.MENU_TOKEN_ISSUER,
        local,
        signingJwk: env.MENU_TOKEN_SIGNING_JWK,
        verify: createMenuTokenVerifier({
          issuer: env.MENU_TOKEN_ISSUER,
          allowLocalIssuer: local,
          // Own issuance key: Workers cannot fetch their own public JWKS route (1042).
          jwks: await menuJwks({
            issuer: env.MENU_TOKEN_ISSUER,
            signingJwk: env.MENU_TOKEN_SIGNING_JWK,
            allowLocalIssuer: local,
          }),
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
  async createOwnerAction(actorId, venueId, input, env) {
    return withDatabase(env, (client) => createOwnerInsightAction(client, actorId, venueId, input));
  },
  async updateOwnerAction(actorId, venueId, actionId, input, env) {
    return withDatabase(env, (client) =>
      updateOwnerInsightAction(client, actorId, venueId, actionId, input),
    );
  },
  async listOwnerActions(actorId, venueId, query, env) {
    return withDatabase(env, (client) => listOwnerInsightActions(client, actorId, venueId, query));
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
  async readOwnerReport(actorId, venueId, now, env, source) {
    const connectionString =
      env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
    if (!connectionString) throw new AuthUnavailableError();
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return await queryOwnerReport(client, actorId, venueId, now, source);
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
      trafficClass: env.APP_ENV === 'production' ? 'live' : 'test',
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
  async upsertReviewSession(actorId, venueId, input, env) {
    const bucket = env.INGESTION_REPORTS_BUCKET;
    const get = bucket?.get;
    await verifyReviewArtifact({
      appEnv: env.APP_ENV,
      venueId,
      input,
      read: get ? (key) => get.call(bucket, key) : undefined,
    });
    return withDatabase(env, (client) =>
      upsertExtractionReviewSession(client, actorId, venueId, input),
    );
  },
  getReviewSession: (actorId, venueId, extractionId, env) =>
    withDatabase(env, (client) =>
      getExtractionReviewSession(client, actorId, venueId, extractionId),
    ),
  saveCandidateReview: (actorId, venueId, extractionId, candidateId, input, env) =>
    withDatabase(env, (client) =>
      saveCandidateReviewCommand(client, actorId, venueId, extractionId, candidateId, input),
    ),
};

export async function approveDishDraftAtomic(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  options: { commandId: string; expectedVersion?: number | undefined },
): Promise<{ draft: DishDraftRow; publishedRevision: DishRevisionResult }> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

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

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${options.commandId}`,
    ]);

    const expectedVersion = options.expectedVersion ?? 0;
    const approvalHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ draftId, expectedVersion }))
      .digest('hex');

    const receipt = await client.query<{ request_hash: string; result: any }>(
      `SELECT request_hash, result
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [venueId, actorId, options.commandId],
    );
    const existing = receipt.rows[0];
    if (existing) {
      if (existing.request_hash !== approvalHash) {
        throw new CommandError('command_conflict', 409);
      }
      await client.query('COMMIT');
      started = false;
      return existing.result;
    }

    const draftRes = await client.query<DishDraftRow>(
      `SELECT * FROM app_private.dish_drafts
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [venueId, draftId],
    );
    const draft = draftRes.rows[0];
    if (!draft || draft.review_status !== 'pending') {
      throw new IngestionError('draft_not_pending_or_not_found', 404);
    }

    const newDishId = crypto.randomUUID();
    const revisionCommandId = crypto.randomUUID();
    const revision = await createDishRevision(
      client,
      actorId,
      venueId,
      {
        commandId: revisionCommandId,
        dishId: newDishId,
        expectedVersion,
        name: draft.name,
        description: draft.description ?? draft.name,
      },
      { inTransaction: true },
    );

    const updatedDraft = await approveDishDraft(
      client,
      {
        actorId,
        tenantId: venueId,
        draftId,
        publishedDishId: revision.dishId,
      },
      { inTransaction: true },
    );

    const result = { draft: updatedDraft, publishedRevision: revision };

    const payload = JSON.stringify({ draftId, expectedVersion });
    await client.query(
      `INSERT INTO app_private.es_command
        (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
       VALUES ($1, $2, $3, 'dish.draft.approve', $4, $5::jsonb, $6, $7::jsonb)`,
      [
        crypto.randomUUID(),
        venueId,
        actorId,
        options.commandId,
        payload,
        approvalHash,
        JSON.stringify(result),
      ],
    );

    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw error;
  }
}

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
  const orderImportLimit = bodyLimit({
    maxSize: MAX_ORDER_OUTCOME_FILE_BYTES,
    onError: (ctx) => ctx.json({ error: 'payload_too_large' }, 413),
  });
  const reviewSessionLimit = bodyLimit({
    maxSize: 524_288,
    onError: (c) => c.json({ error: 'body_too_large' }, 413),
  });
  const defaultVenueLimit = bodyLimit({
    maxSize: 16_384,
    onError: (c) => c.json({ error: 'body_too_large' }, 413),
  });
  app.use('/venues/*', async (c, next) => {
    if (c.req.method === 'POST' && /^\/venues\/[^/]+\/menus\/uploads$/.test(c.req.path))
      return next();
    if (c.req.method === 'POST' && /^\/venues\/[^/]+\/orders\/import$/.test(c.req.path)) {
      return orderImportLimit(c, next);
    }

    if (
      c.req.method === 'PUT' &&
      /^\/venues\/[^/]+\/extractions\/[^/]+\/review-session$/.test(c.req.path)
    ) {
      return reviewSessionLimit(c, next);
    }
    return defaultVenueLimit(c, next);
  });
  app.use(
    '/public/venues/*',
    cors({
      origin: [...DINER_CORS_ALLOWED_ORIGINS],
      allowMethods: ['GET', 'OPTIONS'],
      maxAge: 86400,
    }),
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
  // CORS only: authentication, the synthetic-source rule and venue access below are unchanged.
  app.use(
    '/api/v1/venues/:venueId/analytics/dishes',
    cors({
      origin: [...CONSOLE_REPORT_CORS_ALLOWED_ORIGINS],
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Authorization'],
      maxAge: 86400,
    }),
  );
  app.get('/api/v1/venues/:venueId/analytics/dishes', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer /.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const env = c.env ?? {};
    const sources = new URL(c.req.url).searchParams.getAll('source');
    if (
      !['local', 'staging'].includes(env.APP_ENV ?? '') ||
      sources.length !== 1 ||
      sources[0] !== 'synthetic'
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    const approvedSyntheticVenue = VenueScopeSchema.safeParse({
      venueId: env.SYNTHETIC_REPORT_VENUE_ID,
    });
    if (!approvedSyntheticVenue.success) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    const isSyntheticVenue = SYNTHETIC_REPORT_VENUE_ALLOWLIST.includes(
      approvedSyntheticVenue.data.venueId.toLowerCase(),
    );
    if (
      !isSyntheticVenue ||
      scope.data.venueId.toLowerCase() !== approvedSyntheticVenue.data.venueId.toLowerCase()
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!services.readOwnerReport) throw new AuthUnavailableError();
    const report = await services.readOwnerReport(
      actorId,
      approvedSyntheticVenue.data.venueId,
      services.now?.() ?? new Date(),
      env,
      'synthetic',
    );
    return c.json(report);
  });
  app.use(
    '/api/v1/venues/:venueId/analytics/dishes/export',
    cors({
      origin: [...CONSOLE_REPORT_CORS_ALLOWED_ORIGINS],
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Authorization'],
      maxAge: 86400,
    }),
  );
  app.get('/api/v1/venues/:venueId/analytics/dishes/export', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer /.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    const env = c.env ?? {};
    const sources = new URL(c.req.url).searchParams.getAll('source');
    if (
      !['local', 'staging'].includes(env.APP_ENV ?? '') ||
      sources.length !== 1 ||
      sources[0] !== 'synthetic'
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    const approvedSyntheticVenue = VenueScopeSchema.safeParse({
      venueId: env.SYNTHETIC_REPORT_VENUE_ID,
    });
    if (!approvedSyntheticVenue.success) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    const isSyntheticVenue = SYNTHETIC_REPORT_VENUE_ALLOWLIST.includes(
      approvedSyntheticVenue.data.venueId.toLowerCase(),
    );
    if (
      !isSyntheticVenue ||
      scope.data.venueId.toLowerCase() !== approvedSyntheticVenue.data.venueId.toLowerCase()
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!services.readOwnerReport) throw new AuthUnavailableError();
    const report = await services.readOwnerReport(
      actorId,
      approvedSyntheticVenue.data.venueId,
      services.now?.() ?? new Date(),
      env,
      'synthetic',
    );
    const csv = serializeOwnerReportCsv(report);
    const filename = buildOwnerReportExportFilename(
      report.venue_id,
      report.report_metadata.generated_at,
    );
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
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

  app.get('/venues/:venueId/owner-insight-actions', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    const url = new URL(c.req.url);
    const params = url.searchParams;
    const query = OwnerInsightActionListQuerySchema.safeParse(Object.fromEntries(params.entries()));
    if (!query.success || [...params.keys()].length !== new Set(params.keys()).size) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!services.listOwnerActions) throw new AuthUnavailableError();

    const result = await services.listOwnerActions(
      actorId,
      scope.data.venueId,
      query.data,
      c.env ?? {},
    );
    return c.json(result);
  });

  app.post('/venues/:venueId/owner-insight-actions', async (c) => {
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
    const parsed = CreateOwnerInsightActionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (!services.createOwnerAction) throw new AuthUnavailableError();

    const result = await services.createOwnerAction(
      actorId,
      scope.data.venueId,
      parsed.data,
      c.env ?? {},
    );
    return c.json(result, 201);
  });

  app.patch('/venues/:venueId/owner-insight-actions/:actionId', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse({
      venueId: c.req.param('venueId'),
    });
    const actionId = OwnerInsightActionIdSchema.safeParse(c.req.param('actionId'));
    if (!scope.success || !actionId.success) {
      return c.json({ error: 'invalid_request' }, 400);
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
    const parsed = UpdateOwnerInsightActionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (!services.updateOwnerAction) throw new AuthUnavailableError();

    const result = await services.updateOwnerAction(
      actorId,
      scope.data.venueId,
      actionId.data,
      parsed.data,
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

  app.post('/venues/:venueId/menus/uploads', async (c) => {
    if (c.env?.APP_ENV !== 'staging' && c.env?.APP_ENV !== 'local')
      return c.json({ error: 'not_found' }, 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    await (services.authorizeVenue ?? dependencies.authorizeVenue!)(
      actorId,
      scope.data.venueId,
      c.env,
    );
    const storage = c.env.INGESTION_REPORTS_BUCKET;
    const queue = c.env.INGESTION_QUEUE;
    if (!storage || !queue) throw new AuthUnavailableError();
    const upload = await readMenuUpload(c.req.raw);
    const createJob = async () => {
      const env = c.env;
      const connectionString =
        env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
      if (!connectionString) throw new AuthUnavailableError();
      const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        return await submitAuthorizedMenuIngestion(client, actorId, scope.data.venueId, {
          venueId: scope.data.venueId,
          sourceType: upload.sourceType,
          sourceHash: upload.sourceHash,
          idempotencyKey: upload.idempotencyKey,
        });
      } finally {
        await client.end();
      }
    };
    const job = await storeAndDispatchUpload(scope.data.venueId, upload, createJob, storage, queue);
    return c.json({ job }, 202);
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
          const queueProducer = env.INGESTION_QUEUE
            ? { send: (msg: unknown) => env.INGESTION_QUEUE!.send(msg) }
            : undefined;
          return await submitAuthorizedMenuIngestion(
            client,
            actorId,
            venueId,
            { venueId, ...req },
            queueProducer,
          );
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
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
          return await approveDishDraftAtomic(client, actorId, venueId, draftId, options);
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

  app.post('/venues/:venueId/orders/import', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    const contentType = c.req.header('Content-Type') ?? '';
    let csvText = '';
    let sourceFilename = 'orders.csv';

    if (contentType.includes('multipart/form-data')) {
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        return c.json({ error: 'invalid_form_data' }, 400);
      }
      const file = formData.get('file');
      if (!file) {
        return c.json({ error: 'missing_file' }, 400);
      }
      if (typeof file === 'object' && 'text' in file) {
        csvText = await (file as Blob).text();
        sourceFilename = (file as File).name || 'orders.csv';
      } else if (typeof file === 'string') {
        csvText = file;
      }
    } else if (
      contentType.includes('text/csv') ||
      contentType.includes('text/plain') ||
      contentType.includes('application/csv') ||
      contentType === ''
    ) {
      csvText = await c.req.text();
    } else {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }

    const importFn =
      services.importOrderOutcomes ??
      (async (actorId, venueId, csvText, sourceFilename, env) => {
        const storage =
          env.ORDER_OUTCOME_ARCHIVE_BUCKET ??
          env.ORDER_IMPORT_BUCKET ??
          env.INGESTION_REPORTS_BUCKET;
        if (!storage) throw new AuthUnavailableError();
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          const maxHistoricalDays = env.ORDER_IMPORT_HISTORICAL_DAYS
            ? Number.parseInt(env.ORDER_IMPORT_HISTORICAL_DAYS, 10)
            : undefined;

          return await importOrderOutcomesService({
            client,
            actorId,
            venueId,
            csvText,
            sourceFilename,
            maxHistoricalDays,
            storage,
          });
        } finally {
          await client.end().catch(() => {});
        }
      });

    const result = await importFn(
      actorId,
      scope.data.venueId,
      csvText,
      sourceFilename,
      c.env ?? {},
    );
    return c.json(result, 200);
  });

  app.put('/venues/:venueId/extractions/:extractionId/review-session', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = ExtractionReviewScopeSchema.safeParse(c.req.param());
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
    const parsed = UpsertExtractionReviewSessionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (parsed.data.extractionResult.extraction_id !== scope.data.extractionId) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    if (!services.upsertReviewSession) throw new AuthUnavailableError();
    const handler = services.upsertReviewSession;

    const result = await handler(actorId, scope.data.venueId, parsed.data, c.env ?? {});
    return c.json(result);
  });
  app.get('/venues/:venueId/extractions/:extractionId/candidates', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = ExtractionReviewScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    if (!services.getReviewSession) throw new AuthUnavailableError();
    const handler = services.getReviewSession;

    const result = await handler(actorId, scope.data.venueId, scope.data.extractionId, c.env ?? {});
    return c.json(result);
  });
  app.post(
    '/venues/:venueId/extractions/:extractionId/candidates/:candidateId/review',
    async (c) => {
      const authorization = c.req.header('Authorization');
      if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const actorId = await services.verify(authorization, c.env ?? {});
      const scope = CandidateReviewScopeSchema.safeParse(c.req.param());
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
      const parsed = ReviewCandidateCommandSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

      if (!services.saveCandidateReview) throw new AuthUnavailableError();
      const handler = services.saveCandidateReview;

      const result = await handler(
        actorId,
        scope.data.venueId,
        scope.data.extractionId,
        scope.data.candidateId,
        parsed.data,
        c.env ?? {},
      );
      return c.json(result);
    },
  );

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
    if (error instanceof OwnerInsightActionError)
      return c.json({ error: error.code }, error.status);
    if (error instanceof IngestionError) return c.json({ error: error.code }, error.status as any);
    if (error instanceof OrderImportError)
      return c.json({ error: error.code, message: error.message }, error.status as any);
    if (error instanceof ReviewCommandError) return c.json({ error: error.code }, error.status);
    // Never log bearer tokens, request bodies or database errors containing row data.
    console.error(
      JSON.stringify({ event: 'command_failed', requestId: c.res.headers.get('X-Request-ID') }),
    );
    return c.json({ error: 'service_unavailable' }, 503);
  });
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

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
            ...(env.EXTRACTION_SOURCE_SIGNING_SECRET !== undefined
              ? { sourceSigningSecret: env.EXTRACTION_SOURCE_SIGNING_SECRET }
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

export function createWorker(
  services: Dependencies = dependencies,
  queueServices: QueueHandlerServices = {},
) {
  const app = createApp(services);
  const observationQueue = createObservationQueueHandler(queueServices);
  const queue = async (batch: any, env: any) => {
    if (
      batch?.queue === 'peekaplate-staging-menu-ingestion' ||
      (Array.isArray(batch?.messages) &&
        batch.messages[0]?.body &&
        typeof batch.messages[0].body === 'object' &&
        'jobId' in batch.messages[0].body &&
        'tenantId' in batch.messages[0].body)
    ) {
      await handleQueueBatch(batch, env, services);
    } else {
      await observationQueue(batch, env);
    }
  };
  return Object.assign(app, { queue, scheduled: handleScheduled });
}

export {
  type ConsumerBindings,
  createObservationQueueHandler as createQueueHandler,
  OrderImportError,
  type QueueHandlerServices,
};

export const handleScheduled = async (event: any, env: any) => {
  const storage =
    env.ORDER_OUTCOME_ARCHIVE_BUCKET ?? env.ORDER_IMPORT_BUCKET ?? env.INGESTION_REPORTS_BUCKET;
  if (!storage || typeof storage.list !== 'function' || typeof storage.delete !== 'function') {
    return;
  }
  const connectionString =
    env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return;
  }

  const rawCsvRetentionDays = env.ORDER_IMPORT_RETENTION_DAYS
    ? Number.parseInt(env.ORDER_IMPORT_RETENTION_DAYS, 10)
    : undefined;
  const orphanGracePeriodMs = env.ORDER_IMPORT_GRACE_PERIOD_MS
    ? Number.parseInt(env.ORDER_IMPORT_GRACE_PERIOD_MS, 10)
    : undefined;

  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await cleanupOrphanedOrderImports({
      storage,
      client,
      retentionConfig: {
        rawCsvRetentionDays,
        orphanGracePeriodMs,
      },
    });
    if (result.deleted > 0) {
      console.log(
        JSON.stringify({
          event: 'order_import_orphan_cleanup',
          scanned: result.scanned,
          deleted: result.deleted,
          deletedOrphans: result.deletedOrphans,
          deletedAgedRawCsv: result.deletedAgedRawCsv,
          skippedActive: result.skippedActive,
          retained: result.retained,
        }),
      );
    }
  } catch {
    console.error(JSON.stringify({ event: 'order_import_orphan_cleanup_error' }));
  } finally {
    await client.end().catch(() => {});
  }
};

export const scheduled = handleScheduled;

const defaultApp = createApp();
const defaultObservationQueue = createObservationQueueHandler();
export const queue = async (batch: any, env: any) => {
  if (
    batch?.queue === 'peekaplate-staging-menu-ingestion' ||
    (Array.isArray(batch?.messages) &&
      batch.messages[0]?.body &&
      typeof batch.messages[0].body === 'object' &&
      'jobId' in batch.messages[0].body &&
      'tenantId' in batch.messages[0].body)
  ) {
    await handleQueueBatch(batch, env);
  } else {
    await defaultObservationQueue(batch, env);
  }
};
export default Object.assign(defaultApp, { queue, scheduled });
