// Private S09 2.5D processing bridge. Draft identities MUST NOT be treated as
// approved public dish revisions: publication remains a separate trusted step.
import { createHash } from 'node:crypto';
import { type PublicPortion, PublicPortionSchema } from '@peekaplate/contracts';
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

export type PrivatePreview = {
  status: 'needs_review' | 'failed';
  photo_sha256: string;
  dish_id: string;
  draft_revision_id: string;
  foreground_sha256?: string;
  foreground_size?: number;
  /** Private draft/photo identities only. Never use as the published portion directly. */
  portion?: PublicPortion;
  message?: string;
};

export async function readPrivatePortion(
  bucket: Pick<Bucket, 'get'>,
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
  if (record.portion) {
    const parsed = PublicPortionSchema.safeParse(record.portion);
    if (
      !parsed.success ||
      parsed.data.dish_id !== record.dish_id ||
      parsed.data.dish_revision_id !== record.draft_revision_id
    ) {
      throw new Error('invalid_private_portion');
    }
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
  if (existing?.status === 'needs_review') return existing;
  const dedicated = env.PORTION_SERVICE_URL !== undefined || env.PORTION_SERVICE_SECRET !== undefined;
  const serviceUrl = dedicated ? env.PORTION_SERVICE_URL : env.EXTRACTION_SERVICE_URL;
  const serviceSecret = dedicated ? env.PORTION_SERVICE_SECRET : env.EXTRACTION_SERVICE_SECRET;
  if (!serviceUrl || !serviceSecret || !bucket.get) {
    throw new Error('portion_service_unavailable');
  }
  const endpoint = new URL(serviceUrl);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (dedicated && endpoint.pathname !== '/')
  ) {
    throw new Error('invalid_portion_service_url');
  }
  const photo = await objectBytes(await bucket.get(sourceKey), sourceSize, sourceHash);
  const controller = new AbortController();
  // Existing container startup (30s), bounded local segmentation (180s), and response delivery.
  const timeout = setTimeout(() => controller.abort(), 220_000);
  let raw: unknown;
  try {
    const response = await fetch(new URL(`/v1/portion-uploads/${draftId}/${photoId}`, endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceSecret}`,
        'Content-Type': 'application/octet-stream',
      },
      body: photo,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('portion_processing_unavailable');
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 300_000) throw new Error('processor_response_too_large');
        chunks.push(value);
      }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timeout);
  }
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
  const privateLayers: Array<{ filename: string; bytes: Uint8Array }> = [];
  if (portion) {
    for (const layer of portion.layers) {
      const encoded = (layers as Record<string, unknown>)[layer.url];
      if (typeof encoded !== 'string' || encoded.length > 260_000) throw new Error('missing_layer');
      const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
      if (bytes.byteLength !== layer.size_bytes || hash(bytes) !== layer.sha256) {
        throw new Error('layer_integrity_failure');
      }
      if (layer.depth > 0) foreground = bytes;
      const filename = layer.depth === 0 ? 'background.svg' : 'dish.webp';
      if (privateLayers.some((item) => item.filename === filename)) {
        throw new Error('duplicate_layer');
      }
      privateLayers.push({ filename, bytes });
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
          portion,
        }
      : { message: 'Cutout unavailable; original photo retained.' }),
  };
  for (const layer of privateLayers) {
    await bucket.put(`${key}/${layer.filename}`, layer.bytes.buffer as ArrayBuffer, {
      httpMetadata: {
        contentType: layer.filename.endsWith('.svg') ? 'image/svg+xml' : 'image/webp',
      },
    });
  }
  await bucket.put(`${key}/record.json`, JSON.stringify(record));
  return record;
}

/** Private human approval. Publication requires an independent approved dish revision. */
export type PrivatePortionApproval = {
  schema_version: 1;
  status: 'approved';
  source_sha256: string;
  portion_sha256: string;
  approved_by: string;
  approved_at: string;
};

const portionHash = (portion: PublicPortion) =>
  hash(new TextEncoder().encode(JSON.stringify(portion)));

export async function readPrivatePortionApproval(
  bucket: Pick<Bucket, 'get'>,
  key: string,
  record: PrivatePreview,
): Promise<PrivatePortionApproval | null> {
  if (!bucket.get) throw new Error('storage_unavailable');
  const approval = await bucket.get(`${key}/approval.json`);
  if (!approval) return null;
  const bytes = await approval.arrayBuffer();
  if (bytes.byteLength > 4096) throw new Error('invalid_approval');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_approval');
  const value = parsed as PrivatePortionApproval;
  if (
    value.schema_version !== 1 ||
    value.status !== 'approved' ||
    value.source_sha256 !== record.photo_sha256 ||
    !record.portion ||
    value.portion_sha256 !== portionHash(record.portion) ||
    typeof value.approved_by !== 'string' ||
    !id.test(value.approved_by) ||
    !Number.isFinite(Date.parse(value.approved_at))
  ) {
    throw new Error('invalid_approval');
  }
  return value;
}

export async function approvePrivatePortion(
  bucket: Bucket,
  key: string,
  actorId: string,
): Promise<PrivatePortionApproval> {
  if (!id.test(actorId)) throw new Error('invalid_actor');
  const record = await readPrivatePortion(bucket, key);
  if (!record?.portion || record.status !== 'needs_review') {
    throw new Error('portion_not_ready');
  }
  const previous = await readPrivatePortionApproval(bucket, key, record);
  if (previous) return previous;
  if (!bucket.get) throw new Error('storage_unavailable');
  for (const layer of record.portion.layers) {
    const filename = layer.depth === 0 ? 'background.svg' : 'dish.webp';
    await objectBytes(await bucket.get(`${key}/${filename}`), layer.size_bytes, layer.sha256);
  }
  const approval: PrivatePortionApproval = {
    schema_version: 1,
    status: 'approved',
    source_sha256: record.photo_sha256,
    portion_sha256: portionHash(record.portion),
    approved_by: actorId,
    approved_at: new Date().toISOString(),
  };
  await bucket.put(`${key}/approval.json`, JSON.stringify(approval));
  return approval;
}

/**
 * Trusted, authenticated export for the existing operator-owned bundle handoff.
 * It is NOT a public menu asset. The caller must verify the approved dish revision,
 * upload exact bytes to immutable public hosting and run the existing admission gate.
 */
export async function exportApprovedPrivatePortion(
  bucket: Pick<Bucket, 'get'>,
  key: string,
): Promise<{
  portion: PublicPortion;
  layers: Array<{ name: string; sha256: string; size_bytes: number; base64: string }>;
  approval: PrivatePortionApproval;
}> {
  const record = await readPrivatePortion(bucket, key);
  if (!record?.portion || record.status !== 'needs_review' || !bucket.get) {
    throw new Error('portion_not_ready');
  }
  const approval = await readPrivatePortionApproval(bucket, key, record);
  if (!approval) throw new Error('portion_not_approved');
  const layers = [];
  for (const layer of record.portion.layers) {
    const name = layer.depth === 0 ? 'background.svg' : 'dish.webp';
    const bytes = await objectBytes(
      await bucket.get(`${key}/${name}`),
      layer.size_bytes,
      layer.sha256,
    );
    layers.push({
      name,
      sha256: layer.sha256,
      size_bytes: layer.size_bytes,
      base64: Buffer.from(bytes).toString('base64'),
    });
  }
  return { portion: record.portion, layers, approval };
}
