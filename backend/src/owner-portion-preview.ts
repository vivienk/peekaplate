// Private S09 2.5D processing bridge. Draft identities MUST NOT be treated as
// approved public dish revisions: publication remains a separate trusted step.
import { createHash } from 'node:crypto';
import { PublicPortionSchema } from '@peekaplate/contracts';
import type { Bindings } from './index';

type StoredObject = { size: number; arrayBuffer(): Promise<ArrayBuffer> };
type Bucket = NonNullable<Bindings['INGESTION_REPORTS_BUCKET']>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function previewKey(venueId: string, draftId: string, photoId: string, sourceHash: string) {
  for (const value of [venueId, draftId, photoId]) {
    if (!id.test(value)) throw new Error('invalid_identity');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('invalid_hash');
  return `private-portions/${venueId}/${draftId}/${photoId}/${sourceHash}`;
}

function objectBytes(object: StoredObject | null, expectedSize: number, expectedHash: string) {
  if (!object || object.size !== expectedSize || expectedSize > 12_000_000) {
    throw new Error('source_unavailable');
  }
  return object.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== expectedSize || hash(bytes) !== expectedHash) {
      throw new Error('source_corrupt');
    }
    return bytes;
  });
}

type PrivatePreview = {
  status: 'needs_review' | 'failed';
  photo_sha256: string;
  dish_id: string;
  draft_revision_id: string;
  foreground_sha256?: string;
  foreground_size?: number;
  message?: string;
};

export async function readPrivatePortion(
  bucket: Bucket,
  key: string,
): Promise<PrivatePreview | null> {
  if (!bucket.get) throw new Error('storage_unavailable');
  const item = await bucket.get(`${key}/record.json`);
  if (!item) return null;
  const bytes = await item.arrayBuffer();
  if (bytes.byteLength > 4096) throw new Error('invalid_record');
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object') throw new Error('invalid_record');
  const record = value as PrivatePreview;
  if (
    !['needs_review', 'failed'].includes(record.status) ||
    !id.test(record.dish_id) ||
    !id.test(record.draft_revision_id) ||
    !/^[a-f0-9]{64}$/.test(record.photo_sha256)
  ) {
    throw new Error('invalid_record');
  }
  return record;
}

export async function privatePreviewImage(bucket: Bucket, key: string, record: PrivatePreview) {
  if (
    record.status !== 'needs_review' ||
    !record.foreground_sha256 ||
    !record.foreground_size ||
    !bucket.get
  )
    return null;
  const image = await bucket.get(`${key}/dish.webp`);
  return objectBytes(image, record.foreground_size, record.foreground_sha256);
}

/** Trusted server-to-server path; no browser-controlled URL, token, or public assets. */
export async function processPrivateDishPhoto(input: {
  env: Bindings;
  bucket: Bucket;
  venueId: string;
  draftId: string;
  photoId: string;
  sourceKey: string;
  sourceHash: string;
  sourceSize: number;
}) {
  const { env, bucket, venueId, draftId, photoId, sourceKey, sourceHash, sourceSize } = input;
  const key = previewKey(venueId, draftId, photoId, sourceHash);
  const existing = await readPrivatePortion(bucket, key);
  if (existing) return existing;
  if (!env.PORTION_SERVICE_URL || !env.PORTION_SERVICE_SECRET || !bucket.get) {
    throw new Error('portion_service_unavailable');
  }
  const endpoint = new URL(env.PORTION_SERVICE_URL);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  ) {
    throw new Error('invalid_portion_service_url');
  }
  const photo = await objectBytes(await bucket.get(sourceKey), sourceSize, sourceHash);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/portion-uploads/${draftId}/${photoId}`, endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PORTION_SERVICE_SECRET}`,
        'Content-Type': 'application/octet-stream',
      },
      body: photo,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error('portion_processing_unavailable');
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object') throw new Error('invalid_processor_response');
  const result = raw as {
    status?: unknown;
    portion?: unknown;
    layers?: unknown;
    publication_eligible?: unknown;
  };
  if (result.publication_eligible !== false) throw new Error('invalid_processor_provenance');
  const portion = result.portion ? PublicPortionSchema.parse(result.portion) : null;
  if (portion && (portion.dish_id !== draftId || portion.dish_revision_id !== photoId)) {
    throw new Error('portion_identity_mismatch');
  }
  const layers = result.layers;
  if (portion && (!layers || typeof layers !== 'object')) throw new Error('missing_layers');
  let foreground: Uint8Array | null = null;
  if (portion) {
    for (const layer of portion.layers) {
      const encoded = (layers as Record<string, unknown>)[layer.url];
      if (typeof encoded !== 'string' || encoded.length > 260_000) throw new Error('missing_layer');
      const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
      if (bytes.byteLength !== layer.size_bytes || hash(bytes) !== layer.sha256) {
        throw new Error('layer_integrity_failure');
      }
      if (layer.depth > 0) foreground = bytes;
    }
  }
  const record: PrivatePreview = {
    status: foreground ? 'needs_review' : 'failed',
    photo_sha256: sourceHash,
    dish_id: draftId,
    draft_revision_id: photoId,
    ...(foreground && portion
      ? {
          foreground_sha256: hash(foreground),
          foreground_size: foreground.byteLength,
        }
      : { message: 'Cutout unavailable; original photo retained.' }),
  };
  if (foreground) {
    await bucket.put(`${key}/dish.webp`, foreground.buffer as ArrayBuffer, {
      httpMetadata: { contentType: 'image/webp' },
    });
  }
  await bucket.put(`${key}/record.json`, JSON.stringify(record));
  return record;
}
