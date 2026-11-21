import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExtractionSource, readExtractionCapability } from './extraction-capability';

type Stub = { fetch(request: Request): Promise<Response> };
export type ExtractionHostEnv = {
  APP_ENV: string;
  EXTRACTION_PRODUCTION_ENABLED?: string;
  EXTRACTION_SERVICE_SECRET?: string;
  EXTRACTION_SOURCE_SIGNING_SECRET?: string;
  EXTRACTION_SOURCE_ORIGIN: string;
  EXTRACTOR: { getByName(name: string): Stub };
  SOURCE_BUCKET: {
    get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
    put(
      key: string,
      value: string,
      options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentType: string } },
    ): Promise<unknown | null>;
  };
} & Partial<Record<(typeof pipelineVariables)[number], string>>;

const pipelineVariables = [
  'OCR_SPACE_API_KEY',
  'MENU_AI_API_KEY',
  'MENU_AI_API_URL',
  'MENU_AI_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_URL',
  'GEMINI_MODEL',
  'OPENROUTER_API_KEY',
  'NARA_ROUTER_KEY',
  'NARA_ROUTER_URL',
  'NARA_ROUTER_MODEL',
  'a2agent_api_key',
  'a2agent_url',
  'a2agent_api_MODEL',
] as const;

export const MAX_PROVIDER_CALLS_PER_RUN = 2;

const budgetKeyPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const providerNamePattern = /^[A-Za-z0-9._-]{1,64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ExtractionContainer extends DurableObject<ExtractionHostEnv> {
  envVars: Record<string, string>;
  private readiness: Promise<void> | undefined;
  private budgetSchemaReady = false;

  constructor(ctx: DurableObjectState, env: ExtractionHostEnv) {
    super(ctx, env);
    this.envVars = {
      EXTRACTION_SERVICE_SECRET: env.EXTRACTION_SERVICE_SECRET ?? '',
      EXTRACTION_SOURCE_ORIGIN: env.EXTRACTION_SOURCE_ORIGIN,
      PORTION_REVIEW_ROOT: '/tmp/peekaplate-portions',
      U2NET_HOME: '/app/models',
      ...Object.fromEntries(
        pipelineVariables.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
      ),
    };
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(60_000));
    }
  }

  private async waitForReady(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('Extraction container is unavailable');
    if (!container.running) {
      const image = container.images.base;
      if (!image) throw new Error('Extraction image is unavailable');
      container.start({
        image,
        instance: 'standard-1',
        env: this.envVars,
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(60_000);
    const port = container.getTcpPort(8080);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await port.fetch('http://container/health', {
          headers: { Authorization: `Bearer ${this.envVars.EXTRACTION_SERVICE_SECRET}` },
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Running means the VM started; Uvicorn may still be opening its port.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Extraction container did not become ready');
  }

  private ensureBudgetSchema(): void {
    if (this.budgetSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS provider_call_budget (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        max_calls INTEGER NOT NULL,
        used_calls INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_call_reservations (
        reservation_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        granted INTEGER NOT NULL,
        used_calls INTEGER NOT NULL,
        max_calls INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private async handleBudgetReserve(request: Request): Promise<Response> {
    const tenantId = request.headers.get('x-tenant-id') ?? '';
    const jobId = request.headers.get('x-job-id') ?? '';
    if (!uuidPattern.test(tenantId) || !uuidPattern.test(jobId)) {
      return json('forbidden', 403);
    }
    const rawBody = await request.text();
    if (!rawBody || rawBody.length > 4096) {
      return json('invalid_request', 400);
    }
    let payload: { reservation_key?: unknown; provider?: unknown };
    try {
      payload = JSON.parse(rawBody) as { reservation_key?: unknown; provider?: unknown };
    } catch {
      return json('invalid_request', 400);
    }
    const reservationKey =
      typeof payload.reservation_key === 'string' ? payload.reservation_key : '';
    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    if (!budgetKeyPattern.test(reservationKey) || !providerNamePattern.test(provider)) {
      return json('invalid_request', 400);
    }
    const runId = `${tenantId}:${jobId}`;
    const outcome = this.ctx.storage.transactionSync(() => {
      this.ensureBudgetSchema();
      const existing = this.ctx.storage.sql
        .exec<{ run_id: string; granted: number; used_calls: number; max_calls: number }>(
          'SELECT run_id, granted, used_calls, max_calls FROM provider_call_reservations WHERE reservation_key = ?',
          reservationKey,
        )
        .toArray()[0];
      if (existing) {
        if (existing.run_id !== runId) {
          return { status: 403, body: { error: 'reservation_scope_mismatch' } };
        }
        return {
          status: existing.granted === 1 ? 200 : 429,
          body: {
            granted: existing.granted === 1,
            ...(existing.granted === 1 ? {} : { error: 'provider_call_budget_exhausted' }),
            run_id: runId,
            used_calls: existing.used_calls,
            max_calls: existing.max_calls,
            remaining_calls: Math.max(0, existing.max_calls - existing.used_calls),
            reservation_key: reservationKey,
          },
        };
      }
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO provider_call_budget (run_id, tenant_id, job_id, max_calls, used_calls, created_at) VALUES (?, ?, ?, ?, 0, ?)',
        runId,
        tenantId,
        jobId,
        MAX_PROVIDER_CALLS_PER_RUN,
        now,
      );
      const budget = this.ctx.storage.sql
        .exec<{ max_calls: number; used_calls: number }>(
          'SELECT max_calls, used_calls FROM provider_call_budget WHERE run_id = ?',
          runId,
        )
        .toArray()[0];
      if (!budget) {
        throw new Error('Failed to load provider call budget row');
      }
      if (budget.used_calls < budget.max_calls) {
        const nextUsed = budget.used_calls + 1;
        this.ctx.storage.sql.exec(
          'UPDATE provider_call_budget SET used_calls = ? WHERE run_id = ?',
          nextUsed,
          runId,
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO provider_call_reservations (reservation_key, run_id, provider, granted, used_calls, max_calls, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
          reservationKey,
          runId,
          provider,
          nextUsed,
          budget.max_calls,
          now,
        );
        return {
          status: 200,
          body: {
            granted: true,
            run_id: runId,
            used_calls: nextUsed,
            max_calls: budget.max_calls,
            remaining_calls: Math.max(0, budget.max_calls - nextUsed),
            reservation_key: reservationKey,
          },
        };
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO provider_call_reservations (reservation_key, run_id, provider, granted, used_calls, max_calls, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
        reservationKey,
        runId,
        provider,
        budget.used_calls,
        budget.max_calls,
        now,
      );
      return {
        status: 429,
        body: {
          granted: false,
          error: 'provider_call_budget_exhausted',
          run_id: runId,
          used_calls: budget.used_calls,
          max_calls: budget.max_calls,
          remaining_calls: 0,
          reservation_key: reservationKey,
        },
      };
    });
    this.budgetSchemaReady = true;
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/_budget/reserve' && request.method === 'POST') {
      return this.handleBudgetReserve(request);
    }
    this.readiness ??= this.waitForReady().finally(() => {
      this.readiness = undefined;
    });
    await this.readiness;
    // Retry only readiness probes; an extraction POST must be forwarded once.
    return this.ctx
      .container!.getTcpPort(8080)
      .fetch(new Request(`http://container${url.pathname}`, request));
  }
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sourcePath = new RegExp(`^/sources/(${uuid})/(${uuid})$`);
const portionPath = new RegExp(`^/v1/portion-uploads/(${uuid})/(${uuid})$`);
const json = (error: string, status: number) =>
  Response.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );

const maxBundleBytes = 32_000_000;
const maxPortionSourceBytes = 12_000_000;
const maxPortionResponseBytes = 300_000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readPortionBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function safeErrorResponse(response: Response): Promise<Response> {
  const status = response.status >= 400 && response.status < 600 ? response.status : 502;
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    headers.set('Retry-After', retryAfter);
  }

  let error = status === 429 ? 'busy' : status === 504 ? 'extraction_timeout' : 'extraction_failed';

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/json') && response.body) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (
        record(parsed) &&
        typeof parsed.error === 'string' &&
        /^[a-z0-9_-]{1,64}$/.test(parsed.error)
      ) {
        error = parsed.error;
      }
    } else {
      await response.body?.cancel();
    }
  } catch {
    await response.body?.cancel();
  }

  return Response.json({ error }, { status, headers });
}

async function readBundle(response: Response): Promise<unknown> {
  if (
    response.headers.get('x-extraction-artifact-bundle') !== '1' ||
    !response.headers.get('content-type')?.startsWith('application/json') ||
    Number(response.headers.get('content-length')) > maxBundleBytes ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('Invalid artifact transport');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBundleBytes) {
        await reader.cancel();
        throw new Error('Artifact bundle too large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join(''));
}

async function retainArtifacts(
  response: Response,
  env: ExtractionHostEnv,
  scope: ExtractionSource,
): Promise<Response> {
  if (response.status !== 200) {
    return await safeErrorResponse(response);
  }
  const bundle = await readBundle(response);
  if (!record(bundle) || bundle.schema_version !== 1 || Object.keys(bundle).length !== 4)
    throw new Error('Invalid artifact bundle');
  const report = bundle.report;
  const privateResult = bundle.review_suggestions;
  const timings = bundle.timings;
  if (
    !record(report) ||
    !record(report.source) ||
    !record(report.configuration) ||
    !(
      (report.schema_version === 1 && report.pipeline_version === '2') ||
      (report.schema_version === 2 && report.pipeline_version === '3')
    ) ||
    !['complete', 'incomplete', 'failed'].some((value) => value === report.status) ||
    !Array.isArray(report.drafts) ||
    !Array.isArray(report.evidence) ||
    report.source.sha256 !== scope.sourceHash ||
    report.source.source_id !== `sha256:${scope.sourceHash}` ||
    report.configuration.input_mode !== 'ocr_image' ||
    !record(privateResult) ||
    privateResult.schema_version !== 1 ||
    privateResult.source_id !== `sha256:${scope.sourceHash}` ||
    privateResult.input_mode !== 'ocr_image' ||
    !['complete', 'incomplete', 'failed'].some((value) => value === privateResult.status) ||
    !Array.isArray(privateResult.suggestions) ||
    (report.configuration.extraction_mode === 'vision_v4'
      ? privateResult.suggestions.length !== 0 || privateResult.status !== report.status
      : privateResult.suggestions.some(
          (value) => !record(value) || value.status !== 'unvalidated',
        )) ||
    !record(timings) ||
    timings.schema_version !== 1 ||
    timings.input_mode !== 'ocr_image' ||
    timings.status !== report.status ||
    !record(timings.timings_seconds)
  )
    throw new Error('Artifact scope or version mismatch');
  if (
    Buffer.byteLength(JSON.stringify(report), 'utf8') > 24_000_000 ||
    Buffer.byteLength(JSON.stringify(privateResult), 'utf8') > 8_000_000 ||
    Buffer.byteLength(JSON.stringify(timings), 'utf8') > 1_000_000
  )
    throw new Error('Artifact too large');
  const attemptId = crypto.randomUUID();
  const key = `menu-ingestion/review-artifacts/${scope.tenantId}/${scope.jobId}/${attemptId}/bundle.json`;
  const stored = JSON.stringify({
    ...bundle,
    scope: {
      tenant_id: scope.tenantId,
      job_id: scope.jobId,
      source_hash: scope.sourceHash,
      attempt_id: attemptId,
    },
  });
  if (Buffer.byteLength(stored, 'utf8') > maxBundleBytes)
    throw new Error('Artifact bundle too large');
  const digest = createHash('sha256').update(stored).digest('hex');
  report.configuration = {
    ...report.configuration,
    private_review_artifact: { schema_version: 1, key, sha256: digest },
  };
  const publicReport = JSON.stringify(report);
  if (Buffer.byteLength(publicReport, 'utf8') > 24_000_000) throw new Error('Report too large');
  const written = await env.SOURCE_BUCKET.put(key, stored, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!written) throw new Error('Private artifact retention failed');
  return new Response(publicReport, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: ExtractionHostEnv): Promise<Response> {
    const environment = env.APP_ENV;
    const secret = env.EXTRACTION_SERVICE_SECRET;
    const signingSecret = env.EXTRACTION_SOURCE_SIGNING_SECRET;
    if (
      (environment !== 'staging' &&
        !(environment === 'production' && env.EXTRACTION_PRODUCTION_ENABLED === 'true')) ||
      !secret ||
      secret.length < 48 ||
      !signingSecret ||
      signingSecret.length < 48 ||
      signingSecret === secret
    )
      return json('not_configured', 503);
    const containerName =
      environment === 'production' ? 'production-extractor' : 'staging-extractor';
    const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');
    const expected = new TextEncoder().encode(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json('unauthorized', 401);
    }
    const url = new URL(request.url);
    if (url.search) return json('invalid_request', 400);
    try {
      if (portionPath.test(url.pathname) && request.method === 'POST') {
        const signal = AbortSignal.timeout(220_000);
        if (
          !/^application\/octet-stream(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
        )
          return json('unsupported_media_type', 415);
        if (Number(request.headers.get('content-length')) > maxPortionSourceBytes)
          return json('request_too_large', 413);
        const photo = await readPortionBytes(request.body, maxPortionSourceBytes, signal);
        if (!photo) return json('request_too_large', 413);
        if (!photo.byteLength) return json('empty_photo', 400);
        const headers = new Headers(request.headers);
        headers.delete('Content-Length');
        const response = await env.EXTRACTOR.getByName(containerName).fetch(
          new Request(url, { method: 'POST', headers, body: photo, signal, redirect: 'manual' }),
        );
        const bytes = await readPortionBytes(response.body, maxPortionResponseBytes, signal);
        if (!bytes || !response.headers.get('content-type')?.startsWith('application/json'))
          return json('portion_unavailable', 502);
        const bounded = new Response(bytes, { status: response.status, headers: response.headers });
        if (!response.ok) return await safeErrorResponse(bounded);
        return new Response(bytes, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const source = sourcePath.exec(url.pathname);
      if (source && request.method === 'GET') {
        const scope = await readExtractionCapability(
          request.headers.get('x-source-capability') ?? '',
          signingSecret,
          undefined,
          environment,
        );
        if (
          !scope ||
          scope.tenantId !== source[1] ||
          scope.jobId !== source[2] ||
          scope.sourceHash !== request.headers.get('x-source-hash')
        )
          return json('forbidden', 403);
        // The job-bound grant is separate from service identity and never mintable by Python.
        const object = await env.SOURCE_BUCKET.get(
          `menu-ingestion/sources/${source[1]}/${source[2]}/source`,
        );
        if (!object) return json('not_found', 404);
        if (object.size <= 0 || object.size > 12_000_000) {
          await object.body.cancel();
          return json('source_too_large', 413);
        }
        const bytes = new Uint8Array(object.size);
        const hash = createHash('sha256');
        const reader = object.body.getReader();
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > object.size) {
              await reader.cancel();
              throw new Error('Source size mismatch');
            }
            bytes.set(value, size - value.byteLength);
            hash.update(value);
          }
        } finally {
          reader.releaseLock();
        }
        if (size !== object.size || hash.digest('hex') !== scope.sourceHash)
          throw new Error('Source integrity mismatch');
        return new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(object.size),
            'Cache-Control': 'no-store',
          },
        });
      }
      if (url.pathname === '/budget/reserve' && request.method === 'POST') {
        const scope = await readExtractionCapability(
          request.headers.get('x-source-capability') ?? '',
          signingSecret,
          undefined,
          environment,
        );
        if (
          !scope ||
          scope.tenantId !== request.headers.get('x-tenant-id') ||
          scope.jobId !== request.headers.get('x-job-id') ||
          scope.sourceHash !== request.headers.get('x-source-hash')
        )
          return json('forbidden', 403);
        const body = await request.text();
        return await env.EXTRACTOR.getByName(containerName).fetch(
          new Request('http://extractor/_budget/reserve', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-ID': scope.tenantId,
              'X-Job-ID': scope.jobId,
            },
            body,
          }),
        );
      }
      if (
        (url.pathname === '/extract' && request.method === 'POST') ||
        (url.pathname === '/health' && request.method === 'GET')
      ) {
        if (url.pathname === '/extract') {
          const scope = await readExtractionCapability(
            request.headers.get('x-source-capability') ?? '',
            signingSecret,
            undefined,
            environment,
          );
          if (
            !scope ||
            scope.tenantId !== request.headers.get('x-tenant-id') ||
            scope.jobId !== request.headers.get('x-job-id')
          )
            return json('forbidden', 403);
          const requestedBundle = request.headers.get('x-extraction-artifact-bundle');
          if (requestedBundle !== null && requestedBundle !== '1') {
            return json('invalid_request', 400);
          }
          const forwarded = new Request(request);
          forwarded.headers.set('X-Source-Hash', scope.sourceHash);
          forwarded.headers.set('X-Extraction-Artifact-Bundle', '1');
          const response = await env.EXTRACTOR.getByName(containerName).fetch(forwarded);
          return await retainArtifacts(response, env, scope);
        }
        return await env.EXTRACTOR.getByName(containerName).fetch(request);
      }
      return json('not_found', 404);
    } catch {
      return json('extraction_unavailable', 502);
    }
  },
};
