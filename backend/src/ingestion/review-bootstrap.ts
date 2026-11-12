import { ReviewCandidateResultSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { withOwnerMenuTransaction } from '../owner-menu';
import {
  type ReviewArtifactReader,
  reviewInputFromReport,
  verifyReviewArtifact,
} from '../review-artifact';
import { upsertExtractionReviewSession } from '../review-command';
import { getIngestionJob, IngestionError } from './repository';

export async function bootstrapMenuReview(
  client: Client,
  actor: string,
  venue: string,
  jobId: string,
  commandId: string,
  read: ReviewArtifactReader,
  appEnv: string | undefined,
) {
  const job = await withOwnerMenuTransaction(client, actor, venue, () =>
    getIngestionJob(client, venue, jobId, { inTransaction: true }),
  );
  if (!job) throw new IngestionError('job_not_found', 404);
  if (!['complete', 'incomplete'].includes(job.status) || !job.result_storage_key)
    throw new IngestionError('review_not_ready', 409);
  const pattern = new RegExp(
    `^reports/${venue}/${jobId}/attempts/[0-9a-f-]{36}/extraction\\.json$`,
  );
  if (!pattern.test(job.result_storage_key))
    throw new IngestionError('artifact_scope_mismatch', 409);
  const object = await read(job.result_storage_key);
  if (!object || object.size < 1 || object.size > 24_000_000)
    throw new IngestionError('artifact_unavailable', 503);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size) throw new IngestionError('artifact_scope_mismatch', 409);
  let report: unknown;
  try {
    report = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new IngestionError('artifact_scope_mismatch', 409);
  }
  const input = reviewInputFromReport(report, jobId, commandId);
  if (Buffer.byteLength(JSON.stringify(input.extractionResult), 'utf8') > 524_288)
    throw new IngestionError('review_batch_too_large', 413);
  if (
    input.extractionResult.source.sha256 !== job.source_hash ||
    input.extractionResult.status !== job.status
  )
    throw new IngestionError('artifact_scope_mismatch', 409);
  // Reuse an existing producer-bound payload so historical optional-null formatting stays stable.
  const sessions = await withOwnerMenuTransaction(client, actor, venue, async () =>
    client.query<{ payload: unknown }>(
      `SELECT payload FROM app_private.extraction_review_session WHERE tenant_id=$1 AND job_id=$2 AND private_artifact_key=$3 AND private_artifact_sha256=$4`,
      [venue, jobId, input.privateArtifactRef!.key, input.privateArtifactRef!.sha256],
    ),
  );
  if (sessions.rows.length > 1) throw new IngestionError('ambiguous_review_session', 409);
  if (sessions.rows[0])
    input.extractionResult = ReviewCandidateResultSchema.parse(sessions.rows[0].payload);
  await verifyReviewArtifact({ appEnv, venueId: venue, input, read });
  return upsertExtractionReviewSession(client, actor, venue, input, {
    jobReportKey: job.result_storage_key,
  });
}
