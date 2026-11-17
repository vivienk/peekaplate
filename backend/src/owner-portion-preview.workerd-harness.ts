import { createHash } from 'node:crypto';
import host, { type ExtractionHostEnv } from './extraction-host';
import type { Bindings } from './index';
import { processPrivateDishPhoto } from './owner-portion-preview';

// Actual production bridge and host, with synthetic HTTP only. Native workerd Request
// construction validates redirect modes before either authenticated hop is forwarded.
export default {
  async fetch(request: Request) {
    const redirect = new URL(request.url).searchParams.has('redirect');
    const source = new TextEncoder().encode('synthetic-photo');
    const secret = 'synthetic-service-secret-'.repeat(3);
    let requests = 0;
    let containerRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests++;
      const outbound = new Request(input, init);
      return host.fetch(outbound, {
        APP_ENV: 'staging',
        EXTRACTION_SERVICE_SECRET: secret,
        EXTRACTION_SOURCE_SIGNING_SECRET: 'synthetic-signing-secret-'.repeat(3),
        EXTRACTION_SOURCE_ORIGIN: 'https://synthetic.invalid',
        SOURCE_BUCKET: { get: async () => null, put: async () => null },
        EXTRACTOR: {
          getByName: () => ({
            fetch: async (forwarded: Request) => {
              const validated = new Request(forwarded);
              if (validated.redirect !== 'manual') throw new Error('Unsafe redirect mode');
              containerRequests++;
              return redirect
                ? new Response(null, {
                    status: 302,
                    headers: { Location: 'https://never-follow.invalid' },
                  })
                : Response.json({ publication_eligible: false, portion: null });
            },
          }),
        },
      } as ExtractionHostEnv);
    };
    try {
      const record = await processPrivateDishPhoto({
        env: {
          EXTRACTION_SERVICE_URL: 'https://synthetic.invalid/extract',
          EXTRACTION_SERVICE_SECRET: secret,
        } as Bindings,
        bucket: {
          get: async (key: string) =>
            key === 'source'
              ? { size: source.byteLength, arrayBuffer: async () => source.buffer }
              : null,
          put: async () => {},
        } as unknown as NonNullable<Bindings['INGESTION_REPORTS_BUCKET']>,
        venueId: '00000000-0000-4000-8000-000000000001',
        draftId: '00000000-0000-4000-8000-000000000002',
        photoId: '00000000-0000-4000-8000-000000000003',
        sourceKey: 'source',
        sourceHash: createHash('sha256').update(source).digest('hex'),
        sourceSize: source.byteLength,
      });
      return Response.json({ status: record.status, requests, containerRequests });
    } catch {
      return Response.json({ requests, containerRequests }, { status: 502 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
