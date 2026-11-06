import { createHash } from 'node:crypto';
import type { UpsertExtractionReviewSessionRequest } from '@peekaplate/contracts';
import { canonicalStringify, ReviewCommandError } from './review-command';

/** Same ceiling the extraction host applies when it stores the attempt bundle. */
export const MAX_REVIEW_ARTIFACT_BYTES = 32_000_000;

export type ReviewArtifactObject = { size: number; arrayBuffer(): Promise<ArrayBuffer> };
export type ReviewArtifactReader = (key: string) => Promise<ReviewArtifactObject | null>;

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mismatch = () => new ReviewCommandError('artifact_mismatch', 409);

/**
 * The exporter omits optional fields that are null in the report (for example `subcategory` or
 * `price_text`), so a null in the report and an omitted field in the export are the same value.
 * Any non-null difference still fails.
 */
function withoutNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNullFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null && field !== undefined)
      .map(([key, field]) => [key, withoutNullFields(field)]),
  );
}

const sameProducerValue = (left: unknown, right: unknown) =>
  canonicalStringify(withoutNullFields(left)) === canonicalStringify(withoutNullFields(right));

/**
 * Binds a review session's immutable originals to the producer's stored attempt bundle.
 *
 * The extraction host writes `menu-ingestion/review-artifacts/{tenant}/{job}/{attempt}/bundle.json`
 * and returns its SHA-256 as `private_review_artifact`. A staff client may only register a session
 * whose source, versions, status and every candidate's original draft and evidence spans equal that
 * bundle's report, so an editor cannot introduce originals that the producer never emitted.
 *
 * Outside `local`, the reference and job id are required. Locally they stay optional so fixture
 * journeys keep working; a supplied reference is still verified.
 */
export async function verifyReviewArtifact(options: {
  appEnv: string | undefined;
  venueId: string;
  input: UpsertExtractionReviewSessionRequest;
  read: ReviewArtifactReader | undefined;
}): Promise<void> {
  const { appEnv, input } = options;
  const venueId = options.venueId.toLowerCase();
  const ref = input.privateArtifactRef ?? null;
  if (!ref) {
    if (appEnv === 'local') return;
    throw new ReviewCommandError('artifact_required', 400);
  }
  const jobId = input.jobId?.toLowerCase();
  if (!jobId) throw new ReviewCommandError('artifact_required', 400);

  const keyPattern = new RegExp(
    `^menu-ingestion/review-artifacts/${venueId}/${jobId}/(${uuidPattern})/bundle\\.json$`,
  );
  const keyMatch = keyPattern.exec(ref.key);
  if (!keyMatch) throw new ReviewCommandError('invalid_candidate', 400);
  const attemptId = keyMatch[1];

  if (!options.read) throw new ReviewCommandError('artifact_unavailable', 503);
  const object = await options.read(ref.key);
  if (!object) throw new ReviewCommandError('artifact_not_found', 404);
  if (object.size <= 0 || object.size > MAX_REVIEW_ARTIFACT_BYTES) throw mismatch();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw mismatch();
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw mismatch();

  let bundle: unknown;
  try {
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw mismatch();
  }
  if (!isRecord(bundle) || !isRecord(bundle.scope) || !isRecord(bundle.report)) throw mismatch();
  const { scope, report } = bundle;
  if (
    scope.tenant_id !== venueId ||
    scope.job_id !== jobId ||
    scope.attempt_id !== attemptId ||
    !isRecord(report.source)
  )
    throw mismatch();

  const result = input.extractionResult;
  if (
    report.schema_version !== result.schema_version ||
    report.pipeline_version !== result.pipeline_version ||
    report.status !== result.status ||
    report.source.source_id !== result.source.source_id ||
    report.source.sha256 !== result.source.sha256 ||
    scope.source_hash !== result.source.sha256 ||
    typeof report.started_at !== 'string' ||
    Date.parse(report.started_at) !== Date.parse(result.started_at)
  )
    throw mismatch();

  // The exporter maps drafts[i] with evidence[draft_index=i] to one candidate per draft.
  const drafts = report.drafts;
  const evidence = report.evidence;
  if (!Array.isArray(drafts) || !Array.isArray(evidence)) throw mismatch();
  if (evidence.length !== drafts.length || result.candidates.length !== drafts.length)
    throw mismatch();
  const byDraftId = new Map<string, { draft: unknown; spans: unknown }>();
  for (const record of evidence) {
    if (
      !isRecord(record) ||
      typeof record.draft_id !== 'string' ||
      typeof record.draft_index !== 'number' ||
      !Number.isInteger(record.draft_index) ||
      record.draft_index < 0 ||
      record.draft_index >= drafts.length ||
      byDraftId.has(record.draft_id)
    )
      throw mismatch();
    byDraftId.set(record.draft_id, { draft: drafts[record.draft_index], spans: record.spans });
  }
  for (const candidate of result.candidates) {
    const produced = byDraftId.get(candidate.candidate_id);
    if (
      !produced ||
      !sameProducerValue(candidate.original, produced.draft) ||
      !sameProducerValue(candidate.evidence, produced.spans)
    )
      throw mismatch();
  }
}
