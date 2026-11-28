import crypto from 'node:crypto';
import {
  AcceptPilotOrderAgreementRequestSchema,
  type AcceptPilotOrderAgreementResponse,
  type ApproveDishDraftRequest,
  ApproveDishDraftRequestSchema,
  ApprovedDishFactsSchema,
  ApproveMenuRevisionSchema,
  type BoundedRetrievalResult,
  CandidateCorrectedFieldsSchema,
  CandidateReviewScopeSchema,
  CreateDishRevisionSchema,
  type CreateOwnerInsightActionRequest,
  CreateOwnerInsightActionRequestSchema,
  DeleteOrderDataRequestSchema,
  DinerLinkSchema,
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
  type OrderDataDeletionReason,
  type OrderOutcomeImportResponse,
  OwnerDishFieldsSchema,
  OwnerInsightActionIdSchema,
  type OwnerInsightActionListQuery,
  OwnerInsightActionListQuerySchema,
  OwnerWorkspaceResponseSchema,
  PreparedMenuPreviewSchema,
  PreparedMenusSchema,
  type PublicMenuContentBundle,
  type PublicMenuResponse,
  PublishMenuSchema,
  RestaurantSlugSchema,
  type ReviewCandidateCommand,
  ReviewCandidateCommandSchema,
  type ReviewCandidateItemResponse,
  resolveServingCount,
  type SubmitMenuIngestionRequest,
  SubmitMenuIngestionRequestSchema,
  type SubmitOrderDeletionResponse,
  TeamAnalyticsQuerySchema,
  TeamAnalyticsResponseSchema,
  type UpdateOwnerInsightActionRequest,
  UpdateOwnerInsightActionRequestSchema,
  type UpsertExtractionReviewSessionRequest,
  UpsertExtractionReviewSessionRequestSchema,
  VenueScopeSchema,
  VerifyOrderDeletionRequestSchema,
  WithdrawMenuSchema,
} from '@peekaplate/contracts';
import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
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
import { validateMenuPdf } from './ingestion/intake';
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
import { registerArtworkRoutes } from './ingredient-artwork-routes';
import {
  createMenuTokenVerifier,
  type MenuAuthority,
  MenuTokenAuthenticationError,
  MenuTokenAuthorizationError,
  MenuTokenUnavailableError,
} from './menu-token';
import { ingestObservations } from './observation-ingest';
import {
  acceptPilotOrderAgreement as acceptPilotOrderAgreementService,
  cleanupOrphanedOrderImports,
  importOrderOutcomes as importOrderOutcomesService,
  type OrderDeletionVerificationStorage,
  OrderImportError,
  type OrderOutcomeStorage,
  retryPendingOrphanCleanups,
  submitOrderDataDeletionRequest as submitOrderDataDeletionRequestService,
  verifyVenueOrderDeletion as verifyVenueOrderDeletionService,
} from './order-ingestion/service';

import { registerDishAssistanceRoutes } from './owner-ai/dish-assistance';
import {
  mintOwnerReportReference,
  OWNER_REPORT_REFERENCE_HEADER,
} from './owner-ai/report-reference';
import { registerOwnerAnalysisRoutes } from './owner-ai/routes';
import {
  createOwnerInsightAction,
  listOwnerInsightActions,
  OwnerInsightActionError,
  updateOwnerInsightAction,
} from './owner-insight-actions';
import { assertManualDraftReady } from './owner-menu';
import { registerOwnerMenuRoutes } from './owner-menu-routes';
import {
  PREPARED_ASSET_PATH,
  PREPARED_BUNDLE_PATH,
  type PreparedStorage,
  prepareOwnerMenu,
  readPreparedAsset,
  readPreparedBundle,
  readPreparedLogo,
  readPreparedPreviewAsset,
} from './owner-prepare';
import { fetchPreparedMenu, listPreparedMenus, type OwnHost } from './owner-publication';
import { type OwnerReportSource, readOwnerReport as queryOwnerReport } from './owner-report';
import { ownerReportDishDayStart, ownerReportDishLiveStart } from './owner-report-batches';
import {
  buildOwnerReportExportFilename,
  type ExportableOwnerReport,
  serializeOwnerReportCsv,
} from './owner-report-export';
import {
  OwnerReportPostHogUnavailableError,
  readLivePostHogOwnerEvents,
} from './owner-report-posthog';
import { registerOwnerVenueCreation } from './owner-venue-create';
import {
  ownerWorkflowAvailable,
  PRODUCTION_DINER_ORIGIN,
  PRODUCTION_OWNER_ORIGIN,
  productionOwnerReportingEnabled,
} from './owner-workflow-environment';
import { listOwnerVenues } from './owner-workspace';
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
  readDinerLink,
  withdrawMenu,
} from './publication-command';
import { resolveRestaurantLink } from './restaurant-link';
import { retrieveMenuEvidence } from './retrieval';
import { type ReviewArtifactObject, verifyReviewArtifact } from './review-artifact';
import {
  getExtractionReviewSession,
  ReviewCommandError,
  saveCandidateReviewCommand,
  upsertExtractionReviewSession,
} from './review-command';
import { authorizeStaffVenue } from './staff-venue';
import { readTeamAnalytics } from './team-analytics';
import { verifyTeamCollaborator } from './team-auth';

export { authorizeStaffVenue } from './staff-venue';

import {
  configuredSyntheticReportVenues,
  SYNTHETIC_REPORT_VENUE_ALLOWLIST,
  syntheticReportTrafficClass,
} from './owner-report-scope';

export { SYNTHETIC_REPORT_VENUE_ALLOWLIST } from './owner-report-scope';

export type Bindings = {
  OWNER_AI_RESPONSES_ENABLED?: string;
  OWNER_AI_OPENAI_API_KEY?: string;
  OWNER_AI_OPENAI_PROJECT_ID?: string;
  OWNER_AI_REPORT_REFERENCE_SECRET?: string;
  OWNER_AI_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  INGREDIENT_ARTWORK_ENABLED?: string;
  APP_ENV?: string;
  OWNER_WORKFLOW_ENABLED?: string;
  OWNER_PRODUCTION_REPORTS_ENABLED?: string;
  OWNER_PRODUCTION_REPORT_WINDOW?: string;
  OWNER_PRODUCTION_REPORT_DISH_DAY_START?: string;
  OWNER_PRODUCTION_REPORT_DISH_LIVE_START?: string;
  OWNER_REPORT_DISPLAY_ACTIONS_ENABLED?: string;
  PRODUCTION_OBSERVATION_PROVENANCE_ENABLED?: string;
  DINER_PUBLIC_ORIGIN?: string;
  SYNTHETIC_REPORT_VENUE_ID?: string;
  AUTH_ISSUER?: string;
  LOCAL_DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  POSTHOG_PROJECT_ID?: string;
  POSTHOG_OWNER_REPORT_READ_KEY?: string;
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
    put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: {
        customMetadata?: Record<string, string>;
        httpMetadata?: { contentType?: string };
        onlyIf?: { etagDoesNotMatch?: string };
        sha256?: string;
      },
    ): Promise<unknown>;
    get?(key: string): Promise<ReviewArtifactObject | null>;
    head?(key: string): Promise<{ uploaded?: Date | string } | null>;
    list?(options: {
      prefix: string;
      limit?: number | undefined;
      cursor?: string | undefined;
    }): Promise<{
      objects: { key: string; size: number; uploaded: Date }[];
      truncated: boolean;
      cursor?: string;
    }>;
    delete?(key: string): Promise<unknown>;
  };
  INGREDIENT_ARTWORK_BUCKET?: {
    put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: { onlyIf?: { etagDoesNotMatch?: string }; sha256?: string },
    ): Promise<unknown>;
    get?(key: string): Promise<ReviewArtifactObject | null>;
    head?(key: string): Promise<{ uploaded?: Date | string } | null>;
    list?(options: {
      prefix: string;
      limit?: number | undefined;
      cursor?: string | undefined;
    }): Promise<{
      objects: { key: string; size: number; uploaded: Date }[];
      truncated: boolean;
      cursor?: string;
    }>;
    delete?(key: string): Promise<unknown>;
  };
  INGREDIENT_ARTWORK_ORPHAN_GRACE_MS?: string;
  INGREDIENT_ARTWORK_CLEANUP_DRY_RUN?: string;
  MENU_STAGING_RETENTION_DAYS?: string;
  MENU_STAGING_REJECTED_RETENTION_DAYS?: string;
  MENU_STAGING_ORPHAN_GRACE_DAYS?: string;
  MENU_STAGING_CLEANUP_DRY_RUN?: string;

  ORDER_OUTCOME_ARCHIVE_BUCKET?: OrderOutcomeStorage;
  ORDER_IMPORT_BUCKET?: OrderOutcomeStorage;
  ORDER_DELETION_VERIFICATION_BUCKET?: OrderDeletionVerificationStorage;
  OPERATOR_HYPERDRIVE?: { connectionString: string };
  LOCAL_OPERATOR_DATABASE_URL?: string;
  CHECKER_HYPERDRIVE?: { connectionString: string };
  LOCAL_CHECKER_DATABASE_URL?: string;
  AUTHORIZED_DELETION_OPERATOR_IDS?: string;
  AUTHORIZED_DELETION_CHECKER_IDS?: string;
  ORDER_IMPORT_HISTORICAL_DAYS?: string;
  ORDER_IMPORT_RETENTION_DAYS?: string;
  ORDER_IMPORT_GRACE_PERIOD_MS?: string;
  /** Server-only Python 2.5D service; never exposed to the console bundle. */
  PORTION_SERVICE_URL?: string;
  PORTION_SERVICE_SECRET?: string;
  EXTRACTION_SERVICE_URL?: string;
  EXTRACTION_SERVICE_SECRET?: string;
  EXTRACTION_SOURCE_SIGNING_SECRET?: string;
  EXTRACTION_TIMEOUT_MS?: string;
  OWNER_AI_DISH_ASSISTANCE_ENABLED?: string;
  OWNER_AI_SYNTHETIC_COMPLETENESS_SEAL?: string;
  SYNTHETIC_REPORT_VENUE_IDS?: string;
};

type Dependencies = {
  verify: (authorization: string, env: Bindings) => Promise<string>;
  readOwnerVenues?: (actorId: string, env: Bindings) => ReturnType<typeof listOwnerVenues>;
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
    source: OwnerReportSource,
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
  resolveRestaurantLink?: (slug: string, env: Bindings) => ReturnType<typeof resolveRestaurantLink>;
  readDinerLink?: (
    actorId: string,
    venueId: string,
    menuId: string,
    env: Bindings,
  ) => ReturnType<typeof readDinerLink>;
  listPreparedMenus?: (
    actorId: string,
    venueId: string,
    env: Bindings,
  ) => ReturnType<typeof listPreparedMenus>;
  fetchPreparedMenu?: typeof fetchPreparedMenu;
  prepareOwnerMenu?: (
    actorId: string,
    venueId: string,
    origin: string,
    env: Bindings,
  ) => ReturnType<typeof prepareOwnerMenu>;
  readPreparedBundle?: (
    venueId: string,
    menuId: string,
    revisionId: string,
    env: Bindings,
  ) => ReturnType<typeof readPreparedBundle>;
  readPreparedAsset?: (
    venueId: string,
    photoId: string,
    hash: string,
    env: Bindings,
  ) => ReturnType<typeof readPreparedAsset>;
  readPreparedLogo?: (
    venueId: string,
    hash: string,
    extension: string,
    env: Bindings,
  ) => ReturnType<typeof readPreparedLogo>;
  readPreparedPreviewAsset?: (
    actorId: string,
    content: PublicMenuContentBundle,
    origin: string,
    assetId: string,
    file: string,
    env: Bindings,
  ) => ReturnType<typeof readPreparedPreviewAsset>;
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
  acceptPilotOrderAgreement?: (
    actorId: string,
    venueId: string,
    agreementVersion: string,
    env: Bindings,
  ) => Promise<AcceptPilotOrderAgreementResponse>;
  submitOrderDataDeletionRequest?: (
    actorId: string,
    venueId: string,
    requestId: string,
    reason: OrderDataDeletionReason | undefined,
    env: Bindings,
  ) => Promise<SubmitOrderDeletionResponse>;
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
  'https://peekaplate.app',
  'https://diner.peekaplate.com',
  'https://peekaplate-diner-staging.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

function allowedDinerOrigin(origin: string, env: Bindings | undefined) {
  if (env?.APP_ENV === 'production') return origin === PRODUCTION_DINER_ORIGIN ? origin : undefined;
  return DINER_CORS_ALLOWED_ORIGINS.some((allowed) => allowed === origin) ||
    (env?.APP_ENV === 'staging' &&
      env.DINER_PUBLIC_ORIGIN === 'https://routing-staging.peekaplate-diner-staging.pages.dev' &&
      origin === env.DINER_PUBLIC_ORIGIN)
    ? origin
    : undefined;
}

function dinerLinkResponse(link: { path: string }, env: Bindings) {
  const origin =
    env.APP_ENV === 'production'
      ? PRODUCTION_DINER_ORIGIN
      : env.APP_ENV === 'local'
        ? 'http://127.0.0.1:5186'
        : env.APP_ENV === 'staging' &&
            [
              'https://peekaplate-diner-staging.pages.dev',
              'https://routing-staging.peekaplate-diner-staging.pages.dev',
            ].includes(env.DINER_PUBLIC_ORIGIN ?? '')
          ? env.DINER_PUBLIC_ORIGIN
          : undefined;
  if (!origin) throw new AuthUnavailableError();
  const path = DinerLinkSchema.parse(link).path;
  return { path, url: `${origin}${path}` };
}

/**
 * Exact console-origin allowlist for the owner report route only (S3-RES-03; agreed with Sai,
 * 10 Nov). The owner dashboard calls the report from the browser with the owner's bearer token.
 * No wildcard, preview or other console origins; other routes keep their own lists.
 */
export const CONSOLE_REPORT_CORS_ALLOWED_ORIGINS = [
  'https://peekaplate-console-staging.pages.dev',
  'http://127.0.0.1:5174',
] as const;

function ownerConsoleOrigin(origin: string, env: Bindings | undefined) {
  if (env?.APP_ENV === 'production')
    return ownerWorkflowAvailable(env) && origin === PRODUCTION_OWNER_ORIGIN ? origin : undefined;
  return CONSOLE_REPORT_CORS_ALLOWED_ORIGINS.some((allowed) => allowed === origin)
    ? origin
    : undefined;
}

function ownerReportRequestSource(url: string, env: Bindings): OwnerReportSource | null {
  const sources = new URL(url).searchParams.getAll('source');
  if (sources.length !== 1) return null;
  if (env.APP_ENV === 'production')
    return productionOwnerReportingEnabled(env) && sources[0] === 'production'
      ? 'production'
      : null;
  return ['staging', 'local'].includes(env.APP_ENV ?? '') && sources[0] === 'synthetic'
    ? 'synthetic'
    : null;
}

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

// Owner-prepared menus (Part A) reuse the private ingestion bucket that already holds approved
// dish photos; bundles live under prepared-menus/.
function preparedStorage(env: Bindings): PreparedStorage {
  const bucket = env.INGESTION_REPORTS_BUCKET;
  if (!bucket?.get) throw new AuthUnavailableError();
  return {
    get: (key) => bucket.get!(key),
    put: (key, bytes, options) => bucket.put(key, bytes, options),
  };
}

function ownHost(c: { req: { url: string } }, env: Bindings): OwnHost | undefined {
  const bucket = env.INGESTION_REPORTS_BUCKET;
  if (!bucket?.get) return undefined;
  return {
    origin: new URL(c.req.url).origin,
    read: async (key) => {
      const object = await bucket.get!(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };
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
  readOwnerVenues: (actorId, env) =>
    withDatabase(env, (client) => listOwnerVenues(client, actorId)),
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
    // The public DTO cannot carry this marker. This call follows exact issuer verification.
    const envelope =
      message.kind === 'observation.v2' &&
      env.APP_ENV === 'production' &&
      env.PRODUCTION_OBSERVATION_PROVENANCE_ENABLED === 'true' &&
      env.MENU_TOKEN_ISSUER === 'https://api.peekaplate.app/'
        ? { ...message, sourceEnvironment: 'production' }
        : message;
    await env.OBSERVATION_QUEUE.send(ObservationQueueEnvelopeSchema.parse(envelope));
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
      const storage = env.INGESTION_REPORTS_BUCKET?.get ? preparedStorage(env) : undefined;
      return await approveMenuRevision(client, actorId, venueId, input, storage);
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
      const storage = env.INGESTION_REPORTS_BUCKET?.get ? preparedStorage(env) : undefined;
      return await publishMenu(client, actorId, venueId, input, storage);
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
      const syntheticReport =
        source === 'synthetic' &&
        ['local', 'staging'].includes(env.APP_ENV ?? '') &&
        configuredSyntheticReportVenues(env).includes(venueId.toLowerCase());
      if (source === 'production' && productionOwnerReportingEnabled(env)) {
        return await queryOwnerReport(client, actorId, venueId, now, source, {
          includeSummary: true,
          productionDay: env.OWNER_PRODUCTION_REPORT_WINDOW === 'sf-day',
          productionToday: env.OWNER_PRODUCTION_REPORT_WINDOW === 'sf-today',
          productionDishLiveStart: ownerReportDishLiveStart(
            env.OWNER_PRODUCTION_REPORT_DISH_LIVE_START,
          ),
          productionDishDayStart: ownerReportDishDayStart(
            env.OWNER_PRODUCTION_REPORT_DISH_DAY_START,
          ),
          includeDisplayActions: env.OWNER_REPORT_DISPLAY_ACTIONS_ENABLED === 'true',
          productionPublications: {
            storage: preparedStorage(env),
            origin: 'https://api.peekaplate.app',
          },
          readTodayEvents: async (venueId, start, end) => {
            if (!env.POSTHOG_OWNER_REPORT_READ_KEY || !env.POSTHOG_PROJECT_ID)
              throw new AuthUnavailableError();
            try {
              return await readLivePostHogOwnerEvents({
                projectId: env.POSTHOG_PROJECT_ID,
                readKey: env.POSTHOG_OWNER_REPORT_READ_KEY,
                venueId,
                windowStart: start.toISOString(),
                windowEnd: end.toISOString(),
              });
            } catch (error) {
              if (error instanceof OwnerReportPostHogUnavailableError)
                throw new AuthUnavailableError();
              throw error;
            }
          },
        });
      }
      if (!syntheticReport) throw new AuthUnavailableError();
      return await queryOwnerReport(client, actorId, venueId, now, source, {
        trafficClass: syntheticReportTrafficClass(venueId),
        includeSummary: true,
        ...(env.APP_ENV === 'staging' && env.OWNER_AI_SYNTHETIC_COMPLETENESS_SEAL
          ? {
              syntheticSeal: env.OWNER_AI_SYNTHETIC_COMPLETENESS_SEAL,
              validationNow: new Date(),
            }
          : {}),
      });
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
  resolveRestaurantLink: (slug, env) =>
    withDatabase(env, (client) => resolveRestaurantLink(client, slug)),
  readDinerLink: (actorId, venueId, menuId, env) =>
    withDatabase(env, (client) => readDinerLink(client, actorId, venueId, menuId)),
  listPreparedMenus: (actorId, venueId, env) =>
    withDatabase(env, (client) => listPreparedMenus(client, actorId, venueId)),
  fetchPreparedMenu,
  prepareOwnerMenu: (actorId, venueId, origin, env) =>
    withDatabase(env, (client) =>
      prepareOwnerMenu(
        client,
        actorId,
        venueId,
        origin,
        preparedStorage(env),
        approveDishDraftAtomic,
      ),
    ),
  readPreparedBundle: (venueId, menuId, revisionId, env) =>
    withDatabase(env, (client) =>
      readPreparedBundle(client, preparedStorage(env), venueId, menuId, revisionId),
    ),
  readPreparedAsset: (venueId, photoId, hash, env) =>
    withDatabase(env, (client) =>
      readPreparedAsset(client, preparedStorage(env), venueId, photoId, hash),
    ),
  readPreparedLogo: (venueId, hash, extension, env) =>
    withDatabase(env, (client) =>
      readPreparedLogo(client, preparedStorage(env), venueId, hash, extension),
    ),
  readPreparedPreviewAsset: (actorId, content, origin, assetId, file, env) =>
    withDatabase(env, (client) =>
      readPreparedPreviewAsset(
        client,
        preparedStorage(env),
        actorId,
        content,
        origin,
        assetId,
        file,
      ),
    ),
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
  options: {
    commandId: string;
    expectedVersion?: number | undefined;
    expectedDraftVersion?: number | undefined;
    expectedReviewVersion?: number | undefined;
    extractionId?: string | undefined;
    confirmed?: true | undefined;
    /**
     * Part A preparation only: approve onto this stable dish ID (a new revision when it already
     * exists, so a reopened and re-verified draft keeps its diner identity) and require the
     * owner's persisted S11 verification. The public approve route never sets these.
     */
    preparedDishId?: string | undefined;
  },
): Promise<{ draft: DishDraftRow; publishedRevision: DishRevisionResult }> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await authorizeStaffVenue(client, actorId, venueId, true);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${options.commandId}`,
    ]);

    const expectedVersion = options.expectedVersion ?? 0;
    const approvalHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          draftId,
          expectedVersion,
          ...(options.expectedDraftVersion === undefined &&
          options.expectedReviewVersion === undefined &&
          options.extractionId === undefined
            ? {}
            : {
                approvalVersion: 2,
                expectedDraftVersion: options.expectedDraftVersion,
                ...(options.expectedReviewVersion === undefined
                  ? {}
                  : { expectedReviewVersion: options.expectedReviewVersion }),
                ...(options.extractionId === undefined
                  ? {}
                  : { extractionId: options.extractionId }),
                confirmed: options.confirmed ?? false,
              }),
          ...(options.preparedDishId === undefined
            ? {}
            : { preparedDishId: options.preparedDishId, requireVerified: true }),
        }),
      )
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

    const discovered = await client.query<{ job_id: string | null }>(
      'SELECT job_id FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2',
      [venueId, draftId],
    );
    let currentJob:
      | {
          status: string;
          active_review_extraction_id: string | null;
          result_storage_key: string | null;
          review_result_storage_key: string | null;
        }
      | undefined;
    if (discovered.rows[0]?.job_id) {
      currentJob = (
        await client.query(
          'SELECT status,active_review_extraction_id,result_storage_key,review_result_storage_key FROM app_private.menu_ingestion_jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE',
          [venueId, discovered.rows[0].job_id],
        )
      ).rows[0];
    }
    const draftRes = await client.query<DishDraftRow>(
      `SELECT * FROM app_private.dish_drafts
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [venueId, draftId],
    );
    const draft = draftRes.rows[0];
    if (!draft || draft.review_status !== 'pending' || draft.removed_at) {
      throw new IngestionError('draft_not_pending_or_not_found', 404);
    }
    if (options.preparedDishId !== undefined && draft.verification_status !== 'verified')
      throw new IngestionError('draft_not_verified', 409);

    const manual =
      draft.origin === 'manual' ? OwnerDishFieldsSchema.parse(draft.manual_fields) : null;
    let reviewed = false;
    let corrected: ReturnType<typeof CandidateCorrectedFieldsSchema.parse> = {};
    if (!manual) {
      const sessions = await client.query<{ extraction_id: string }>(
        'SELECT extraction_id FROM app_private.extraction_review_session WHERE tenant_id=$1 AND job_id=$2',
        [venueId, draft.job_id],
      );
      if (sessions.rows.length) {
        if (
          !options.extractionId ||
          !currentJob ||
          !['complete', 'incomplete'].includes(currentJob.status) ||
          currentJob.active_review_extraction_id !== options.extractionId ||
          !currentJob.result_storage_key ||
          currentJob.result_storage_key !== currentJob.review_result_storage_key ||
          !sessions.rows.some((session) => session.extraction_id === options.extractionId)
        )
          throw new IngestionError('draft_confirmation_required', 409);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `candidate-review:${venueId}:${options.extractionId}:${draft.candidate_id ?? draft.draft_id}`,
        ]);
        const reviews = await client.query<{
          version: number;
          review_status: string;
          corrected_fields: unknown;
          incomplete_fields: string[];
        }>(
          'SELECT version,review_status,corrected_fields,incomplete_fields FROM app_private.candidate_review_current WHERE tenant_id=$1 AND extraction_id=$2 AND candidate_id=$3 FOR SHARE',
          [venueId, options.extractionId, draft.candidate_id ?? draft.draft_id],
        );
        const review = reviews.rows[0];
        if (
          options.expectedReviewVersion !== (review?.version ?? 0) ||
          options.expectedDraftVersion !== draft.draft_version ||
          options.confirmed !== true
        )
          throw new IngestionError('draft_confirmation_required', 409);
        if (
          review &&
          (['rejected', 'incomplete'].includes(review.review_status) ||
            review.incomplete_fields.length > 0)
        )
          throw new IngestionError('draft_incomplete', 409);
        if (review) corrected = CandidateCorrectedFieldsSchema.parse(review.corrected_fields);
        reviewed = true;
      }
    }
    const resolved = { ...draft, ...corrected };
    if (
      manual &&
      (options.expectedDraftVersion !== draft.draft_version || options.confirmed !== true)
    ) {
      throw new IngestionError('draft_confirmation_required', 409);
    }
    if (manual) assertManualDraftReady(manual);
    if (!draft.name || corrected.allergens?.status === 'proposed') {
      throw new IngestionError('draft_incomplete', 409);
    }
    const approvedPhotoId = manual?.photoId ?? corrected.photo_id ?? null;
    const portionCalibration = manual ? manual.portionCalibration : corrected.portion_calibration;
    if (portionCalibration && !approvedPhotoId)
      throw new IngestionError('portion_calibration_mismatch', 409);
    if (approvedPhotoId) {
      const photo = await client.query<{ id: string; source_hash: string }>(
        'SELECT id,source_hash FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND id=$3',
        [venueId, draftId, approvedPhotoId],
      );
      if (photo.rowCount !== 1) throw new IngestionError('photo_not_found', 404);
      if (portionCalibration && photo.rows[0]?.source_hash !== portionCalibration.source_sha256)
        throw new IngestionError('portion_calibration_mismatch', 409);
    }

    const newDishId = options.preparedDishId ?? crypto.randomUUID();
    const revisionCommandId = crypto.randomUUID();
    // Match the reviewed people count when legacy work is approved directly from S10.
    // Resolution is recorded only in this new revision, never written back into old drafts.
    const servingCount = resolveServingCount(
      manual ? manual.servingCount : resolved.serving_count,
      manual ? manual.servingSize : corrected.serving_size,
      portionCalibration,
    );
    const facts = manual
      ? {
          ...(manual.portionCalibration !== undefined
            ? { portionCalibration: manual.portionCalibration }
            : {}),
          ...(manual.servingSize !== undefined ? { servingSize: manual.servingSize } : {}),
          ...(servingCount !== undefined ? { servingCount } : {}),
          category: manual.category,
          priceAmount: manual.priceAmount,
          priceCurrency: manual.priceCurrency,
          ingredients: manual.ingredients.status === 'confirmed' ? manual.ingredients.items : null,
          allergens: manual.allergens.status === 'confirmed' ? manual.allergens.items : null,
          ...(manual.dietary !== undefined ? { dietary: manual.dietary } : {}),
          photoId: manual.photoId,
        }
      : reviewed
        ? {
            ...(corrected.portion_calibration !== undefined
              ? { portionCalibration: corrected.portion_calibration }
              : {}),
            ...(corrected.serving_size !== undefined
              ? { servingSize: corrected.serving_size }
              : {}),
            ...(servingCount !== undefined ? { servingCount } : {}),
            category: resolved.category,
            priceAmount: resolved.price_amount,
            priceCurrency: resolved.price_currency,
            ingredients: resolved.ingredients,
            allergens:
              corrected.allergens?.status === 'confirmed' ? corrected.allergens.items : null,
            ...(corrected.dietary !== undefined ? { dietary: corrected.dietary } : {}),
            photoId: approvedPhotoId,
          }
        : undefined;
    const parsedFacts = facts === undefined ? undefined : ApprovedDishFactsSchema.safeParse(facts);
    if (parsedFacts && !parsedFacts.success) throw new IngestionError('draft_incomplete', 409);
    const revision = await createDishRevision(
      client,
      actorId,
      venueId,
      {
        commandId: revisionCommandId,
        dishId: newDishId,
        expectedVersion,
        name: corrected.name ?? draft.name,
        description: resolved.description ?? (manual || reviewed ? '' : draft.name),
        ...(parsedFacts?.success ? { facts: parsedFacts.data } : {}),
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

    const payload = JSON.stringify({
      draftId,
      expectedVersion,
      ...(options.expectedDraftVersion === undefined
        ? {}
        : { expectedDraftVersion: options.expectedDraftVersion }),
      ...(options.extractionId === undefined
        ? {}
        : {
            extractionId: options.extractionId,
            expectedReviewVersion: options.expectedReviewVersion,
          }),
      ...(options.confirmed ? { confirmed: true } : {}),
    });
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

const HSTS_HEADER_VALUE = 'max-age=2592000';

function isHttpsRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export function createApp(services: Dependencies = dependencies) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    const isProduction = c.env?.APP_ENV === 'production';
    const https = isHttpsRequest(c.req.raw);

    if (isProduction && !https) {
      const target = new URL(c.req.url);
      target.protocol = 'https:';
      return new Response(null, {
        status: 308,
        headers: {
          Location: target.toString(),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Request-ID': requestId,
        },
      });
    }

    c.header('X-Request-ID', requestId);
    await next();

    if (!c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Request-ID', requestId);
    if (isProduction && https) {
      c.header('Strict-Transport-Security', HSTS_HEADER_VALUE);
    }
  });
  registerOwnerAnalysisRoutes(app, {
    verify: services.verify,
    ...(services.readOwnerReport ? { readReport: services.readOwnerReport } : {}),
    allowedOrigins: CONSOLE_REPORT_CORS_ALLOWED_ORIGINS,
    allowedOrigin: ownerConsoleOrigin,
    syntheticVenues: SYNTHETIC_REPORT_VENUE_ALLOWLIST,
    ...(services.now ? { now: services.now } : {}),
  });
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'peekaplate-api',
      stage: 'foundation',
    } satisfies HealthResponse),
  );
  app.use(
    '/staff/venues',
    cors({
      origin: (origin, c) => ownerConsoleOrigin(origin, c.env),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400,
    }),
  );
  app.get('/staff/venues', async (c) => {
    const env = c.env ?? {};
    if (!ownerWorkflowAvailable(env)) return c.json({ error: 'not_found' }, 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actorId = await services.verify(authorization, env);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400);
    if (!services.readOwnerVenues) throw new AuthUnavailableError();
    const response = OwnerWorkspaceResponseSchema.safeParse({
      actorId,
      venues: await services.readOwnerVenues(actorId, env),
    });
    if (!response.success) throw new AuthUnavailableError();
    return c.json(response.data);
  });
  registerOwnerVenueCreation(app, {
    verify: services.verify,
    database: withDatabase,
    allowedOrigins: CONSOLE_REPORT_CORS_ALLOWED_ORIGINS,
    productionOrigin: PRODUCTION_OWNER_ORIGIN,
  });
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
  const artworkLimit = bodyLimit({
    maxSize: 1_350_000,
    onError: (c) => c.json({ error: 'body_too_large' }, 413),
  });
  app.use('/venues/*', async (c, next) => {
    if (c.req.method === 'POST' && /^\/venues\/[^/]+\/ingredient-icons\/review$/.test(c.req.path))
      return artworkLimit(c, next);
    if (
      c.req.method === 'PUT' &&
      /^\/venues\/[^/]+\/menus\/upload-groups\/[^/]+\/files\/[0-4]$/.test(c.req.path)
    )
      return next();
    if (
      c.req.method === 'POST' &&
      /^\/venues\/[^/]+\/(?:profile\/photos|menus\/uploads|drafts\/[^/]+\/photos)$/.test(c.req.path)
    )
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
  app.use('/venues/*', async (c, next) => {
    if (
      !/^\/venues\/[^/]+\/(?:profile(?:\/|$)|setup$|prepared-menus(?:\/|$)|ingredient-icons(?:\/|$)|menus\/(?:(?:uploads|upload-groups|url|jobs)(?:\/|$)|[^/]+\/(?:approvals|publications|withdrawals|diner-link)$)|drafts(?:\/|$)|extractions\/|dishes\/)/.test(
        c.req.path,
      )
    )
      return next();
    return cors({
      origin: (origin, context) => ownerConsoleOrigin(origin, context.env),
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      exposeHeaders: ['Location'],
      maxAge: 86400,
    })(c, next);
  });
  app.use(
    '/venues/:venueId/owner-insight-actions',
    cors({
      origin: (origin, c) => ownerConsoleOrigin(origin, c.env),
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Authorization'],
      maxAge: 86400,
    }),
  );
  registerOwnerMenuRoutes(app, {
    verify: services.verify,
    authorizeVenue: services.authorizeVenue ?? dependencies.authorizeVenue!,
    database: withDatabase,
  });
  registerDishAssistanceRoutes(app, {
    verify: services.verify,
    authorizeVenue: services.authorizeVenue ?? dependencies.authorizeVenue!,
    database: withDatabase,
    allowedOrigins: CONSOLE_REPORT_CORS_ALLOWED_ORIGINS,
    approvedVenues: SYNTHETIC_REPORT_VENUE_ALLOWLIST,
  });
  app.use(
    '/public/*',
    cors({
      origin: (origin, c) => allowedDinerOrigin(origin, c.env),
      allowMethods: ['GET', 'OPTIONS'],
      maxAge: 86400,
    }),
  );
  registerArtworkRoutes(app, {
    verify: services.verify,
    authorizeVenue: services.authorizeVenue ?? dependencies.authorizeVenue!,
    database: withDatabase,
  });
  app.get('/public/restaurants/:slug', async (c) => {
    const slug = RestaurantSlugSchema.safeParse(c.req.param('slug'));
    if (!slug.success) return c.json({ error: 'invalid_request' }, 400);
    if (!services.resolveRestaurantLink) throw new AuthUnavailableError();
    const scope = await services.resolveRestaurantLink(slug.data, c.env ?? {});
    return scope ? c.json(MenuScopeSchema.parse(scope)) : c.json({ error: 'not_found' }, 404);
  });
  // New public exposure requires the exact currently published snapshot, including its assets.
  app.get(`${PREPARED_BUNDLE_PATH}/:venueId/:menuId/:file`, async (c) => {
    const file = /^([0-9a-f-]{36})\.json$/i.exec(c.req.param('file'));
    const scope = MenuScopeSchema.safeParse({
      venueId: c.req.param('venueId'),
      menuId: c.req.param('menuId'),
    });
    const revision = VenueScopeSchema.safeParse({ venueId: file?.[1] });
    if (!scope.success || !revision.success) return c.json({ error: 'not_found' }, 404);
    if (!services.readPreparedBundle) throw new AuthUnavailableError();
    const bytes = await services.readPreparedBundle(
      scope.data.venueId,
      scope.data.menuId,
      revision.data.venueId,
      c.env ?? {},
    );
    if (!bytes) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.body(Uint8Array.from(bytes).buffer, 200, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  // Exact published Screen 5 logo (registered before the photo route).
  app.get(`${PREPARED_ASSET_PATH}/:venueId/logo/:file`, async (c) => {
    const venue = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    const file = /^([0-9a-f]{64})\.(png|jpg)$/.exec(c.req.param('file'));
    if (!venue.success || !file) return c.json({ error: 'not_found' }, 404);
    if (!services.readPreparedLogo) throw new AuthUnavailableError();
    const logo = await services.readPreparedLogo(
      venue.data.venueId,
      file[1]!,
      file[2]!,
      c.env ?? {},
    );
    if (!logo) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.body(Uint8Array.from(logo.bytes).buffer, 200, {
      'Content-Type': logo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  });
  app.get(`${PREPARED_ASSET_PATH}/:venueId/:photoId/:hash`, async (c) => {
    const venue = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    const photo = VenueScopeSchema.safeParse({ venueId: c.req.param('photoId') });
    const hash = c.req.param('hash');
    if (!venue.success || !photo.success || !/^[0-9a-f]{64}$/.test(hash))
      return c.json({ error: 'not_found' }, 404);
    if (!services.readPreparedAsset) throw new AuthUnavailableError();
    const asset = await services.readPreparedAsset(
      venue.data.venueId,
      photo.data.venueId,
      hash,
      c.env ?? {},
    );
    if (!asset) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.body(Uint8Array.from(asset.bytes).buffer, 200, {
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  });
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
      origin: (origin, c) => allowedDinerOrigin(origin, c.env),
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
  app.use(
    '/api/v1/venues/:venueId/analytics/dishes',
    cors({
      origin: (origin, c) => ownerConsoleOrigin(origin, c.env),
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Authorization'],
      exposeHeaders: [OWNER_REPORT_REFERENCE_HEADER],
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
    const source = ownerReportRequestSource(c.req.url, env);
    if (!source) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (
      source === 'synthetic' &&
      !configuredSyntheticReportVenues(env).includes(scope.data.venueId.toLowerCase())
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!services.readOwnerReport) throw new AuthUnavailableError();
    const now = services.now?.() ?? new Date();
    const venueId = scope.data.venueId.toLowerCase();
    const report = await services.readOwnerReport(actorId, venueId, now, env, source);
    c.header('Cache-Control', 'no-store');
    let responseReport = report;
    if (
      source === 'production' &&
      (env.OWNER_REPORT_DISPLAY_ACTIONS_ENABLED !== 'true' ||
        c.req.query('displayActions') !== 'true')
    ) {
      const legacy = OwnerDishReportSchema.parse(report);
      const missing = { value: null, status: 'MISSING' } as const;
      responseReport = {
        ...legacy,
        dishes: legacy.dishes.map(({ display_actions: _, ...dish }) => dish),
        ...(legacy.summary
          ? {
              summary: {
                ...legacy.summary,
                current: { ...legacy.summary.current, portion_previews_shown: missing },
                baseline: { ...legacy.summary.baseline, portion_previews_shown: missing },
              },
            }
          : {}),
      };
    }
    if (env.OWNER_AI_RESPONSES_ENABLED === 'true' && env.OWNER_AI_REPORT_REFERENCE_SECRET) {
      try {
        const parsedReport = OwnerDishReportSchema.parse(report);
        const reference = await mintOwnerReportReference(
          parsedReport,
          { actorId, venueId },
          env.OWNER_AI_REPORT_REFERENCE_SECRET,
          now,
        );
        c.header(OWNER_REPORT_REFERENCE_HEADER, reference);
      } catch {
        // The owner can still read the authorized report when its optional AI reference is unavailable.
      }
    }
    return c.json(responseReport);
  });
  app.use(
    '/api/v1/venues/:venueId/analytics/dishes/export',
    cors({
      origin: (origin, c) => ownerConsoleOrigin(origin, c.env),
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
    const source = ownerReportRequestSource(c.req.url, env);
    if (!source) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (
      source === 'synthetic' &&
      !configuredSyntheticReportVenues(env).includes(scope.data.venueId.toLowerCase())
    ) {
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (!services.readOwnerReport) throw new AuthUnavailableError();
    const report = await services.readOwnerReport(
      actorId,
      scope.data.venueId.toLowerCase(),
      services.now?.() ?? new Date(),
      env,
      source,
    );
    const typedReport = report as ExportableOwnerReport;
    const csv = serializeOwnerReportCsv(typedReport);
    const filename = buildOwnerReportExportFilename(
      typedReport.venue_id,
      typedReport.report_metadata.generated_at,
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
    includeDinerLink = false,
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
      if (includeDinerLink && services.readDinerLink) {
        const link = await services.readDinerLink(
          actorId,
          scope.data.venueId,
          scope.data.menuId,
          c.env ?? {},
        );
        if (link) c.header('Location', dinerLinkResponse(link, c.env ?? {}).url);
      }
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
    true,
  );
  publicationRoute(
    '/venues/:venueId/menus/:menuId/withdrawals',
    WithdrawMenuSchema,
    services.withdraw,
  );
  for (const path of [
    '/venues/:venueId/prepared-menus',
    '/venues/:venueId/prepared-menus/:menuId/:revisionId',
    '/venues/:venueId/prepared-menus/:menuId/:revisionId/assets/:assetId/:file',
  ]) {
    app.get(path, async (c) => {
      if (!ownerWorkflowAvailable(c.env)) return c.json({ error: 'not_found' }, 404);
      const authorization = c.req.header('Authorization');
      if (!authorization || !/^Bearer \S+$/i.test(authorization))
        return c.json({ error: 'unauthorized' }, 401);
      const actorId = await services.verify(authorization, c.env ?? {});
      const venue = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
      if (!venue.success || new URL(c.req.url).search)
        return c.json({ error: 'invalid_request' }, 400);
      if (!services.listPreparedMenus || !services.fetchPreparedMenu)
        throw new AuthUnavailableError();
      const menus = await services.listPreparedMenus(actorId, venue.data.venueId, c.env ?? {});
      const menuId = c.req.param('menuId');
      if (!menuId) return c.json(PreparedMenusSchema.parse({ menus }));
      const menu = menus.find(
        (row) => row.menuId === menuId && row.menuRevisionId === c.req.param('revisionId'),
      );
      if (!menu) return c.json({ error: 'not_found' }, 404);
      // The database connection/authorization transaction has ended before the bounded public fetch.
      const content = await services.fetchPreparedMenu(menu, fetch, ownHost(c, c.env ?? {}));
      const assetId = c.req.param('assetId');
      if (assetId) {
        if (!services.readPreparedPreviewAsset) throw new AuthUnavailableError();
        const asset = await services.readPreparedPreviewAsset(
          actorId,
          content,
          new URL(c.req.url).origin,
          assetId,
          c.req.param('file') ?? '',
          c.env ?? {},
        );
        if (!asset) return c.json({ error: 'not_found' }, 404);
        c.header('Cache-Control', 'no-store');
        return c.body(Uint8Array.from(asset.bytes).buffer, 200, {
          'Content-Type': asset.contentType,
          'X-Content-Type-Options': 'nosniff',
        });
      }
      return c.json(PreparedMenuPreviewSchema.parse({ menu, content }));
    });
  }
  // Part A: after S10/S11 verification the owner's verified dishes become a prepared menu for
  // S13. Owner-only (checked again inside the admit function); never approves or publishes.
  app.post('/venues/:venueId/prepared-menus/prepare', async (c) => {
    if (!ownerWorkflowAvailable(c.env)) return c.json({ error: 'not_found' }, 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actorId = await services.verify(authorization, c.env ?? {});
    const venue = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    if (!venue.success || new URL(c.req.url).search)
      return c.json({ error: 'invalid_request' }, 400);
    if (!services.prepareOwnerMenu) throw new AuthUnavailableError();
    const result = await services.prepareOwnerMenu(
      actorId,
      venue.data.venueId,
      new URL(c.req.url).origin,
      c.env ?? {},
    );
    return c.json(result);
  });
  app.get('/venues/:venueId/menus/:menuId/diner-link', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actorId = await services.verify(authorization, c.env ?? {});
    const scope = MenuScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);
    if (!services.readDinerLink) throw new AuthUnavailableError();
    const link = await services.readDinerLink(
      actorId,
      scope.data.venueId,
      scope.data.menuId,
      c.env ?? {},
    );
    return link
      ? c.json(dinerLinkResponse(link, c.env ?? {}))
      : c.json({ error: 'not_found' }, 404);
  });

  app.get('/venues/:venueId/owner-insight-actions', async (c) => {
    const env = c.env ?? {};
    if (env.APP_ENV === 'production' && !ownerWorkflowAvailable(env))
      return c.json({ error: 'not_found' }, 404);
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const actorId = await services.verify(authorization, env);
    const scope = VenueScopeSchema.safeParse(c.req.param());
    if (!scope.success) return c.json({ error: 'invalid_request' }, 400);

    const url = new URL(c.req.url);
    const params = url.searchParams;
    const query = OwnerInsightActionListQuerySchema.safeParse(Object.fromEntries(params.entries()));
    if (!query.success || [...params.keys()].length !== new Set(params.keys()).size) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!services.listOwnerActions) throw new AuthUnavailableError();

    const result = await services.listOwnerActions(actorId, scope.data.venueId, query.data, env);
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
    if (!ownerWorkflowAvailable(c.env)) return c.json({ error: 'not_found' }, 404);
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
    await validateMenuPdf(upload);
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

  app.post('/venues/:venueId/orders/agreement-acceptance', async (c) => {
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
    const parsed = AcceptPilotOrderAgreementRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const acceptFn =
      services.acceptPilotOrderAgreement ??
      (async (actorId, venueId, agreementVersion, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          return await acceptPilotOrderAgreementService({
            client,
            actorId,
            venueId,
            agreementVersion,
          });
        } finally {
          await client.end().catch(() => {});
        }
      });

    const result = await acceptFn(
      actorId,
      scope.data.venueId,
      parsed.data.agreementVersion,
      c.env ?? {},
    );
    return c.json(result, 200);
  });

  app.post('/venues/:venueId/orders/deletion-requests', async (c) => {
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
    const parsed = DeleteOrderDataRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const submitDeletionFn =
      services.submitOrderDataDeletionRequest ??
      (async (actorId, venueId, requestId, reason, env) => {
        const connectionString =
          env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
        if (!connectionString) throw new AuthUnavailableError();
        const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
        try {
          await client.connect();
          return await submitOrderDataDeletionRequestService({
            client,
            actorId,
            venueId,
            requestId,
            reason,
          });
        } finally {
          await client.end().catch(() => {});
        }
      });

    const result = await submitDeletionFn(
      actorId,
      scope.data.venueId,
      parsed.data.requestId,
      parsed.data.reason,
      c.env ?? {},
    );
    return c.json(result, 202);
  });

  app.post('/internal/venues/:venueId/orders/deletions/:requestId/verify', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const checkerId = await services.verify(authorization, c.env ?? {});
    const scope = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    const reqScope = DeleteOrderDataRequestSchema.safeParse({
      requestId: c.req.param('requestId'),
    });
    if (!scope.success || !reqScope.success) return c.json({ error: 'invalid_request' }, 400);

    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = VerifyOrderDeletionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const env = c.env ?? {};
    const authorizedCheckerIds = new Set(
      (env.AUTHORIZED_DELETION_CHECKER_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (!authorizedCheckerIds.has(checkerId)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    // Fail closed: never fall back to runtime HYPERDRIVE or LOCAL_DATABASE_URL
    const checkerConnectionString =
      env.APP_ENV === 'local'
        ? env.LOCAL_CHECKER_DATABASE_URL
        : env.CHECKER_HYPERDRIVE?.connectionString;
    if (!checkerConnectionString || !env.ORDER_DELETION_VERIFICATION_BUCKET) {
      return c.json({ error: 'verification_infrastructure_unavailable' }, 503);
    }

    const client = new Client({
      connectionString: checkerConnectionString,
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      const result = await verifyVenueOrderDeletionService({
        client,
        checkerId,
        venueId: scope.data.venueId,
        requestId: reqScope.data.requestId,
        outcome: parsed.data.outcome,
        evidenceRef: parsed.data.evidenceRef,
        verificationStorage: env.ORDER_DELETION_VERIFICATION_BUCKET,
        authorizedCheckerIds,
      });
      return c.json(result, 200);
    } finally {
      await client.end().catch(() => {});
    }
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
            environment: env.APP_ENV === 'production' ? 'production' : 'staging',
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
  return Object.assign(app, { queue, scheduled });
}

export {
  type ConsumerBindings,
  createObservationQueueHandler as createQueueHandler,
  OrderImportError,
  type QueueHandlerServices,
};

export function parseNonNegativeIntEnv(
  raw: string | undefined,
  errorCode: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(errorCode);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(errorCode);
  return value;
}

type ScheduledEnv = Omit<
  Bindings,
  'ORDER_OUTCOME_ARCHIVE_BUCKET' | 'ORDER_IMPORT_BUCKET' | 'INGESTION_REPORTS_BUCKET'
> & {
  ORDER_OUTCOME_ARCHIVE_BUCKET?: Partial<OrderOutcomeStorage> | undefined;
  ORDER_IMPORT_BUCKET?: Partial<OrderOutcomeStorage> | undefined;
  INGESTION_REPORTS_BUCKET?: Bindings['INGESTION_REPORTS_BUCKET'];
};

function hasListAndDelete<T extends { list?: unknown; delete?: unknown }>(
  storage: T | undefined,
): storage is T & {
  list: NonNullable<T['list']>;
  delete: NonNullable<T['delete']>;
} {
  return (
    storage !== undefined &&
    typeof storage.list === 'function' &&
    typeof storage.delete === 'function'
  );
}

function hasOrderMethods<T extends { put?: unknown; list?: unknown; delete?: unknown }>(
  storage: T | undefined,
): storage is T & {
  put: NonNullable<T['put']>;
  list: NonNullable<T['list']>;
  delete: NonNullable<T['delete']>;
} {
  return hasListAndDelete(storage) && typeof storage.put === 'function';
}

function hasStagingMethods<T extends { list?: unknown; delete?: unknown; get?: unknown }>(
  storage: T | undefined,
): storage is T & {
  list: NonNullable<T['list']>;
  delete: NonNullable<T['delete']>;
  get: NonNullable<T['get']>;
} {
  return hasListAndDelete(storage) && typeof storage.get === 'function';
}

export const handleScheduled = async (
  _event: unknown,
  env: ScheduledEnv,
  createClient: (connectionString: string) => Client = (connectionString) =>
    new Client({ connectionString, connectionTimeoutMillis: 5000 }),
) => {
  const orderStorage =
    env.ORDER_OUTCOME_ARCHIVE_BUCKET ?? env.ORDER_IMPORT_BUCKET ?? env.INGESTION_REPORTS_BUCKET;
  const stagingStorage = env.INGESTION_REPORTS_BUCKET;
  const artworkStorage = env.INGREDIENT_ARTWORK_BUCKET ?? env.INGESTION_REPORTS_BUCKET;

  const hasOrderStorage = hasListAndDelete(orderStorage);
  const hasStagingStorage = hasStagingMethods(stagingStorage);
  const stagingEnabled = [
    env.MENU_STAGING_RETENTION_DAYS,
    env.MENU_STAGING_REJECTED_RETENTION_DAYS,
    env.MENU_STAGING_ORPHAN_GRACE_DAYS,
  ].some((value) => value !== undefined);
  const hasArtworkStorage =
    env.INGREDIENT_ARTWORK_ENABLED === 'true' && hasListAndDelete(artworkStorage);

  if (!hasOrderStorage && !hasStagingStorage && !hasArtworkStorage) {
    return;
  }
  const connectionString =
    env.APP_ENV === 'local' ? env.LOCAL_DATABASE_URL : env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return;
  }

  const client = createClient(connectionString);
  try {
    await client.connect();

    if (hasOrderMethods(orderStorage)) {
      try {
        const rawCsvRetentionDays = env.ORDER_IMPORT_RETENTION_DAYS
          ? Number.parseInt(env.ORDER_IMPORT_RETENTION_DAYS, 10)
          : undefined;
        const orphanGracePeriodMs = env.ORDER_IMPORT_GRACE_PERIOD_MS
          ? Number.parseInt(env.ORDER_IMPORT_GRACE_PERIOD_MS, 10)
          : undefined;
        const result = await cleanupOrphanedOrderImports({
          storage: orderStorage,
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
      }
    }

    // L2: Durable retry queue for failed compensating R2 deletions
    if (hasListAndDelete(orderStorage)) {
      try {
        const tenantRes = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM app_private.list_pending_orphan_cleanup_tenants()`,
        );
        for (const row of tenantRes.rows) {
          try {
            const retryRes = await retryPendingOrphanCleanups({
              client,
              venueId: row.tenant_id,
              storage: orderStorage,
            });
            if (retryRes.attempted > 0 || retryRes.skippedDeletionActive) {
              console.log(
                JSON.stringify({
                  event: 'order_import_orphan_cleanup_retry',
                  venueId: row.tenant_id,
                  ...retryRes,
                }),
              );
            }
          } catch (retryVenueErr) {
            console.error(
              JSON.stringify({
                event: 'order_import_orphan_cleanup_retry_error',
                venueId: row.tenant_id,
                error:
                  retryVenueErr instanceof Error ? retryVenueErr.message : String(retryVenueErr),
              }),
            );
          }
        }
      } catch (listErr) {
        console.error(
          JSON.stringify({
            event: 'order_import_orphan_cleanup_tenant_list_error',
            error: listErr instanceof Error ? listErr.message : String(listErr),
          }),
        );
      }
    }

    if (stagingEnabled && hasStagingStorage) {
      try {
        const { cleanupStagedMenuPhotos } = await import('./owner-menu-retention');
        await cleanupStagedMenuPhotos({
          storage: {
            put: stagingStorage.put.bind(stagingStorage),
            get: stagingStorage.get.bind(stagingStorage),
            list: stagingStorage.list.bind(stagingStorage),
            delete: stagingStorage.delete.bind(stagingStorage),
          },
          client,
          retentionConfig: {
            promotedRetentionDays: parseNonNegativeIntEnv(
              env.MENU_STAGING_RETENTION_DAYS,
              'invalid_staging_retention',
            ),
            rejectedRetentionDays:
              parseNonNegativeIntEnv(
                env.MENU_STAGING_REJECTED_RETENTION_DAYS,
                'invalid_staging_retention',
              ) ?? 0,
            orphanGraceDays:
              parseNonNegativeIntEnv(
                env.MENU_STAGING_ORPHAN_GRACE_DAYS,
                'invalid_staging_retention',
              ) ?? 0,
          },
          dryRun: env.MENU_STAGING_CLEANUP_DRY_RUN === 'true',
        });
      } catch {
        console.error(JSON.stringify({ event: 'menu_staging_cleanup_error' }));
      }
    }

    if (hasArtworkStorage) {
      try {
        const { cleanupOrphanedIngredientArtwork } = await import('./ingredient-artwork-retention');
        const gracePeriodMs = parseNonNegativeIntEnv(
          env.INGREDIENT_ARTWORK_ORPHAN_GRACE_MS,
          'invalid_artwork_grace_period',
        );
        const artworkResult = await cleanupOrphanedIngredientArtwork({
          storage: artworkStorage,
          client,
          gracePeriodMs,
          dryRun: env.INGREDIENT_ARTWORK_CLEANUP_DRY_RUN === 'true',
        });
        if (artworkResult.deleted > 0 || artworkResult.errors > 0) {
          console.log(
            JSON.stringify({
              event: 'ingredient_artwork_cleanup',
              ...artworkResult,
            }),
          );
        }
      } catch {
        console.error(JSON.stringify({ event: 'ingredient_artwork_cleanup_error' }));
      }
    }
  } catch {
    console.error(JSON.stringify({ event: 'scheduled_database_connect_error' }));
  } finally {
    await client.end().catch(() => {});
  }
};

export const scheduled = (event: unknown, env: Bindings) => handleScheduled(event, env);

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
