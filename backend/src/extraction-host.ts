import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExtractionSource, readExtractionCapability } from './extraction-capability';

type Stub = { fetch(request: Request): Promise<Response> };
export type ExtractionHostEnv = {
  APP_ENV: string;
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
  'NARA_ROUTER_KEY',
  'NARA_ROUTER_URL',
  'NARA_ROUTER_MODEL',
  'a2agent_api_key',
  'a2agent_url',
  'a2agent_api_MODEL',
] as const;

export class ExtractionContainer extends DurableObject<ExtractionHostEnv> {
  envVars: Record<string, string>;
  private readiness: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: ExtractionHostEnv) {
    super(ctx, env);
    this.envVars = {
      EXTRACTION_SERVICE_SECRET: env.EXTRACTION_SERVICE_SECRET ?? '',
      EXTRACTION_SOURCE_ORIGIN: env.EXTRACTION_SOURCE_ORIGIN,
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

  async fetch(request: Request): Promise<Response> {
    this.readiness ??= this.waitForReady().finally(() => {
      this.readiness = undefined;
    });
    await this.readiness;
    // Retry only readiness probes; an extraction POST must be forwarded once.
    return this.ctx
      .container!.getTcpPort(8080)
      .fetch(new Request(`http://container${new URL(request.url).pathname}`, request));
  }
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sourcePath = new RegExp(`^/sources/(${uuid})/(${uuid})$`);
const json = (error: string, status: number) =>
  Response.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );

const maxBundleBytes = 32_000_000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  if (response.status !== 200) return response;
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
    privateResult.suggestions.some((value) => !record(value) || value.status !== 'unvalidated') ||
    !record(timings) ||
    timings.schema_version !== 1 ||
    timings.input_mode !== 'ocr_image' ||
    timings.status !== report.status ||
    !record(timings.timings_seconds)
  )
    throw new Error('Artifact scope or version mismatch');
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
    const secret = env.EXTRACTION_SERVICE_SECRET;
    const signingSecret = env.EXTRACTION_SOURCE_SIGNING_SECRET;
    if (
      env.APP_ENV !== 'staging' ||
      !secret ||
      secret.length < 48 ||
      !signingSecret ||
      signingSecret.length < 48 ||
      signingSecret === secret
    )
      return json('not_configured', 503);
    const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');
    const expected = new TextEncoder().encode(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json('unauthorized', 401);
    }
    const url = new URL(request.url);
    if (url.search) return json('invalid_request', 400);
    try {
      const source = sourcePath.exec(url.pathname);
      if (source && request.method === 'GET') {
        const scope = await readExtractionCapability(
          request.headers.get('x-source-capability') ?? '',
          signingSecret,
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
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(object.size),
            'Cache-Control': 'no-store',
          },
        });
      }
      if (
        (url.pathname === '/extract' && request.method === 'POST') ||
        (url.pathname === '/health' && request.method === 'GET')
      ) {
        if (url.pathname === '/extract') {
          const scope = await readExtractionCapability(
            request.headers.get('x-source-capability') ?? '',
            signingSecret,
          );
          if (
            !scope ||
            scope.tenantId !== request.headers.get('x-tenant-id') ||
            scope.jobId !== request.headers.get('x-job-id')
          )
            return json('forbidden', 403);
          const forwarded = new Request(request);
          forwarded.headers.set('X-Source-Hash', scope.sourceHash);
          forwarded.headers.set('X-Extraction-Artifact-Bundle', '1');
          const response = await env.EXTRACTOR.getByName('staging-extractor').fetch(forwarded);
          return await retainArtifacts(response, env, scope);
        }
        return await env.EXTRACTOR.getByName('staging-extractor').fetch(request);
      }
      return json('not_found', 404);
    } catch {
      return json('extraction_unavailable', 502);
    }
  },
};
