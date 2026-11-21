import { createHash } from 'node:crypto';
import {
  PrivateArtifactRefSchema,
  ReviewCandidateResultSchema,
  type UpsertExtractionReviewSessionRequest,
} from '@peekaplate/contracts';
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
 * Expected public box links per segment, derived exactly as the exporter derives them
 * (`review_candidates.export` via `_box_evidence_links`): each box on a draft's evidence record
 * links to the single cited, ready OCR segment of its page, keyed by draft id.
 */
function exporterBoxLinks(
  segments: readonly unknown[],
  evidence: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown[]>> {
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const segment of segments) {
    if (!isRecord(segment) || byId.has(segment.segment_id)) throw mismatch();
    byId.set(segment.segment_id, segment);
  }
  const links = new Map<string, Record<string, unknown[]>>();
  const ordered = [...evidence].sort((a, b) => Number(a.draft_index) - Number(b.draft_index));
  for (const record of ordered) {
    const boxes = record.box_evidence ?? [];
    if (!Array.isArray(boxes) || !Array.isArray(record.spans)) throw mismatch();
    if (boxes.length === 0) continue;
    const cited = new Map<unknown, Record<string, unknown>>();
    for (const span of record.spans) {
      const segment = isRecord(span) ? byId.get(span.segment_id) : undefined;
      if (!segment) throw mismatch();
      cited.set(segment.segment_id, segment);
    }
    for (const box of boxes) {
      if (!isRecord(box)) throw mismatch();
      const matches = [...cited.values()].filter(
        (segment) =>
          Number.isInteger(segment.page_number) &&
          segment.page_number === box.page_number &&
          segment.method === 'ocr_space_engine3' &&
          segment.status === 'ready' &&
          (segment.error ?? null) === null,
      );
      if (matches.length !== 1) throw mismatch();
      const segmentId = String(matches[0]?.segment_id);
      const bySegment = links.get(segmentId) ?? {};
      const draftId = String(record.draft_id);
      bySegment[draftId] = [...(bySegment[draftId] ?? []), box];
      links.set(segmentId, bySegment);
    }
  }
  return links;
}

const withoutBoxLinks = (metadata: unknown) => {
  if (!isRecord(metadata)) return metadata;
  const { candidate_box_evidence: _links, ...rest } = metadata;
  return rest;
};

/** Same public candidate projection as the Python exporter; the verifier below binds originals. */
export function reviewInputFromReport(
  report: unknown,
  jobId: string,
  commandId: string,
): UpsertExtractionReviewSessionRequest {
  try {
    if (
      !isRecord(report) ||
      !isRecord(report.source) ||
      !isRecord(report.configuration) ||
      !Array.isArray(report.drafts) ||
      !Array.isArray(report.evidence) ||
      !Array.isArray(report.segments)
    )
      throw mismatch();
    const evidence = report.evidence as Record<string, unknown>[];
    const links = exporterBoxLinks(report.segments, evidence);
    const source = report.source;
    const pythonStartedAt = String(report.started_at).replace(
      /(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
      (_match, fraction: string | undefined, zone: string) =>
        `${fraction && Number(fraction) !== 0 ? `.${fraction.padEnd(6, '0')}` : ''}${zone === 'Z' ? '+00:00' : zone}`,
    );
    const identity = `${source.source_id}:${pythonStartedAt}:${report.pipeline_version}`;
    const fields = [
      'description',
      'category',
      'price_amount',
      'price_currency',
      'ingredients',
    ] as const;
    const result = ReviewCandidateResultSchema.parse({
      schema_version: report.schema_version,
      extraction_id: `extraction:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
      pipeline_version: report.pipeline_version,
      status: report.status,
      started_at: report.started_at,
      finished_at: report.finished_at,
      extraction_model: report.extraction_model,
      source: {
        source_id: source.source_id,
        sha256: source.sha256,
        kind: source.kind,
        location: source.location,
        retrieved_at: source.retrieved_at,
        size_bytes: source.size_bytes,
      },
      segments: report.segments.map((segment) => {
        if (!isRecord(segment)) throw mismatch();
        const mapping = links.get(String(segment.segment_id));
        return {
          ...segment,
          metadata: {
            ...(isRecord(segment.metadata) ? segment.metadata : {}),
            ...(mapping ? { candidate_box_evidence: mapping } : {}),
          },
        };
      }),
      candidates: report.drafts.map((draft, index) => {
        if (!isRecord(draft)) throw mismatch();
        const record = evidence.find((item) => item.draft_index === index);
        if (!record) throw mismatch();
        return {
          candidate_id: record.draft_id,
          original: draft,
          evidence: record.spans,
          missing_fields: fields.filter(
            (field) =>
              draft[field] === null && !(field === 'price_amount' && draft.price_text != null),
          ),
        };
      }),
      warnings: report.warnings,
      errors: report.errors,
    });
    return {
      commandId,
      jobId,
      privateArtifactRef: PrivateArtifactRefSchema.parse(
        report.configuration.private_review_artifact,
      ),
      extractionResult: result,
    };
  } catch (error) {
    if (error instanceof ReviewCommandError) throw error;
    throw mismatch();
  }
}

/**
 * Binds a review session's immutable originals to the producer's stored attempt bundle.
 *
 * The extraction host writes `menu-ingestion/review-artifacts/{tenant}/{job}/{attempt}/bundle.json`
 * and returns its SHA-256 as `private_review_artifact`. A staff client may only register a session
 * whose source, versions, status and every candidate's original draft and evidence spans equal that
 * bundle's report, so an editor cannot introduce originals that the producer never emitted.
 *
 * Page coverage and diagnostics are bound the same way: the request must carry every report
 * segment in order (status, error, text and metadata included) and the report's `warnings` and
 * `errors`, so failed or skipped pages cannot be hidden from reviewers. The only permitted
 * difference is the exporter-added `metadata.candidate_box_evidence`, which must equal the links
 * the exporter derives from the report's evidence box records (absent when there are none).
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
    report.source.kind !== result.source.kind ||
    report.source.location !== result.source.location ||
    report.source.size_bytes !== result.source.size_bytes ||
    typeof report.source.retrieved_at !== 'string' ||
    Date.parse(report.source.retrieved_at) !== Date.parse(result.source.retrieved_at) ||
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

  // Page coverage and diagnostics: every report segment, in order, and the report's warnings and
  // errors. Box links are the one exporter-added field and must equal the derived links.
  const segments = report.segments;
  if (!Array.isArray(segments) || segments.length !== result.segments.length) throw mismatch();
  const links = exporterBoxLinks(segments, evidence as Record<string, unknown>[]);
  for (const [index, requested] of result.segments.entries()) {
    const stored = segments[index];
    if (!isRecord(stored)) throw mismatch();
    const requestedLinks = isRecord(requested.metadata)
      ? requested.metadata.candidate_box_evidence
      : undefined;
    const expectedLinks = links.get(String(stored.segment_id));
    if (
      !sameProducerValue(
        { ...requested, metadata: withoutBoxLinks(requested.metadata) },
        { ...stored, metadata: withoutBoxLinks(stored.metadata) },
      ) ||
      (expectedLinks
        ? !sameProducerValue(requestedLinks, expectedLinks)
        : requestedLinks !== undefined)
    )
      throw mismatch();
  }
  if (
    !sameProducerValue(result.warnings, report.warnings) ||
    !sameProducerValue(result.errors, report.errors)
  )
    throw mismatch();
}
