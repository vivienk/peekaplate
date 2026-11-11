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
