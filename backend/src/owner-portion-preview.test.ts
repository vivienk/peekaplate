import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { Hono } from 'hono';
import type { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_dev } from 'wrangler';
import type { Bindings } from './index';
import { registerOwnerMenuRoutes } from './owner-menu-routes';
import { previewKey, processPrivateDishPhoto, readPrivatePortion } from './owner-portion-preview';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = new TextEncoder().encode('synthetic-source');
const sourceHash = createHash('sha256').update(source).digest('hex');
const noCutout = { publication_eligible: false, status: 'fallback_retained', portion: null };
const bgBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
);
const fgBytes = new TextEncoder().encode('synthetic-foreground-webp');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bgHash = sha(bgBytes);
const fgHash = sha(fgBytes);

function readyPayload() {
  const bgUrl = 'https://layers.example.test/bg.svg';
  const fgUrl = 'https://layers.example.test/dish.webp';
  return {
    publication_eligible: false,
    status: 'needs_review',
    portion: {
      schema_version: 1 as const,
      dish_id: id(2),
      dish_revision_id: id(3),
      width: 800,
      height: 600,
      layers: [
        { url: bgUrl, sha256: bgHash, size_bytes: bgBytes.byteLength, depth: 0 },
        { url: fgUrl, sha256: fgHash, size_bytes: fgBytes.byteLength, depth: 1 },
      ],
    },
    layers: {
      [bgUrl]: Buffer.from(bgBytes).toString('base64'),
      [fgUrl]: Buffer.from(fgBytes).toString('base64'),
    },
  };
}

function fixture(overrides: Partial<Bindings> = {}, failed = false) {
  const values = new Map<string, Uint8Array>([['source', source]]);
  if (failed)
    values.set(
      `${previewKey(id(1), id(2), id(3), sourceHash)}/record.json`,
      new TextEncoder().encode(
        JSON.stringify({
          status: 'failed',
          photo_sha256: sourceHash,
          dish_id: id(2),
          draft_revision_id: id(3),
          message: 'Previous processing failed',
        }),
      ),
    );
  const put = vi.fn(async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    values.set(key, bytes);
  });
  return {
    env: {
      EXTRACTION_SERVICE_URL: 'https://extract.example.test/',
      EXTRACTION_SERVICE_SECRET: 'test-only-service',
      ...overrides,
    } as Bindings,
    bucket: {
      get: vi.fn(async (key: string) => {
        const bytes = values.get(key);
        return bytes
          ? { size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
          : null;
      }),
      put,
    } as unknown as NonNullable<Bindings['INGESTION_REPORTS_BUCKET']>,
    venueId: id(1),
    draftId: id(2),
    photoId: id(3),
    sourceKey: 'source',
    sourceHash,
    sourceSize: source.byteLength,
  };
}

function portionApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  const photoRow = {
    id: id(3),
    tenant_id: id(1),
    draft_id: id(2),
    storage_key: 'source',
    content_type: 'image/png',
    size_bytes: source.byteLength,
    source_hash: sourceHash,
    verification_status: 'not_verified',
  };
  const fakeClient = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM app_private.staff_membership'))
        return { rows: [{ permission: 'owner' }] };
      if (sql.includes('FROM app_private.dish_draft_photo')) return { rows: [photoRow] };
      return { rows: [] };
    }),
  } as unknown as Client;
  registerOwnerMenuRoutes(app, {
    verify: async () => id(4),
    authorizeVenue: async () => {},
    database: async (_env, work) => work(fakeClient),
  });
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('private portion service transport', () => {
  it('uses Worker-supported redirects through both production portion hops and rejects redirects', async () => {
    const worker = await unstable_dev(
      fileURLToPath(new URL('./owner-portion-preview.workerd-harness.ts', import.meta.url)),
      {
        config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
        local: true,
        ip: '127.0.0.1',
        port: 0,
        inspectorPort: 0,
        logLevel: 'error',
        experimental: {
          disableExperimentalWarning: true,
          forceLocal: true,
          watch: false,
          disableDevRegistry: true,
        },
      },
    );
    try {
      const response = await worker.fetch('http://fixture.test/');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'failed',
        requests: 1,
        containerRequests: 1,
      });
      const redirected = await worker.fetch('http://fixture.test/?redirect=1');
      expect(redirected.status).toBe(502);
      expect(await redirected.json()).toEqual({ requests: 1, containerRequests: 1 });
    } finally {
      await worker.stop();
    }
  }, 30_000);
  it('reuses the authenticated extraction host when no separate service is configured', async () => {
    const fetcher = vi.fn(async () => Response.json(noCutout));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      processPrivateDishPhoto(
        fixture({ EXTRACTION_SERVICE_URL: 'https://extract.example.test/extract' }),
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`https://extract.example.test/v1/portion-uploads/${id(2)}/${id(3)}`);
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: 'Bearer test-only-service' },
    });
  });
  it.each([
    { PORTION_SERVICE_URL: 'https://portion.example.test/' },
    { PORTION_SERVICE_SECRET: 'other-secret' },
  ])('rejects a partial dedicated service configuration', async (settings) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(processPrivateDishPhoto(fixture(settings))).rejects.toThrow(
      'portion_service_unavailable',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses an explicit complete service pair without mixing credentials', async () => {
    const fetcher = vi.fn(async () => Response.json(noCutout));
    vi.stubGlobal('fetch', fetcher);
    await processPrivateDishPhoto(
      fixture({
        PORTION_SERVICE_URL: 'https://portion.example.test/',
        PORTION_SERVICE_SECRET: 'dedicated-test',
      }),
    );
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.hostname).toBe('portion.example.test');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer dedicated-test' });
  });
  it('allows a deliberate retry after a cached processing failure', async () => {
    const fetcher = vi.fn(async () => Response.json(noCutout));
    vi.stubGlobal('fetch', fetcher);
    await processPrivateDishPhoto(fixture({}, true));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds the response before parsing or storing it', async () => {
    const input = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(' '.repeat(300_001))),
    );
    await expect(processPrivateDishPhoto(input)).rejects.toThrow('processor_response_too_large');
    expect(input.bucket.put).not.toHaveBeenCalled();
  });
  it('keeps the deadline active while waiting for the response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: URL, options: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                options.signal!.addEventListener('abort', () =>
                  controller.error(new Error('aborted')),
                );
              },
            }),
          ),
      ),
    );
    const pending = processPrivateDishPhoto(fixture()).then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(220_000);
    expect(await pending).toMatchObject({ message: 'aborted' });
  });
  it('registers portion processing with executionCtx.waitUntil so client abort does not drop R2 persistence', async () => {
    const app = portionApp();
    const base = fixture({
      APP_ENV: 'staging',
      OWNER_WORKFLOW_ENABLED: 'true',
    });
    base.env.INGESTION_REPORTS_BUCKET = base.bucket;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(noCutout)),
    );
    const waitUntil = vi.fn();
    const res = await app.request(
      `https://test/venues/${id(1)}/drafts/${id(2)}/photos/${id(3)}/portion`,
      { method: 'POST', headers: { Authorization: 'Bearer staff-token' } },
      base.env as Bindings,
      { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]?.[0];
    expect(base.bucket.put).toHaveBeenCalledWith(
      `${previewKey(id(1), id(2), id(3), sourceHash)}/record.json`,
      expect.any(String),
    );
  });
  it('recovers an uncached portion on an immediate retry while the disconnected request is still processing', async () => {
    vi.useFakeTimers();
    const app = portionApp();
    const base = fixture({
      APP_ENV: 'staging',
      OWNER_WORKFLOW_ENABLED: 'true',
    });
    base.env.INGESTION_REPORTS_BUCKET = base.bucket;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json(readyPayload())), 29_000);
          }),
      )
      .mockImplementation(async () => Response.json({ error: 'busy' }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    const waitUntil = vi.fn();
    const disconnect = new AbortController();
    const firstCaller = Promise.race([
      app.request(
        `https://test/venues/${id(1)}/drafts/${id(2)}/photos/${id(3)}/portion`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer staff-token' },
          signal: disconnect.signal,
        },
        base.env as Bindings,
        { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
      ),
      new Promise<string>((resolve) => {
        disconnect.signal.addEventListener('abort', () => resolve('client_disconnected'), {
          once: true,
        });
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    disconnect.abort();
    await expect(firstCaller).resolves.toBe('client_disconnected');

    const retry = app.request(
      `https://test/venues/${id(1)}/drafts/${id(2)}/photos/${id(3)}/portion`,
      { method: 'POST', headers: { Authorization: 'Bearer staff-token' } },
      base.env as Bindings,
      { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(base.bucket.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(17_000);
    await waitUntil.mock.calls[0]?.[0];
    const callsBeforeCacheHit = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    const retryRes = await retry;
    expect(retryRes.status).toBe(200);
    await expect(retryRes.json()).resolves.toMatchObject({
      portionReview: {
        status: 'needs_review',
        foreground_sha256: fgHash,
        approved: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeCacheHit);
  });
  it('reads cached preview approval without re-invoking processing', async () => {
    const app = portionApp();
    const input = fixture({ APP_ENV: 'staging', OWNER_WORKFLOW_ENABLED: 'true' });
    input.env.INGESTION_REPORTS_BUCKET = input.bucket;
    const fetcher = vi.fn(async () => Response.json(readyPayload()));
    vi.stubGlobal('fetch', fetcher);
    const url = `https://test/venues/${id(1)}/drafts/${id(2)}/photos/${id(3)}/portion`;
    const headers = { Authorization: 'Bearer staff-token' };
    const absent = await app.request(url, { headers }, input.env);
    expect(absent.status).toBe(404);
    expect(absent.headers.get('Cache-Control')).toBe('no-store');

    await processPrivateDishPhoto(input);
    const before = await app.request(url, { headers }, input.env);
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      portionReview: { status: 'needs_review', approved: false },
    });

    const approval = await app.request(`${url}/approve`, { method: 'POST', headers }, input.env);
    expect(approval.status).toBe(200);
    const after = await app.request(url, { headers }, input.env);
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({
      portionReview: { status: 'needs_review', approved: true },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('re-checks R2 during 429 busy backoff and returns the saved record without a second container call', async () => {
    const input = fixture();
    const key = previewKey(id(1), id(2), id(3), sourceHash);
    const payload = readyPayload();
    const fetcher = vi.fn(async () => {
      setTimeout(() => {
        void input.bucket.put(
          `${key}/record.json`,
          JSON.stringify({
            status: 'needs_review',
            photo_sha256: sourceHash,
            dish_id: id(2),
            draft_revision_id: id(3),
            foreground_sha256: fgHash,
            foreground_size: fgBytes.byteLength,
            portion: payload.portion,
          }),
        );
      }, 1);
      return new Response(JSON.stringify({ error: 'busy' }), { status: 429 });
    });
    vi.stubGlobal('fetch', fetcher);
    const record = await processPrivateDishPhoto({ ...input, busyRetryDelaysMs: [15, 15] });
    expect(record).toMatchObject({
      status: 'needs_review',
      foreground_sha256: fgHash,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retries after 429 busy when R2 stays empty and persists once the container slot frees', async () => {
    const input = fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 429 }))
      .mockResolvedValueOnce(Response.json(readyPayload()));
    vi.stubGlobal('fetch', fetcher);
    const record = await processPrivateDishPhoto({ ...input, busyRetryDelaysMs: [5, 5] });
    expect(record).toMatchObject({
      status: 'needs_review',
      foreground_sha256: fgHash,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      readPrivatePortion(input.bucket, previewKey(id(1), id(2), id(3), sourceHash)),
    ).resolves.toMatchObject({
      status: 'needs_review',
      foreground_sha256: fgHash,
    });
  });
});
