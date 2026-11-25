import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { Hono } from 'hono';
import type { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_dev } from 'wrangler';
import type { Bindings } from './index';
import { registerOwnerMenuRoutes } from './owner-menu-routes';
import { previewKey, processPrivateDishPhoto } from './owner-portion-preview';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = new TextEncoder().encode('synthetic-source');
const sourceHash = createHash('sha256').update(source).digest('hex');
const noCutout = { publication_eligible: false, status: 'fallback_retained', portion: null };
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
  const put = vi.fn();
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
});
