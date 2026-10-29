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
function setup() {
  const forward = vi.fn(async () => Response.json({ status: 'ok' }));
  const get = vi.fn(async () => ({ size: 3, body: new Blob(['pdf']).stream() }));
  const env: ExtractionHostEnv = {
    APP_ENV: 'staging',
    EXTRACTION_SERVICE_SECRET: secret,
    EXTRACTION_SOURCE_SIGNING_SECRET: signingSecret,
    EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
    EXTRACTOR: { getByName: vi.fn(() => ({ fetch: forward })) },
    SOURCE_BUCKET: { get },
  };
  const request = (path: string, token = secret, method = 'GET') =>
    new Request(`https://host.invalid${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Source-Capability': capability,
        'X-Source-Hash': 'a'.repeat(64),
        'X-Tenant-ID': tenant,
        'X-Job-ID': job,
      },
    });
  return { env, get, forward, request };
}

function runtime(running = false) {
  const { env } = setup();
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
  it('derives the sole source key from path IDs and streams it without caching', async () => {
    const { env, get, forward, request } = setup();
    const response = await host.fetch(request(`/sources/${tenant}/${job}`), env);
    expect(get).toHaveBeenCalledWith(`menu-ingestion/sources/${tenant}/${job}/source`);
    expect(await response.text()).toBe('pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe('3');
    expect(forward).not.toHaveBeenCalled();
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
