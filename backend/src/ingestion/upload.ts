import { createHash } from 'node:crypto';
import type { MenuIngestionJobRow } from './repository';
import { IngestionError } from './repository';

export const MAX_MENU_UPLOAD_BYTES = 12_000_000;

export async function readMenuUpload(request: Request) {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(type ?? '')) {
    throw new IngestionError('unsupported_media_type', 415);
  }
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new IngestionError('invalid_idempotency_key', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new IngestionError('empty_upload', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MENU_UPLOAD_BYTES) {
        await reader.cancel();
        throw new IngestionError('body_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const magic = [...bytes.subarray(0, 8)];
  const valid =
    (type === 'application/pdf' && String.fromCharCode(...magic.slice(0, 5)) === '%PDF-') ||
    (type === 'image/jpeg' && magic[0] === 255 && magic[1] === 216 && magic[2] === 255) ||
    (type === 'image/png' && magic.join(',') === '137,80,78,71,13,10,26,10');
  if (!valid) throw new IngestionError('invalid_upload_format', 400);
  return {
    bytes,
    sourceType: type === 'application/pdf' ? ('pdf' as const) : ('photo' as const),
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    idempotencyKey,
  };
}

// Caller must authorize the actor's venue before reading bytes or invoking this function.
// Job creation is idempotent; retries can repair storage or dispatch failures.
export async function storeAndDispatchUpload(
  venueId: string,
  upload: Awaited<ReturnType<typeof readMenuUpload>>,
  createJob: () => Promise<MenuIngestionJobRow>,
  storage: { put(key: string, bytes: ArrayBuffer): Promise<unknown> },
  queue: { send(message: unknown): Promise<void> },
) {
  const job = await createJob();
  const expectedKey = `menu-ingestion/sources/${venueId}/${job.id}/source`;
  if (
    job.tenant_id !== venueId ||
    job.source_storage_key !== expectedKey ||
    job.source_hash !== upload.sourceHash
  ) {
    throw new IngestionError('upload_scope_mismatch', 409);
  }
  await storage.put(expectedKey, upload.bytes.buffer as ArrayBuffer);
  await queue.send({
    version: 1,
    tenantId: venueId,
    jobId: job.id,
    queuedAt: new Date().toISOString(),
  });
  return job;
}
