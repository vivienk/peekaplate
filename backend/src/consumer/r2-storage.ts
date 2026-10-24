import { sha256Hex } from './canonical-json';
import type { R2ArchiveStorage, R2PutResult } from './types';

/**
 * Cloudflare R2 bucket interface subset needed for archive operations.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      onlyIf?: {
        etagMatches?: string;
        etagDoesNotMatch?: string;
        uploadedBefore?: Date;
        uploadedAfter?: Date;
      };
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
 * NOTE ON ATOMICITY:
 * In Cloudflare Workers runtime, R2 does not provide an atomic native "put-if-absent"
 * primitive equivalent to S3's If-None-Match: * (R2PutOptions only supports etagMatches,
 * etagDoesNotMatch against known ETags, uploadedBefore, and uploadedAfter).
 * Therefore, local write guards use check-then-write (get before put) and metadata inspection.
 * True atomic multi-region mutual exclusion requires coordination with the database's
 * transactional advisory locks or live staging bucket constraints.
 */
export class CloudflareR2Storage implements R2ArchiveStorage {
  constructor(private readonly bucket: R2BucketLike) {}

  async putRawPayload(key: string, rawBytes: Uint8Array, checksum: string): Promise<R2PutResult> {
    // 1. Check if key already exists (create-only guard)
    const existing = await this.bucket.get(key);
    if (existing) {
      let existingChecksum = existing.customMetadata?.['payload-checksum'];
      if (!existingChecksum) {
        const buf = await existing.arrayBuffer();
        existingChecksum = await sha256Hex(new Uint8Array(buf));
      }
      return {
        status: 'already_exists',
        key,
        existingChecksum,
      };
    }

    // 2. Put raw payload with custom metadata
    await this.bucket.put(key, rawBytes, {
      customMetadata: {
        'payload-checksum': checksum,
        'archived-at': new Date().toISOString(),
      },
      httpMetadata: {
        contentType: 'application/json',
      },
    });

    return { status: 'created', key };
  }

  async getRawPayload(key: string): Promise<{ rawBytes: Uint8Array; checksum: string } | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const rawBytes = new Uint8Array(buf);
    const checksum = obj.customMetadata?.['payload-checksum'] ?? (await sha256Hex(rawBytes));
    return { rawBytes, checksum };
  }
}

/**
 * In-memory deterministic fake R2 storage for unit tests.
 * Accurately tracks create-only semantics and call counts.
 */
export class FakeR2ArchiveStorage implements R2ArchiveStorage {
  private readonly objects = new Map<
    string,
    { rawBytes: Uint8Array; checksum: string; archivedAt: string }
  >();
  public putCalls: { key: string; checksum: string }[] = [];
  public failNextPut = false;

  async putRawPayload(key: string, rawBytes: Uint8Array, checksum: string): Promise<R2PutResult> {
    this.putCalls.push({ key, checksum });
    if (this.failNextPut) {
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
}
