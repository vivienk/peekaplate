import { canonicalJson, toCanonicalObservation } from '@peekaplate/contracts';
import { canonicalizeJson, sha256Hex } from './canonical-json';
import type { R2ArchiveStorage, R2PutResult } from './types';

/**
 * Computes deterministic fallback checksum from an R2 object's stored body
 * when customMetadata['payload-checksum'] is absent.
 * Accurately reconstructs the canonical observation from stored envelopes to ensure
 * parity with initial delivery hashing (ADR 0015 / PR #40).
 */
async function computeFallbackChecksum(rawBytesOrBuf: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = rawBytesOrBuf instanceof Uint8Array ? rawBytesOrBuf : new Uint8Array(rawBytesOrBuf);
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      // 1. If stored object is a queue envelope (camelCase), map to canonical observation
      if (
        (parsed.kind === 'observation.v2' || parsed.schemaVersion === 'observation.v2') &&
        typeof parsed.eventId === 'string' &&
        typeof parsed.authorizedPublicationId === 'string'
      ) {
        const canonical = toCanonicalObservation(parsed);
        return await sha256Hex(canonicalJson(canonical));
      }
      // 2. If stored object is already a canonical observation (snake_case)
      if (parsed.schema_version === 'observation.v2' && typeof parsed.event_id === 'string') {
        return await sha256Hex(canonicalJson(parsed));
      }
      // 3. Fallback for generic JSON objects (such as conflict copies or raw events)
      return await sha256Hex(canonicalJson(parsed));
    }
  } catch {
    // Non-JSON object: hash raw bytes directly
  }
  return await sha256Hex(bytes);
}

/**
 * Cloudflare R2 bucket interface subset needed for archive operations.
 * Supports conditional operations via onlyIf (R2Conditional or Headers).
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      onlyIf?:
        | {
            etagMatches?: string;
            etagDoesNotMatch?: string;
            uploadedBefore?: Date;
            uploadedAfter?: Date;
          }
        | Headers;
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    },
  ): Promise<{ key: string; customMetadata?: Record<string, string>; etag: string } | null>;

  get(key: string): Promise<{
    key: string;
    customMetadata?: Record<string, string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
}

/**
 * Production-ready R2 adapter wrapping Cloudflare R2 bucket.
 *
 * ATOMIC CREATE-ONLY IMPLEMENTATION:
 * Cloudflare R2 provides atomic conditional create-only writes using:
 *   onlyIf: { etagDoesNotMatch: '*' }
 * which corresponds to HTTP `If-None-Match: *`.
 *
 * In Cloudflare R2:
 * - If the object does not exist: the conditional put succeeds and returns the created R2Object.
 * - If the object already exists: the precondition fails and put() returns null
 *   (or in some bindings throws a 412 PreconditionFailed error).
 * - Under NO circumstance does this adapter silently fall back to an unconditional overwrite.
 *
 * When an existing object is confirmed via precondition failure, get() is called to inspect
 * the existing object's payload checksum for duplicate vs. conflict determination.
 */
export class CloudflareR2Storage implements R2ArchiveStorage {
  constructor(private readonly bucket: R2BucketLike) {}

  async putRawPayload(key: string, rawBytes: Uint8Array, checksum: string): Promise<R2PutResult> {
    let putResult: { key: string; customMetadata?: Record<string, string>; etag: string } | null;

    try {
      // 1. Direct atomic conditional write (create-only via etagDoesNotMatch: '*')
      putResult = await this.bucket.put(key, rawBytes, {
        onlyIf: {
          etagDoesNotMatch: '*',
        },
        customMetadata: {
          'payload-checksum': checksum,
          'archived-at': new Date().toISOString(),
        },
        httpMetadata: {
          contentType: 'application/json',
        },
      });
    } catch (err: unknown) {
      // Distinguish precondition failure (object already exists) from storage / connectivity / auth errors
      if (this.isPreconditionFailedError(err)) {
        putResult = null;
      } else {
        // Propagate transient or fatal storage errors (auth, connectivity, rate-limits) without swallowing
        throw err;
      }
    }

    // 2. If put returned an object, the create-only write succeeded atomically
    if (putResult !== null) {
      return { status: 'created', key };
    }

    // 3. Precondition failed: object already exists. Inspect existing object to retrieve its checksum.
    const existing = await this.bucket.get(key);
    if (!existing) {
      // If precondition failed but object disappeared before get(), fail safely as an error rather than silently overwriting
      throw new Error(
        `R2 conditional write precondition failed for ${key}, but existing object could not be retrieved`,
      );
    }

    let existingChecksum = existing.customMetadata?.['payload-checksum'];
    if (!existingChecksum) {
      const buf = await existing.arrayBuffer();
      existingChecksum = await computeFallbackChecksum(buf);
    }

    return {
      status: 'already_exists',
      key,
      existingChecksum,
    };
  }

  async getRawPayload(key: string): Promise<{ rawBytes: Uint8Array; checksum: string } | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const rawBytes = new Uint8Array(buf);
    let checksum = obj.customMetadata?.['payload-checksum'];
    if (!checksum) {
      checksum = await computeFallbackChecksum(rawBytes);
    }
    return { rawBytes, checksum };
  }

  private isPreconditionFailedError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: string; message?: string; status?: number; code?: number | string };
    return (
      e.status === 412 ||
      e.code === 412 ||
      e.code === 10031 ||
      e.code === 'PRECONDITION_FAILED' ||
      e.name === 'PreconditionFailed' ||
      (typeof e.message === 'string' && /precondition/i.test(e.message))
    );
  }
}

/**
 * In-memory deterministic fake R2 storage for unit tests.
 * Accurately models atomic conditional create-only semantics and call counts.
 */
export class FakeR2ArchiveStorage implements R2ArchiveStorage {
  private readonly objects = new Map<
    string,
    { rawBytes: Uint8Array; checksum: string; archivedAt: string }
  >();
  public putCalls: { key: string; checksum: string }[] = [];
  public failNextPut = false;
  public failKeys = new Set<string>();

  async putRawPayload(key: string, rawBytes: Uint8Array, checksum: string): Promise<R2PutResult> {
    this.putCalls.push({ key, checksum });
    if (this.failNextPut || this.failKeys.has(key)) {
      this.failNextPut = false;
      throw new Error('R2 storage temporarily unavailable');
    }

    const existing = this.objects.get(key);
    if (existing) {
      return {
        status: 'already_exists',
        key,
        existingChecksum: existing.checksum,
      };
    }

    this.objects.set(key, {
      rawBytes: new Uint8Array(rawBytes),
      checksum,
      archivedAt: new Date().toISOString(),
    });
    return { status: 'created', key };
  }

  async getRawPayload(key: string): Promise<{ rawBytes: Uint8Array; checksum: string } | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { rawBytes: found.rawBytes, checksum: found.checksum };
  }

  setExisting(key: string, rawBytes: Uint8Array, checksum: string) {
    this.objects.set(key, {
      rawBytes: new Uint8Array(rawBytes),
      checksum,
      archivedAt: new Date().toISOString(),
    });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): IterableIterator<string> {
    return this.objects.keys();
  }
}
