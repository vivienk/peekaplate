import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { getDocumentProxy } from 'unpdf';
import { withOwnerMenuTransaction } from '../owner-menu';
import { safeFetch } from '../retrieval/fetcher';
import { parseHtmlSource } from '../retrieval/parser';
import { canonicalStringify } from '../review-command';
import {
  createIngestionJob,
  getIngestionJob,
  IngestionError,
  type MenuIngestionJobRow,
} from './repository';
import { readMenuUpload } from './upload';

export type MenuUpload = Awaited<ReturnType<typeof readMenuUpload>>;
export function validateUploadSelection(
  files: readonly Pick<MenuUpload, 'sourceType' | 'sourceHash'>[],
) {
  if (
    files.length < 1 ||
    files.length > 5 ||
    (files.some((file) => file.sourceType === 'pdf') && files.length !== 1)
  )
    throw new IngestionError('invalid_upload_selection', 400);
}
export async function validateMenuPdf(upload: MenuUpload) {
  if (upload.sourceType !== 'pdf') return;
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    document = await getDocumentProxy(upload.bytes.slice());
    if (document.numPages < 1 || document.numPages > 10)
      throw new IngestionError('pdf_page_limit', 400);
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError('invalid_pdf', 400);
  } finally {
    await document?.loadingTask.destroy();
  }
}

export async function materializeMenuUrl(url: string, key: string): Promise<MenuUpload> {
  let source = await safeFetch(url);
  if (source.contentType.split(';')[0]?.trim() === 'text/html') {
    const candidates = parseHtmlSource(
      source.content,
      'menu-url',
      source.finalUrl,
    ).discoveredLinks.filter((link) => /\.(pdf|png|jpe?g)(?:[?#]|$)/i.test(new URL(link).pathname));
    if (candidates.length !== 1) throw new IngestionError('menu_file_link_required', 422);
    source = await safeFetch(candidates[0]!);
  }
  const upload = await readMenuUpload(
    new Request(source.finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': source.contentType, 'Idempotency-Key': key },
      body: source.bytes as BodyInit,
    }),
  );
  await validateMenuPdf(upload);
  return upload;
}

export async function createUploadGroup(
  client: Client,
  actor: string,
  venue: string,
  uploads: readonly Pick<MenuUpload, 'sourceType' | 'sourceHash' | 'idempotencyKey'>[],
): Promise<{ id: string; jobs: MenuIngestionJobRow[] }> {
  validateUploadSelection(uploads);
  const key = uploads[0]!.idempotencyKey;
  const manifest = uploads.map((upload) => ({ type: upload.sourceType, hash: upload.sourceHash }));
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `upload-group:${venue}:${key}`,
    ]);
    const old = await client.query<{ id: string; manifest: unknown }>(
      'SELECT id,manifest FROM app_private.menu_upload_group WHERE tenant_id=$1 AND idempotency_key=$2',
      [venue, key],
    );
    const group = old.rows[0];
    if (group && canonicalStringify(group.manifest) !== canonicalStringify(manifest))
      throw new IngestionError('idempotency_conflict', 409);
    const id = group?.id ?? randomUUID();
    if (!group)
      await client.query(
        'INSERT INTO app_private.menu_upload_group(tenant_id,id,idempotency_key,manifest) VALUES($1,$2,$3,$4::jsonb)',
        [venue, id, key, JSON.stringify(manifest)],
      );
    const jobs: MenuIngestionJobRow[] = [];
    for (const [index, upload] of uploads.entries()) {
      const jobId = randomUUID();
      const job = await createIngestionJob(
        client,
        {
          id: jobId,
          tenantId: venue,
          sourceType: upload.sourceType,
          sourceHash: upload.sourceHash,
          sourceStorageKey: `menu-ingestion/sources/${venue}/${jobId}/source`,
          idempotencyKey: `group:${id}:${index}`,
        },
        { inTransaction: true },
      );
      const updated = await client.query<MenuIngestionJobRow>(
        'UPDATE app_private.menu_ingestion_jobs SET source_uploaded=CASE WHEN upload_group_id IS NULL THEN false ELSE source_uploaded END, upload_group_id=$3,upload_index=$4 WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [venue, job.id, id, index],
      );
      jobs.push(updated.rows[0]!);
    }
    return { id, jobs };
  });
}

export async function acceptUploadGroupFile(
  client: Client,
  actor: string,
  venue: string,
  groupId: string,
  index: number,
  upload: MenuUpload,
  put: (key: string, bytes: ArrayBuffer) => Promise<unknown>,
) {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `upload-group-files:${venue}:${groupId}`,
    ]);
    const group = await client.query(
      'SELECT id FROM app_private.menu_upload_group WHERE tenant_id=$1 AND id=$2',
      [venue, groupId],
    );
    if (group.rowCount !== 1) throw new IngestionError('upload_group_not_found', 404);
    const jobs = await client.query<MenuIngestionJobRow>(
      'SELECT * FROM app_private.menu_ingestion_jobs WHERE tenant_id=$1 AND upload_group_id=$2 ORDER BY upload_index FOR UPDATE',
      [venue, groupId],
    );
    const job = jobs.rows.find((row) => row.upload_index === index);
    if (!job) throw new IngestionError('job_not_found', 404);
    if (
      job.source_type !== upload.sourceType ||
      job.source_hash !== upload.sourceHash ||
      job.source_storage_key !== `menu-ingestion/sources/${venue}/${job.id}/source`
    )
      throw new IngestionError('upload_scope_mismatch', 409);
    if (job.status === 'cancelled') throw new IngestionError('job_cancelled', 409);
    if (createHash('sha256').update(upload.bytes).digest('hex') !== job.source_hash)
      throw new IngestionError('upload_scope_mismatch', 409);
    if (job.status === 'queued' || !job.source_uploaded) {
      await put(job.source_storage_key, upload.bytes.buffer as ArrayBuffer);
      await client.query(
        'UPDATE app_private.menu_ingestion_jobs SET source_uploaded=true WHERE tenant_id=$1 AND id=$2',
        [venue, job.id],
      );
      job.source_uploaded = true;
    }
    const ready = jobs.rows.every((row) => row.source_uploaded || row.status === 'cancelled');
    return { id: groupId, jobs: jobs.rows, ready };
  });
}

export async function dispatchReadyUploadGroup(
  group: { ready: boolean; jobs: MenuIngestionJobRow[] },
  queue: { send(message: unknown): Promise<void> },
) {
  if (!group.ready) return;
  for (const job of group.jobs)
    if (job.status === 'queued' && job.source_uploaded)
      await queue.send({
        version: 1,
        tenantId: job.tenant_id,
        jobId: job.id,
        queuedAt: new Date().toISOString(),
      });
}

export async function changeMenuJob(
  client: Client,
  actor: string,
  venue: string,
  jobId: string,
  commandId: string,
  action: 'cancel' | 'retry',
): Promise<MenuIngestionJobRow> {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const hash = createHash('sha256')
      .update(JSON.stringify({ commandType: `menu.job.${action}.v1`, jobId }))
      .digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venue}:${actor}:${commandId}`,
    ]);
    const receipt = await client.query<{ request_hash: string }>(
      'SELECT request_hash FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venue, actor, commandId],
    );
    if (receipt.rows[0] && receipt.rows[0].request_hash !== hash)
      throw new IngestionError('command_conflict', 409);
    const current = await client.query<MenuIngestionJobRow>(
      'SELECT * FROM app_private.menu_ingestion_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [venue, jobId],
    );
    const job = current.rows[0];
    if (!job) throw new IngestionError('job_not_found', 404);
    if (receipt.rows[0]) return job;
    if (action === 'retry' && !['failed', 'incomplete'].includes(job.status))
      throw new IngestionError('job_not_retryable', 409);
    if (
      action === 'cancel' &&
      !['queued', 'running', 'incomplete', 'cancelled'].includes(job.status)
    )
      throw new IngestionError('job_not_cancellable', 409);
    const changed = await client.query<MenuIngestionJobRow>(
      `UPDATE app_private.menu_ingestion_jobs SET status=$3,claim_token=NULL,locked_at=NULL,locked_by=NULL,lease_generation=lease_generation+1,
       finished_at=CASE WHEN $3='cancelled' THEN now() ELSE NULL END,
       max_attempts=CASE WHEN $3='queued' THEN GREATEST(max_attempts,attempt_count+3) ELSE max_attempts END
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [venue, jobId, action === 'cancel' ? 'cancelled' : 'queued'],
    );
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
      [
        randomUUID(),
        venue,
        actor,
        `menu.job.${action}.v1`,
        commandId,
        JSON.stringify({ jobId }),
        hash,
        JSON.stringify({ jobId, action }),
      ],
    );
    return changed.rows[0]!;
  });
}

export async function readMenuJob(client: Client, actor: string, venue: string, jobId: string) {
  return withOwnerMenuTransaction(client, actor, venue, () =>
    getIngestionJob(client, venue, jobId),
  );
}
