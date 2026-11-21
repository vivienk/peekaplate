import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { mintExtractionCapability } from './extraction-capability';
import host, { ExtractionContainer, type ExtractionHostEnv } from './extraction-host';

const secret = 'synthetic-host-test-'.repeat(4);
const tenant = '00000000-0000-4000-8000-000000000002';
const job = '00000000-0000-4000-8000-000000000001';
const signingSecret = 'synthetic-job-signing-key-'.repeat(3);
let capability = '';
beforeAll(async () => {
  capability = await mintExtractionCapability(
    { tenantId: tenant, jobId: job, sourceHash: 'a'.repeat(64) },
    signingSecret,
  );
});
type TestReport = {
  schema_version: number;
  pipeline_version: string;
  status: 'complete' | 'incomplete' | 'failed';
  source: { source_id: string; sha256: string };
  configuration: {
    input_mode: string;
    extraction_mode?: string;
    private_review_artifact?: { schema_version: number; key: string; sha256: string };
    [key: string]: unknown;
  };
  drafts: unknown[];
  evidence: unknown[];
  segments: Array<{
    segment_id: string;
    page_number: number;
    method: string;
    status: string;
    text: string;
    metadata?: Record<string, unknown>;
  }>;
};

type TestReviewSuggestion = {
  status: string;
  original: Record<string, unknown>;
  [key: string]: unknown;
};

type TestReviewSuggestions = {
  schema_version: number;
  source_id: string;
  input_mode: string;
  status: string;
  suggestions: TestReviewSuggestion[];
};

type TestTimings = {
  schema_version: number;
  input_mode: string;
  status: string;
  timings_seconds: Record<string, unknown>;
};

type TestBundle = {
  schema_version: number;
  report: TestReport;
  review_suggestions: TestReviewSuggestions;
  timings: TestTimings;
  vision_attempts?: unknown;
};

function artifactBundle(): TestBundle {
  return {
    schema_version: 1,
    report: {
      schema_version: 2,
      pipeline_version: '3',
      status: 'incomplete',
      source: { source_id: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64) },
      configuration: { input_mode: 'ocr_image' },
      drafts: [],
      evidence: [],
      segments: [],
    },
    review_suggestions: {
      schema_version: 1,
      source_id: `sha256:${'a'.repeat(64)}`,
      input_mode: 'ocr_image',
      status: 'complete',
      suggestions: [{ status: 'unvalidated', original: { name: 'PRIVATE_REJECTED_VALUE' } }],
    },
    timings: {
      schema_version: 1,
      input_mode: 'ocr_image',
      status: 'incomplete',
      timings_seconds: { total: 42.5 },
    },
  };
}
function visionBundle(status: 'complete' | 'incomplete' | 'failed' = 'incomplete'): TestBundle {
  return {
    schema_version: 1,
    report: {
      schema_version: 2,
      pipeline_version: '3',
      status,
      source: { source_id: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64) },
      configuration: {
        input_mode: 'ocr_image',
        extraction_mode: 'vision_v4',
      },
      drafts: [],
      evidence: [],
      segments: [
        {
          segment_id: `sha256:${'a'.repeat(64)}#page-1`,
          page_number: 1,
          method: 'text',
          status: 'ready',
          text: 'Garden Salad - 8.50 CAD',
          metadata: {
            vision_boxes: [
              {
                box_2d: [100, 200, 300, 400],
                label: 'dish',
              },
            ],
          },
        },
      ],
    },
    review_suggestions: {
      schema_version: 1,
      source_id: `sha256:${'a'.repeat(64)}`,
      input_mode: 'ocr_image',
      status,
      suggestions: [],
    },
    timings: {
      schema_version: 1,
      input_mode: 'ocr_image',
      status,
      timings_seconds: { total: 15.2 },
    },
  };
}
function visionBundleResponse(value: unknown = visionBundle()) {
  return Response.json(value, { headers: { 'X-Extraction-Artifact-Bundle': '1' } });
}
function bundleResponse(value: unknown = artifactBundle()) {
  return Response.json(value, { headers: { 'X-Extraction-Artifact-Bundle': '1' } });
}
function setup() {
  const forward = vi.fn(async (_request: Request) => bundleResponse());
  const get = vi.fn(async () => ({ size: 3, body: new Blob(['pdf']).stream() }));
  const put = vi.fn(
    async (_key: string, _value: string, _options: unknown): Promise<{ etag: string } | null> => ({
      etag: 'synthetic',
    }),
  );
  const env: ExtractionHostEnv = {
    APP_ENV: 'staging',
    EXTRACTION_SERVICE_SECRET: secret,
    EXTRACTION_SOURCE_SIGNING_SECRET: signingSecret,
    EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
    EXTRACTOR: { getByName: vi.fn(() => ({ fetch: forward })) },
    SOURCE_BUCKET: { get, put },
  };
  const request = (
    path: string,
    token = secret,
    method = 'GET',
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://host.invalid${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Source-Capability': capability,
        'X-Source-Hash': 'a'.repeat(64),
        'X-Tenant-ID': tenant,
        'X-Job-ID': job,
        ...headers,
      },
    });
  return { env, get, put, forward, request };
}

function runtime(running = false, overrides: Partial<ExtractionHostEnv> = {}) {
  const env = { ...setup().env, ...overrides };
  const fetch = vi.fn(async (_input: string | Request, _init?: RequestInit) =>
    Response.json({ status: 'ok' }),
  );
  const container = {
    running,
    images: { base: 'registry.cloudflare.com/synthetic@sha256:abc' },
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: vi.fn(() => ({ fetch })),
  };
  const ctx = {
    container,
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<void>) => callback()),
  };
  const actor = new ExtractionContainer(ctx as unknown as DurableObjectState, env);
  return { actor, container, fetch, ctx };
}

describe('production extraction host', () => {
  it('requires activation and credentials before reaching the separate production container', async () => {
    const { env, request, forward } = setup();
    env.APP_ENV = 'production';
    expect((await host.fetch(request('/health'), env)).status).toBe(503);
    env.EXTRACTION_PRODUCTION_ENABLED = 'true';
    expect((await host.fetch(request('/health', 'wrong-test-key'), env)).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
    expect((await host.fetch(request('/health'), env)).status).toBe(200);
    expect(env.EXTRACTOR.getByName).toHaveBeenCalledWith('production-extractor');
  });
});

describe('direct Container startup', () => {
  afterEach(() => vi.useRealTimers());

  it('starts the named image with scoped environment and preserves a POST exactly once', async () => {
    const { actor, container, fetch } = runtime();
    const response = await actor.fetch(
      new Request('https://host.invalid/extract', { method: 'POST', body: 'synthetic' }),
    );
    expect(response.status).toBe(200);
    expect(container.start).toHaveBeenCalledWith({
      image: container.images.base,
      instance: 'standard-1',
      enableInternet: true,
      env: {
        EXTRACTION_SERVICE_SECRET: secret,
        EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
        PORTION_REVIEW_ROOT: '/tmp/peekaplate-portions',
        U2NET_HOME: '/app/models',
      },
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(60_000);
    expect(container.getTcpPort).toHaveBeenCalledWith(8080);
    const forwarded = fetch.mock.calls[1]?.[0] as unknown as Request;
    expect(forwarded.url).toBe('http://container/extract');
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('synthetic');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forwards only configured provider settings without logging credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const settings = {
        GEMINI_API_KEY: 'synthetic-gemini-key',
        GOOGLE_AI_API_KEY: 'synthetic-google-ai-key',
        GOOGLE_API_KEY: 'synthetic-google-key',
        GEMINI_API_URL: 'https://gemini.example.test/v1',
        GEMINI_MODEL: 'synthetic-gemini-model',
        OPENROUTER_API_KEY: 'synthetic-openrouter-key',
        MENU_AI_API_KEY: 'synthetic-generic-key',
        MENU_AI_API_URL: 'https://router.example.test/v1',
        MENU_AI_MODEL: 'synthetic-router-model',
        NARA_ROUTER_KEY: 'synthetic-nara-key',
        NARA_ROUTER_URL: 'https://nara.example.test/v1',
        NARA_ROUTER_MODEL: 'synthetic-nara-model',
        OCR_SPACE_API_KEY: 'synthetic-ocr-key',
        a2agent_api_key: 'synthetic-legacy-key',
        a2agent_url: 'https://legacy.example.test/v1',
        a2agent_api_MODEL: 'synthetic-legacy-model',
      };
      const { actor, container } = runtime(false, {
        ...settings,
        UNRELATED_SECRET: 'synthetic-unrelated-secret',
      } as Partial<ExtractionHostEnv>);
      await actor.fetch(new Request('https://host.invalid/health'));
      expect(container.start).toHaveBeenCalledWith({
        image: container.images.base,
        instance: 'standard-1',
        enableInternet: true,
        env: {
          EXTRACTION_SERVICE_SECRET: secret,
          EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
          PORTION_REVIEW_ROOT: '/tmp/peekaplate-portions',
          U2NET_HOME: '/app/models',
          ...settings,
        },
      });
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('omits unset or empty named provider settings', async () => {
    const { actor, container } = runtime(false, { GEMINI_API_KEY: '', OPENROUTER_API_KEY: '' });
    await actor.fetch(new Request('https://host.invalid/health'));
    expect(container.start).toHaveBeenCalledWith({
      image: container.images.base,
      instance: 'standard-1',
      enableInternet: true,
      env: {
        EXTRACTION_SERVICE_SECRET: secret,
        EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
        PORTION_REVIEW_ROOT: '/tmp/peekaplate-portions',
        U2NET_HOME: '/app/models',
      },
    });
  });

  it('retries readiness, never the extraction POST', async () => {
    vi.useFakeTimers();
    const { actor, fetch } = runtime();
    fetch
      .mockRejectedValueOnce(new Error('port opening'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const pending = actor.fetch(
      new Request('https://host.invalid/extract', { method: 'POST', body: '{}' }),
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      fetch.mock.calls.filter(([value]) => value instanceof Request && value.method === 'POST'),
    ).toHaveLength(1);
  });

  it('shares cold readiness between concurrent requests and restores idle timeout after restart', async () => {
    const { actor, container, fetch } = runtime();
    let ready!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          ready = resolve;
        }),
    );
    const requests = [
      actor.fetch(new Request('https://host.invalid/health')),
      actor.fetch(new Request('https://host.invalid/health')),
    ];
    await Promise.resolve();
    await Promise.resolve();
    ready(Response.json({ status: 'ok' }));
    expect((await Promise.all(requests)).every((response) => response.ok)).toBe(true);
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    const restarted = runtime(true);
    expect(restarted.ctx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    expect(restarted.container.setInactivityTimeout).toHaveBeenCalledWith(60_000);
    expect(restarted.container.start).not.toHaveBeenCalled();
  });

  it('bounds readiness failure and permits a later request to recover', async () => {
    vi.useFakeTimers();
    const { actor, fetch } = runtime();
    fetch.mockRejectedValue(new Error('not ready'));
    const pending = expect(actor.fetch(new Request('https://host.invalid/health'))).rejects.toThrow(
      'did not become ready',
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await pending;
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(61);
    fetch.mockResolvedValue(Response.json({ status: 'ok' }));
    expect((await actor.fetch(new Request('https://host.invalid/health'))).status).toBe(200);
  });
});

describe('staging extraction host', () => {
  it('forwards a bounded private photo once through the existing authenticated container', async () => {
    const { env, forward, get, put } = setup();
    const path = `/v1/portion-uploads/${tenant}/${job}`;
    forward.mockResolvedValueOnce(Response.json({ status: 'ready', publication_eligible: false }));
    const response = await host.fetch(
      new Request(`https://host.invalid${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/octet-stream' },
        body: 'synthetic-photo',
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ready', publication_eligible: false });
    expect(env.EXTRACTOR.getByName).toHaveBeenCalledWith('staging-extractor');
    expect(forward).toHaveBeenCalledOnce();
    const forwarded = forward.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe(path);
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(forwarded.redirect).toBe('manual');
    expect(await forwarded.text()).toBe('synthetic-photo');
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects unsupported portion paths, methods, credentials and request byte sizes before forwarding', async () => {
    const { env, forward } = setup();
    const path = `/v1/portion-uploads/${tenant}/${job}`;
    for (const [suffix, method, token, body, contentType, status] of [
      ['', 'GET', secret, undefined, 'application/octet-stream', 404],
      ['/extra', 'POST', secret, 'photo', 'application/octet-stream', 404],
      ['?other=1', 'POST', secret, 'photo', 'application/octet-stream', 400],
      ['', 'POST', 'wrong', 'photo', 'application/octet-stream', 401],
      ['', 'POST', secret, 'photo', 'text/plain', 415],
      ['', 'POST', secret, '', 'application/octet-stream', 400],
      ['', 'POST', secret, new Uint8Array(12_000_001), 'application/octet-stream', 413],
    ] as const) {
      const response = await host.fetch(
        new Request(`https://host.invalid${path}${suffix}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          ...(body !== undefined ? { body } : {}),
        }),
        env,
      );
      expect(response.status).toBe(status);
    }
    expect(
      (
        await host.fetch(
          new Request('https://host.invalid/v1/portion-uploads/invalid/invalid', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
            body: 'photo',
          }),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await host.fetch(
          new Request(`https://host.invalid${path}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secret}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': '12000001',
            },
            body: 'photo',
          }),
          env,
        )
      ).status,
    ).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it('bounds portion response bytes and sanitizes processor failures', async () => {
    const { env, forward } = setup();
    const request = () =>
      new Request(`https://host.invalid/v1/portion-uploads/${tenant}/${job}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/octet-stream' },
        body: 'photo',
      });
    forward.mockResolvedValueOnce(
      new Response('x'.repeat(300_001), { headers: { 'Content-Type': 'application/json' } }),
    );
    expect((await host.fetch(request(), env)).status).toBe(502);
    forward.mockResolvedValueOnce(
      Response.json({ error: 'photo_processing_failed', private: 'not exposed' }, { status: 422 }),
    );
    const failed = await host.fetch(request(), env);
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ error: 'photo_processing_failed' });
    forward.mockResolvedValueOnce(new Response('not JSON'));
    expect((await host.fetch(request(), env)).status).toBe(502);
  });

  it('cancels a stalled portion response under the complete 220-second deadline', async () => {
    const { env, forward } = setup();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancel = vi.fn();
    try {
      forward.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const response = host.fetch(
        new Request(`https://host.invalid/v1/portion-uploads/${tenant}/${job}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/octet-stream',
          },
          body: 'photo',
        }),
        env,
      );
      await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());
      controller.abort();
      expect((await response).status).toBe(502);
      expect(timeout).toHaveBeenCalledWith(220_000);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it('denies a valid service credential and job-A capability requesting another valid job', async () => {
    const { env, get, request } = setup();
    const otherJob = '00000000-0000-4000-8000-000000000003';
    expect((await host.fetch(request(`/sources/${tenant}/${otherJob}`), env)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects missing, tampered, expired and different-hash grants before R2 access', async () => {
    const { env, get, request } = setup();
    const expired = await mintExtractionCapability(
      { tenantId: tenant, jobId: job, sourceHash: 'a'.repeat(64) },
      signingSecret,
      Date.now() - 1_000_000,
    );
    for (const token of ['', capability + 'tampered', expired]) {
      const input = request(`/sources/${tenant}/${job}`);
      input.headers.set('X-Source-Capability', token);
      expect((await host.fetch(input, env)).status).toBe(403);
    }
    const input = request(`/sources/${tenant}/${job}`);
    input.headers.set('X-Source-Hash', 'b'.repeat(64));
    expect((await host.fetch(input, env)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });
  it('forwards the OCR key to Python while keeping the source signing key out', () => {
    const { env } = setup();
    env.OCR_SPACE_API_KEY = 'synthetic-ocr-provider-key';
    const container = new ExtractionContainer(
      {} as ConstructorParameters<typeof ExtractionContainer>[0],
      env,
    );
    expect(container.envVars.EXTRACTION_SERVICE_SECRET).toBe(secret);
    expect(container.envVars.OCR_SPACE_API_KEY).toBe('synthetic-ocr-provider-key');
    expect(container.envVars.EXTRACTION_SOURCE_SIGNING_SECRET).toBeUndefined();
  });
  it('requires distinct service and source-signing credentials', async () => {
    const { env, get, request } = setup();
    expect(
      (await host.fetch(request('/health'), { ...env, EXTRACTION_SOURCE_SIGNING_SECRET: secret }))
        .status,
    ).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });
  it('denies missing/invalid credentials before touching R2 or starting a container', async () => {
    const { env, get, forward, request } = setup();
    expect((await host.fetch(request('/extract', 'wrong', 'POST'), env)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
  it('verifies the scoped source bytes before returning them without caching', async () => {
    const { env, get, forward, request } = setup();
    const sourceHash = createHash('sha256').update('pdf').digest('hex');
    const input = request(`/sources/${tenant}/${job}`);
    input.headers.set('X-Source-Hash', sourceHash);
    input.headers.set(
      'X-Source-Capability',
      await mintExtractionCapability({ tenantId: tenant, jobId: job, sourceHash }, signingSecret),
    );
    const response = await host.fetch(input, env);
    expect(get).toHaveBeenCalledWith(`menu-ingestion/sources/${tenant}/${job}/source`);
    expect(await response.text()).toBe('pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe('3');
    expect(forward).not.toHaveBeenCalled();
  });
  it('rejects source bytes that do not match the authorized digest or declared size', async () => {
    const { env, get, request } = setup();
    expect((await host.fetch(request(`/sources/${tenant}/${job}`), env)).status).toBe(502);
    const sourceHash = createHash('sha256').update('pdf').digest('hex');
    const input = request(`/sources/${tenant}/${job}`);
    input.headers.set('X-Source-Hash', sourceHash);
    input.headers.set(
      'X-Source-Capability',
      await mintExtractionCapability({ tenantId: tenant, jobId: job, sourceHash }, signingSecret),
    );
    get.mockResolvedValueOnce({ size: 4, body: new Blob(['pdf']).stream() });
    expect((await host.fetch(input, env)).status).toBe(502);
  });
  it('does not accept arbitrary source keys, queries or methods', async () => {
    const { env, get, request } = setup();
    for (const path of ['/sources/other/file', `/sources/${tenant}/${job}?key=other`]) {
      expect((await host.fetch(request(path), env)).status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await host.fetch(request(`/sources/${tenant}/${job}`, secret, 'POST'), env)).status,
    ).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
  it('uses one fixed container name for authenticated extraction', async () => {
    const { env, forward, request } = setup();
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    expect(env.EXTRACTOR.getByName).toHaveBeenCalledWith('staging-extractor');
    expect(forward).toHaveBeenCalledOnce();
  });
  it('retains the private bundle before returning only the existing report shape', async () => {
    const { env, put, forward, request } = setup();
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledOnce();
    const [key, content, options] = put.mock.calls[0] ?? [];
    expect(key).toMatch(
      new RegExp(`^menu-ingestion/review-artifacts/${tenant}/${job}/[0-9a-f-]+/bundle.json$`),
    );
    expect(options).toMatchObject({ onlyIf: { etagDoesNotMatch: '*' } });
    const stored = JSON.parse(content ?? '{}');
    expect(stored.review_suggestions.suggestions[0].original.name).toBe('PRIVATE_REJECTED_VALUE');
    expect(stored.timings.timings_seconds.total).toBe(42.5);
    expect(stored.scope).toMatchObject({
      tenant_id: tenant,
      job_id: job,
      source_hash: 'a'.repeat(64),
    });
    const result = (await response.json()) as TestReport & {
      configuration: { private_review_artifact: { key: string; sha256: string } };
    };
    expect(result.configuration.private_review_artifact.key).toBe(key);
    expect(result.configuration.private_review_artifact.sha256).toBe(
      createHash('sha256')
        .update(content ?? '')
        .digest('hex'),
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REJECTED_VALUE');
    expect(result).not.toHaveProperty('review_suggestions');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(forward.mock.calls[0]?.[0].headers.get('x-extraction-artifact-bundle')).toBe('1');
  });
  it('uses a new create-only attempt key for each repeat without overwriting history', async () => {
    const { env, put, request } = setup();
    for (let index = 0; index < 2; index++) {
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    }
    expect(put.mock.calls[0]?.[0]).not.toBe(put.mock.calls[1]?.[0]);
  });
  it('does not return success if private R2 retention fails', async () => {
    const { env, put, request } = setup();
    put.mockRejectedValue(new Error('synthetic-storage-secret'));
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('synthetic-storage-secret');
  });
  it('preserves configuration.extraction_mode and segment.metadata.vision_boxes across V1 roundtrip', async () => {
    const { env, put, forward, request } = setup();
    const bundle = visionBundle('incomplete');
    forward.mockImplementationOnce(async () => visionBundleResponse(bundle));
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledOnce();
    const [key, content] = put.mock.calls[0] ?? [];
    const stored = JSON.parse(content ?? '{}');
    expect(stored.schema_version).toBe(1);
    expect(Object.keys(stored).filter((k) => k !== 'scope')).toHaveLength(4);
    expect(stored.report.configuration.extraction_mode).toBe('vision_v4');
    expect(stored.report.configuration.input_mode).toBe('ocr_image');
    expect(stored.review_suggestions.suggestions).toEqual([]);
    expect(stored.review_suggestions.status).toBe('incomplete');
    expect(stored.timings.input_mode).toBe('ocr_image');
    expect(stored).not.toHaveProperty('vision_attempts');

    const result = (await response.json()) as TestReport & {
      configuration: { private_review_artifact: { key: string; sha256: string } };
    };
    expect(result.configuration.extraction_mode).toBe('vision_v4');
    expect(result.configuration.input_mode).toBe('ocr_image');
    expect(result.configuration.private_review_artifact.key).toBe(key);
    expect(result.segments?.[0]?.metadata).toEqual({
      vision_boxes: [{ box_2d: [100, 200, 300, 400], label: 'dish' }],
    });
    expect(result).not.toHaveProperty('review_suggestions');
    expect(forward.mock.calls[0]?.[0].headers.get('x-extraction-artifact-bundle')).toBe('1');
  });

  it('retains genuine OCR review suggestions for legacy and fallback OCR', async () => {
    const { env, put, forward, request } = setup();
    const bundle = artifactBundle();
    forward.mockImplementationOnce(async () => bundleResponse(bundle));
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledOnce();
    const stored = JSON.parse(put.mock.calls[0]?.[1] ?? '{}');
    expect(stored.schema_version).toBe(1);
    expect(stored.review_suggestions.suggestions).toHaveLength(1);
    expect(stored.review_suggestions.suggestions[0]?.original.name).toBe('PRIVATE_REJECTED_VALUE');
    const result = (await response.json()) as typeof bundle.report;
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REJECTED_VALUE');
    expect(result).not.toHaveProperty('review_suggestions');
  });

  it('rejects malformed, null, or inconsistent review suggestions and modes', async () => {
    const { env, put, forward, request } = setup();
    const mutations: Array<(bundle: TestBundle) => void> = [
      (b) => {
        b.review_suggestions.suggestions = [{ status: 'unvalidated', original: { name: 'Fake' } }];
      },
      (b) => {
        Object.assign(b, { review_suggestions: null });
      },
      (b) => {
        b.review_suggestions.status = 'complete';
      },
      (b) => {
        b.review_suggestions.source_id = `sha256:${'b'.repeat(64)}`;
      },
      (b) => {
        b.review_suggestions.schema_version = 2;
      },
      (b) => {
        b.review_suggestions.input_mode = 'vision_v4';
      },
      (b) => {
        b.report.configuration.input_mode = 'vision_v4';
      },
      (b) => {
        b.timings.status = 'complete';
      },
      (b) => {
        b.timings.input_mode = 'vision_v4';
      },
      (b) => {
        Object.assign(b, { vision_attempts: {} });
      },
      (b) => {
        b.schema_version = 2;
      },
    ];
    for (const mutate of mutations) {
      const bundle = visionBundle();
      mutate(bundle);
      forward.mockImplementationOnce(async () => bundleResponse(bundle));
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    }
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects client request for V2 bundle and enforces V1 negotiation', async () => {
    const { env, put, forward, request } = setup();
    const badRequest = request('/extract', secret, 'POST', {
      'X-Extraction-Artifact-Bundle': '2',
    });
    expect((await host.fetch(badRequest, env)).status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    const goodRequest = request('/extract', secret, 'POST');
    forward.mockImplementationOnce(async () => bundleResponse());
    expect((await host.fetch(goodRequest, env)).status).toBe(200);
    expect(forward.mock.calls[0]?.[0].headers.get('x-extraction-artifact-bundle')).toBe('1');
  });

  it('enforces independent private artifact size limits', async () => {
    const { env, put, forward, request } = setup();
    const suggestions = artifactBundle();
    suggestions.review_suggestions.suggestions[0]!.original.name = 'x'.repeat(8_000_001);
    forward.mockImplementationOnce(async () => bundleResponse(suggestions));
    const timing = artifactBundle();
    Object.assign(timing.timings.timings_seconds, { oversized: 'x'.repeat(1_000_001) });
    forward.mockImplementationOnce(async () => bundleResponse(timing));
    for (let i = 0; i < 2; i++)
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects missing, mismatched and cross-source bundles without writing R2', async () => {
    const { env, put, forward, request } = setup();
    for (const changed of ['version', 'source', 'private-source', 'mode', 'missing-timing']) {
      const value = artifactBundle();
      if (changed === 'version') value.schema_version = 9;
      if (changed === 'source') value.report.source.sha256 = 'b'.repeat(64);
      if (changed === 'private-source')
        value.review_suggestions.source_id = `sha256:${'b'.repeat(64)}`;
      if (changed === 'mode') value.review_suggestions.input_mode = 'image';
      if (changed === 'missing-timing') Object.assign(value, { timings: null });
      forward.mockImplementationOnce(async () => bundleResponse(value));
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    }
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects old unbundled upstream success instead of silently dropping artifacts', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(async () => Response.json(artifactBundle().report));
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
  it('consumes the same full synthetic bundle verified by Python service tests', async () => {
    const bundle = JSON.parse(
      readFileSync(
        new URL(
          '../../processing/tests/fixtures/service-artifacts/representative-bundle.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const { env, put, forward, request } = setup();
    const input = request('/extract', secret, 'POST');
    input.headers.set(
      'X-Source-Capability',
      await mintExtractionCapability(
        { tenantId: tenant, jobId: job, sourceHash: bundle.report.source.sha256 },
        signingSecret,
      ),
    );
    forward.mockImplementationOnce(async () => bundleResponse(bundle));
    const response = await host.fetch(input, env);
    expect(response.status).toBe(200);
    const result = (await response.json()) as typeof bundle.report;
    expect(result.schema_version).toBe(2);
    expect(result.drafts).toEqual(bundle.report.drafts);
    expect(result.evidence).toEqual(bundle.report.evidence);
    const stored = JSON.parse(put.mock.calls[0]?.[1] ?? '{}');
    expect(stored.report).toEqual(bundle.report);
    expect(stored.review_suggestions).toEqual(bundle.review_suggestions);
    expect(stored.timings).toEqual(bundle.timings);
  });
  it('refuses conditional-write collisions instead of claiming retention succeeded', async () => {
    const { env, put, request } = setup();
    put.mockResolvedValueOnce(null);
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
  });
  it('rejects oversized or malformed upstream bundles before private writes', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(
      async () =>
        new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'X-Extraction-Artifact-Bundle': '1',
            'Content-Length': '32000001',
          },
        }),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    forward.mockImplementationOnce(
      async () =>
        new Response('invalid JSON', {
          headers: { 'Content-Type': 'application/json', 'X-Extraction-Artifact-Bundle': '1' },
        }),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
  it('preserves Unicode private values split across upstream stream chunks', async () => {
    const { env, put, forward, request } = setup();
    const bundle = artifactBundle();
    bundle.review_suggestions.suggestions = [
      { status: 'unvalidated', original: { name: 'Synthetic 🍜' } },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    forward.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < bytes.length; index++)
                controller.enqueue(bytes.slice(index, index + 1));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json', 'X-Extraction-Artifact-Bundle': '1' } },
        ),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    expect(
      JSON.parse(put.mock.calls[0]?.[1] ?? '{}').review_suggestions.suggestions[0].original.name,
    ).toBe('Synthetic 🍜');
  });
  it('preserves status 429 Retry-After 10 safely without forwarding sensitive provider messages', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(async () =>
      Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '10' } }),
    );
    let response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(await response.json()).toEqual({ error: 'busy' });
    expect(put).not.toHaveBeenCalled();

    forward.mockImplementationOnce(
      async () =>
        new Response('PRIVATE_PROVIDER_RATE_LIMIT_TRACE', {
          status: 429,
          headers: { 'Retry-After': '10', 'Content-Type': 'text/plain' },
        }),
    );
    response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('10');
    const text = await response.text();
    expect(text).not.toContain('PRIVATE_PROVIDER_RATE_LIMIT_TRACE');
    expect(JSON.parse(text)).toEqual({ error: 'busy' });
    expect(put).not.toHaveBeenCalled();
  });

  it('preserves status 504 timeout and 502 safely without forwarding sensitive messages', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(
      async () =>
        new Response('PRIVATE_SUBPROCESS_TIMEOUT_DETAIL', {
          status: 504,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    let response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(504);
    expect(await response.text()).not.toContain('PRIVATE_SUBPROCESS_TIMEOUT_DETAIL');
    expect(put).not.toHaveBeenCalled();

    forward.mockImplementationOnce(
      async () =>
        new Response('PRIVATE_UPSTREAM_FAILURE', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('PRIVATE_UPSTREAM_FAILURE');
    expect(put).not.toHaveBeenCalled();

    for (const status of [201, 500]) {
      forward.mockImplementationOnce(
        async () => new Response('PRIVATE_UPSTREAM_CONTENT', { status }),
      );
      response = await host.fetch(request('/extract', secret, 'POST'), env);
      expect(response.status).toBe(status >= 400 ? status : 502);
      expect(await response.text()).not.toContain('PRIVATE_UPSTREAM_CONTENT');
    }
    expect(put).not.toHaveBeenCalled();
  });
  it('does not trust a grant from another tenant/job for storage', async () => {
    const { env, put, forward, request } = setup();
    const input = request('/extract', secret, 'POST');
    input.headers.set('X-Tenant-ID', '00000000-0000-4000-8000-000000000099');
    expect((await host.fetch(input, env)).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
  it('fails closed outside staging and hides provider failures', async () => {
    const { env, get, request } = setup();
    expect((await host.fetch(request('/health'), { ...env, APP_ENV: 'production' })).status).toBe(
      503,
    );
    get.mockRejectedValue(new Error('synthetic-sensitive-detail'));
    const result = await host.fetch(request(`/sources/${tenant}/${job}`), env);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain('synthetic-sensitive-detail');
  });
});

describe('provider call budget enforcement', () => {
  function createBudgetContainer() {
    const budgets = new Map<
      string,
      { tenant_id: string; job_id: string; max_calls: number; used_calls: number }
    >();
    const reservations = new Map<
      string,
      { run_id: string; provider: string; granted: number; used_calls: number; max_calls: number }
    >();
    const storage = {
      transactionSync: <T>(fn: () => T): T => fn(),
      sql: {
        exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]) => {
          const normalized = query.replace(/\s+/g, ' ').trim();
          if (normalized.startsWith('CREATE TABLE IF NOT EXISTS')) {
            return { toArray: () => [] as T[] };
          }
          if (
            normalized.startsWith(
              'SELECT run_id, granted, used_calls, max_calls FROM provider_call_reservations',
            )
          ) {
            const row = reservations.get(String(params[0]));
            return { toArray: () => (row ? [row as unknown as T] : []) };
          }
          if (normalized.startsWith('INSERT OR IGNORE INTO provider_call_budget')) {
            const [runId, tenantId, jobId, maxCalls] = params as [string, string, string, number];
            if (!budgets.has(runId)) {
              budgets.set(runId, {
                tenant_id: tenantId,
                job_id: jobId,
                max_calls: maxCalls,
                used_calls: 0,
              });
            }
            return { toArray: () => [] as T[] };
          }
          if (normalized.startsWith('SELECT max_calls, used_calls FROM provider_call_budget')) {
            const row = budgets.get(String(params[0]));
            return { toArray: () => (row ? [row as unknown as T] : []) };
          }
          if (normalized.startsWith('UPDATE provider_call_budget SET used_calls')) {
            const [usedCalls, runId] = params as [number, string];
            const row = budgets.get(runId);
            if (row) row.used_calls = usedCalls;
            return { toArray: () => [] as T[] };
          }
          if (normalized.startsWith('INSERT INTO provider_call_reservations')) {
            const [reservationKey, runId, provider, usedCalls, maxCalls] = params as [
              string,
              string,
              string,
              number,
              number,
            ];
            const granted = normalized.includes(', 1, ?, ?, ?)') ? 1 : 0;
            if (reservations.has(reservationKey)) {
              throw new Error(
                'UNIQUE constraint failed: provider_call_reservations.reservation_key',
              );
            }
            reservations.set(reservationKey, {
              run_id: runId,
              provider,
              granted,
              used_calls: usedCalls,
              max_calls: maxCalls,
            });
            return { toArray: () => [] as T[] };
          }
          throw new Error(`Unexpected SQL in test: ${normalized}`);
        },
      },
    };
    const env = {
      APP_ENV: 'staging',
      EXTRACTION_SERVICE_SECRET: secret,
      EXTRACTION_SOURCE_SIGNING_SECRET: signingSecret,
      EXTRACTION_SOURCE_ORIGIN: 'https://extract.example',
      SOURCE_BUCKET: { get: vi.fn(), put: vi.fn() },
      EXTRACTOR: {
        getByName: () => container,
      },
    } as unknown as ExtractionHostEnv;
    const container = new ExtractionContainer({ storage } as unknown as DurableObjectState, env);
    let activeContainer = container;
    const envWithRestart = {
      ...env,
      EXTRACTOR: {
        getByName: () => activeContainer,
      },
    } as unknown as ExtractionHostEnv;
    return {
      env: envWithRestart,
      container,
      restartContainer: () => {
        activeContainer = new ExtractionContainer(
          { storage } as unknown as DurableObjectState,
          envWithRestart,
        );
        return activeContainer;
      },
    };
  }

  function budgetRequest(
    body: Record<string, unknown>,
    overrides: Partial<{
      auth: string;
      cap: string;
      tenantId: string;
      jobId: string;
      sourceHash: string;
    }> = {},
  ) {
    return new Request('https://extract.example/budget/reserve', {
      method: 'POST',
      headers: {
        Authorization: overrides.auth ?? `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'X-Source-Capability': overrides.cap ?? capability,
        'X-Tenant-ID': overrides.tenantId ?? tenant,
        'X-Job-ID': overrides.jobId ?? job,
        'X-Source-Hash': overrides.sourceHash ?? 'a'.repeat(64),
      },
      body: JSON.stringify(body),
    });
  }

  it('enforces a hard cap of 2 reservations per run across providers and blocks the 3rd', async () => {
    const { env } = createBudgetContainer();
    const first = await host.fetch(
      budgetRequest({ reservation_key: 'res-1', provider: 'google_studio' }),
      env,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      granted: true,
      used_calls: 1,
      max_calls: 2,
      remaining_calls: 1,
    });

    const second = await host.fetch(
      budgetRequest({ reservation_key: 'res-2', provider: 'ocr_space' }),
      env,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      granted: true,
      used_calls: 2,
      max_calls: 2,
      remaining_calls: 0,
    });

    const third = await host.fetch(
      budgetRequest({ reservation_key: 'res-3', provider: 'qwen' }),
      env,
    );
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({
      granted: false,
      error: 'provider_call_budget_exhausted',
      used_calls: 2,
      max_calls: 2,
      remaining_calls: 0,
    });
  });

  it('is idempotent per reservation_key and isolates concurrent calls', async () => {
    const { env } = createBudgetContainer();
    const replay1 = await host.fetch(
      budgetRequest({ reservation_key: 'idem-1', provider: 'google_studio' }),
      env,
    );
    const replay2 = await host.fetch(
      budgetRequest({ reservation_key: 'idem-1', provider: 'google_studio' }),
      env,
    );
    expect(replay1.status).toBe(200);
    expect(replay2.status).toBe(200);
    expect((await replay2.json()) as { used_calls: number }).toMatchObject({ used_calls: 1 });

    const burst = await Promise.all(
      ['c-1', 'c-2', 'c-3', 'c-4'].map((key) =>
        host.fetch(budgetRequest({ reservation_key: key, provider: 'glm' }), env),
      ),
    );
    const grantedCount = burst.filter((r) => r.status === 200).length;
    const deniedCount = burst.filter((r) => r.status === 429).length;
    expect(grantedCount).toBe(1);
    expect(deniedCount).toBe(3);
  });

  it('rejects missing/mismatched capability or auth and isolates separate job runs', async () => {
    const { env } = createBudgetContainer();
    expect(
      (
        await host.fetch(
          budgetRequest({ reservation_key: 'u-1', provider: 'qwen' }, { auth: 'Bearer wrong' }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await host.fetch(
          budgetRequest(
            { reservation_key: 'u-2', provider: 'qwen' },
            { tenantId: '00000000-0000-4000-8000-000000000099' },
          ),
          env,
        )
      ).status,
    ).toBe(403);

    const job2 = '00000000-0000-4000-8000-000000000099';
    const cap2 = await mintExtractionCapability(
      { tenantId: tenant, jobId: job2, sourceHash: 'b'.repeat(64) },
      signingSecret,
    );
    const resOtherJob = await host.fetch(
      budgetRequest(
        { reservation_key: 'job2-1', provider: 'google_studio' },
        { cap: cap2, jobId: job2, sourceHash: 'b'.repeat(64) },
      ),
      env,
    );
    expect(resOtherJob.status).toBe(200);
    expect((await resOtherJob.json()) as { used_calls: number }).toMatchObject({ used_calls: 1 });

    // Reusing an existing reservation_key from another job/tenant fails closed with 403.
    const crossKeyReplay = await host.fetch(
      budgetRequest(
        { reservation_key: 'job2-1', provider: 'google_studio' },
        { cap: capability, jobId: job, sourceHash: 'a'.repeat(64) },
      ),
      env,
    );
    expect(crossKeyReplay.status).toBe(403);
    expect(await crossKeyReplay.json()).toMatchObject({ error: 'reservation_scope_mismatch' });
  });

  it('persists budget exhaustion across container/DO instance restarts', async () => {
    const { env, restartContainer } = createBudgetContainer();
    expect(
      (await host.fetch(budgetRequest({ reservation_key: 'r-1', provider: 'google_studio' }), env))
        .status,
    ).toBe(200);
    expect(
      (await host.fetch(budgetRequest({ reservation_key: 'r-2', provider: 'qwen' }), env)).status,
    ).toBe(200);

    restartContainer();

    const afterRestart = await host.fetch(
      budgetRequest({ reservation_key: 'r-3', provider: 'glm' }),
      env,
    );
    expect(afterRestart.status).toBe(429);
    expect(await afterRestart.json()).toMatchObject({
      granted: false,
      error: 'provider_call_budget_exhausted',
      used_calls: 2,
      max_calls: 2,
    });
  });
});
