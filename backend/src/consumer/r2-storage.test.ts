import { canonicalJson, sha256, toCanonicalObservation } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareR2Storage, type R2BucketLike } from './r2-storage';

describe('CloudflareR2Storage (Atomic create-only)', () => {
  const dummyPayload = new TextEncoder().encode(JSON.stringify({ event: 'test' }));
  const dummyChecksum = 'a'.repeat(64);
  const key = 'raw/observations/test/2026/10/24/evt.json';

  it('attempts conditional write directly with onlyIf etagDoesNotMatch: *', async () => {
    let getCalled = false;
    let capturedOptions: any = null;

    const mockBucket: R2BucketLike = {
      put: vi.fn(async (_k, _v, options) => {
        capturedOptions = options;
        return { key, etag: 'etag-1' };
      }),
      get: vi.fn(async () => {
        getCalled = true;
        return null;
      }),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    const result = await storage.putRawPayload(key, dummyPayload, dummyChecksum);

    expect(result.status).toBe('created');
    expect(result.key).toBe(key);
    // Verified: No pre-check get() call was made before put
    expect(getCalled).toBe(false);
    expect(mockBucket.put).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.onlyIf).toEqual({ etagDoesNotMatch: '*' });
    expect(capturedOptions?.customMetadata?.['payload-checksum']).toBe(dummyChecksum);
    expect(capturedOptions?.httpMetadata?.contentType).toBe('application/json');
  });

  it('handles null return on precondition failure and retrieves existing checksum from metadata', async () => {
    const existingChecksum = 'b'.repeat(64);

    const mockBucket: R2BucketLike = {
      put: vi.fn(async () => null), // Cloudflare R2 returns null on precondition failure
      get: vi.fn(async () => ({
        key,
        customMetadata: { 'payload-checksum': existingChecksum },
        arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
      })),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    const result = await storage.putRawPayload(key, dummyPayload, dummyChecksum);

    expect(result.status).toBe('already_exists');
    expect(result.key).toBe(key);
    if (result.status === 'already_exists') {
      expect(result.existingChecksum).toBe(existingChecksum);
    }
    expect(mockBucket.put).toHaveBeenCalledTimes(1);
    expect(mockBucket.get).toHaveBeenCalledTimes(1);
  });

  it('handles 412 / PreconditionFailed exception on conditional put and retrieves existing checksum', async () => {
    const existingChecksum = 'c'.repeat(64);
    const preconditionError = new Error('Precondition Failed');
    (preconditionError as any).status = 412;

    const mockBucket: R2BucketLike = {
      put: vi.fn(async () => {
        throw preconditionError;
      }),
      get: vi.fn(async () => ({
        key,
        customMetadata: { 'payload-checksum': existingChecksum },
        arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
      })),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    const result = await storage.putRawPayload(key, dummyPayload, dummyChecksum);

    expect(result.status).toBe('already_exists');
    expect(result.key).toBe(key);
    if (result.status === 'already_exists') {
      expect(result.existingChecksum).toBe(existingChecksum);
    }
  });

  it('computes checksum from existing object body if customMetadata is absent', async () => {
    const originalBody = new TextEncoder().encode(JSON.stringify({ original: true }));
    const arrayBuf = new Uint8Array(originalBody).buffer as ArrayBuffer;

    const mockBucket: R2BucketLike = {
      put: vi.fn(async () => null),
      get: vi.fn(async () => ({
        key,
        arrayBuffer: async (): Promise<ArrayBuffer> => arrayBuf,
      })),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    const result = await storage.putRawPayload(key, dummyPayload, dummyChecksum);

    expect(result.status).toBe('already_exists');
    expect(result.key).toBe(key);
    if (result.status === 'already_exists') {
      // Checksum computed from body matches 64 hex characters
      expect(result.existingChecksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('DEF-02 regression: computes fallback checksum matching canonical observation when customMetadata is absent', async () => {
    const envelope = {
      kind: 'observation.v2' as const,
      tenantId: '00000000-0000-4000-8000-000000000001',
      eventId: '00000000-0000-4000-8000-000000000002',
      sessionId: '00000000-0000-4000-8000-000000000003',
      schemaVersion: 'observation.v2' as const,
      occurredAt: '2026-10-24T12:00:00.000Z',
      type: 'dish_viewed' as const,
      authorizedPublicationId: '00000000-0000-4000-8000-000000000004',
      producerId: '00000000-0000-4000-8000-000000000005',
      localSequence: 1,
      payload: {
        dish_id: '00000000-0000-4000-8000-000000000006',
        dish_revision_id: '00000000-0000-4000-8000-000000000007',
        exposure_id: '00000000-0000-4000-8000-000000000008',
        surface: 'menu_list' as const,
        position: 1,
        exposure_basis: 'viewport_50pct_1s' as const,
      },
      firstReceivedAt: '2026-10-24T12:00:01.000Z',
    };

    const canonical = toCanonicalObservation(envelope);
    const expectedCanonicalChecksum = await sha256(canonicalJson(canonical));
    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const arrayBuf = new Uint8Array(envelopeBytes).buffer as ArrayBuffer;

    const mockBucket: R2BucketLike = {
      put: vi.fn(async () => null),
      get: vi.fn(async () => ({
        key,
        arrayBuffer: async (): Promise<ArrayBuffer> => arrayBuf,
      })),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    const result = await storage.putRawPayload(key, envelopeBytes, expectedCanonicalChecksum);

    expect(result.status).toBe('already_exists');
    if (result.status === 'already_exists') {
      // Must match the canonical observation checksum, NOT sha256(envelope.payload)
      expect(result.existingChecksum).toBe(expectedCanonicalChecksum);
      const innerOnlyChecksum = await sha256(canonicalJson(envelope.payload));
      expect(result.existingChecksum).not.toBe(innerOnlyChecksum);
    }
  });

  it('does NOT misclassify transient errors, connectivity, or authentication failures as precondition failures', async () => {
    const errorsToTest = [
      new Error('Connection reset by peer'),
      Object.assign(new Error('Unauthorized'), { status: 401 }),
      Object.assign(new Error('Rate limit exceeded'), { status: 429 }),
      Object.assign(new Error('Internal storage error'), { status: 500 }),
      Object.assign(new Error('Bad request'), { status: 400 }),
    ];

    for (const err of errorsToTest) {
      const mockBucket: R2BucketLike = {
        put: vi.fn(async () => {
          throw err;
        }),
        get: vi.fn(),
      };

      const storage = new CloudflareR2Storage(mockBucket);
      await expect(storage.putRawPayload(key, dummyPayload, dummyChecksum)).rejects.toThrow(err);
      expect(mockBucket.get).not.toHaveBeenCalled();
    }
  });

  it('throws safely if precondition fails but existing object cannot be read', async () => {
    const mockBucket: R2BucketLike = {
      put: vi.fn(async () => null),
      get: vi.fn(async () => null),
    };

    const storage = new CloudflareR2Storage(mockBucket);
    await expect(storage.putRawPayload(key, dummyPayload, dummyChecksum)).rejects.toThrow(
      /precondition failed for .* but existing object could not be retrieved/,
    );
  });

  it('simulates concurrent create-only writes: first wins, second detects existing object', async () => {
    let storedObject: { key: string; bytes: Uint8Array; checksum: string } | null = null;

    const mockBucket: R2BucketLike = {
      put: vi.fn(async (k, val, options) => {
        if (storedObject !== null) {
          // Precondition failed!
          return null;
        }
        storedObject = {
          key: k,
          bytes: val as Uint8Array,
          checksum: options?.customMetadata?.['payload-checksum'] ?? '',
        };
        return { key: k, etag: 'etag-first' };
      }),
      get: vi.fn(async (k) => {
        if (!storedObject || storedObject.key !== k) return null;
        const currentBytes = storedObject.bytes;
        const buf = new Uint8Array(currentBytes).buffer as ArrayBuffer;
        return {
          key: storedObject.key,
          customMetadata: { 'payload-checksum': storedObject.checksum },
          arrayBuffer: async (): Promise<ArrayBuffer> => buf,
        };
      }),
    };

    const storage1 = new CloudflareR2Storage(mockBucket);
    const storage2 = new CloudflareR2Storage(mockBucket);

    const [res1, res2] = await Promise.all([
      storage1.putRawPayload(key, dummyPayload, 'checksum-1111'.padEnd(64, '1')),
      storage2.putRawPayload(key, dummyPayload, 'checksum-2222'.padEnd(64, '2')),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['already_exists', 'created']);

    // Stored object was preserved and not overwritten
    expect(storedObject!.checksum).toBe('checksum-1111'.padEnd(64, '1'));
  });
});
