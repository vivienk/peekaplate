import { createHash, randomUUID } from 'node:crypto';
import type {
  CandidateReviewRecord,
  ExtractionReviewSessionResponse,
  ResolvedCandidateFields,
  ReviewCandidate,
  ReviewCandidateCommand,
  ReviewCandidateItemResponse,
  ReviewCandidateResult,
  ReviewEditableField,
  UpsertExtractionReviewSessionRequest,
} from '@peekaplate/contracts';
import {
  CandidateReviewRecordSchema,
  ExtractionReviewSessionResponseSchema,
  ResolvedCandidateFieldsSchema,
  ReviewCandidateItemResponseSchema,
  ReviewCandidateResultSchema,
} from '@peekaplate/contracts';
import type { Client } from 'pg';

export type CandidateReviewEvent = {
  id: string;
  tenantId: string;
  streamType: string;
  streamId: string;
  version: number;
  schemaVersion: number;
  eventType: string;
  payload: unknown;
  metadata: unknown;
  occurredAt?: string | Date;
};

export type ExtractionReviewSessionRow = {
  tenant_id: string;
  extraction_id: string;
  schema_version: number;
  pipeline_version: string;
  extraction_status: string;
  source_id: string;
  source_sha256: string;
  job_id: string | null;
  private_artifact_key: string | null;
  private_artifact_sha256: string | null;
  payload: unknown;
  created_by: string;
  created_at: string | Date;
};

export type CandidateReviewRow = {
  tenant_id: string;
  extraction_id: string;
  candidate_id: string;
  stream_id: string;
  version: number;
  revision_id: string;
  review_status: 'corrected' | 'rejected' | 'incomplete';
  corrected_fields: Record<string, unknown>;
  edited_fields: string[];
  incomplete_fields: string[];
  review_note: string | null;
  reviewed_by: string;
  reviewed_at: string | Date;
};
export function canonicalStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify((val as Record<string, unknown>)[key])}`,
  );
  return `{${pairs.join(',')}}`;
}

export class ReviewCommandError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'command_conflict'
      | 'extraction_conflict'
      | 'invalid_candidate',
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(code);
    this.name = 'ReviewCommandError';
  }
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export function candidateStreamId(
  venueId: string,
  extractionId: string,
  candidateId: string,
): string {
  const digest = createHash('sha256')
    .update(`candidate_review:${venueId}:${extractionId}:${candidateId}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export function resolveEffectiveFields(
  candidate: ReviewCandidate,
  corrected: CandidateReviewRecord['corrected'],
): ResolvedCandidateFields {
  return ResolvedCandidateFieldsSchema.parse({
    name: corrected.name !== undefined ? corrected.name : candidate.original.name,
    description:
      corrected.description !== undefined ? corrected.description : candidate.original.description,
    category: corrected.category !== undefined ? corrected.category : candidate.original.category,
    subcategory:
      corrected.subcategory !== undefined ? corrected.subcategory : candidate.original.subcategory,
    category_page_number: candidate.original.category_page_number,
    price_text:
      corrected.price_text !== undefined ? corrected.price_text : candidate.original.price_text,
    price_amount:
      corrected.price_amount !== undefined
        ? corrected.price_amount
        : candidate.original.price_amount,
    price_currency:
      corrected.price_currency !== undefined
        ? corrected.price_currency
        : candidate.original.price_currency,
    ingredients:
      corrected.ingredients !== undefined ? corrected.ingredients : candidate.original.ingredients,
  });
}

export function buildReviewSessionResponse(
  venueId: string,
  sessionRow: ExtractionReviewSessionRow,
  reviewRows: readonly CandidateReviewRow[],
): ExtractionReviewSessionResponse {
  const extractionResult = ReviewCandidateResultSchema.parse(sessionRow.payload);
  const reviewRowsByCandidateId = new Map(reviewRows.map((r) => [r.candidate_id, r]));

  const items: ReviewCandidateItemResponse[] = extractionResult.candidates.map((candidate) => {
    const row = reviewRowsByCandidateId.get(candidate.candidate_id);
    const reviewRecord: CandidateReviewRecord = row
      ? CandidateReviewRecordSchema.parse({
          extractionId: sessionRow.extraction_id,
          candidateId: candidate.candidate_id,
          revisionId: row.revision_id,
          version: row.version,
          reviewStatus: row.review_status,
          corrected: row.corrected_fields,
          editedFields: row.edited_fields,
          incompleteFields: row.incomplete_fields,
          reviewNote: row.review_note,
          reviewedBy: row.reviewed_by,
          reviewedAt:
            row.reviewed_at instanceof Date
              ? row.reviewed_at.toISOString()
              : new Date(row.reviewed_at).toISOString(),
          publishable: false,
        })
      : {
          extractionId: sessionRow.extraction_id,
          candidateId: candidate.candidate_id,
          revisionId: null,
          version: 0,
          reviewStatus: 'pending',
          corrected: {},
          editedFields: [],
          incompleteFields: [],
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
          publishable: false,
        };

    const effective = resolveEffectiveFields(candidate, reviewRecord.corrected);
    return {
      candidate,
      review: reviewRecord,
      effective,
    };
  });

  return ExtractionReviewSessionResponseSchema.parse({
    schemaVersion: 1,
    venueId,
    extractionResult,
    items,
    privateArtifactRef:
      sessionRow.private_artifact_key && sessionRow.private_artifact_sha256
        ? {
            schema_version: 1,
            key: sessionRow.private_artifact_key,
            sha256: sessionRow.private_artifact_sha256,
          }
        : null,
    published: false,
  });
}

export async function upsertExtractionReviewSession(
  client: Client,
  actorId: string,
  venueId: string,
  input: UpsertExtractionReviewSessionRequest,
): Promise<ExtractionReviewSessionResponse> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? '')) {
      throw new ReviewCommandError('forbidden', 403);
    }

    if (input.privateArtifactRef) {
      const expectedPrefix = `menu-ingestion/review-artifacts/${venueId}/`;
      if (!input.privateArtifactRef.key.startsWith(expectedPrefix)) {
        throw new ReviewCommandError('invalid_candidate', 400);
      }
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const commandHash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: 'extraction.review_session.register',
          extractionId: input.extractionResult.extraction_id,
          commandId: input.commandId,
          jobId: input.jobId ?? null,
          privateArtifactRef: input.privateArtifactRef ?? null,
        }),
      )
      .digest('hex');

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${input.commandId}`,
    ]);

    const existingCommand = await client.query<{ request_hash: string; result: unknown }>(
      `SELECT request_hash, result
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [venueId, actorId, input.commandId],
    );
    if (existingCommand.rows[0]) {
      if (existingCommand.rows[0].request_hash !== commandHash) {
        throw new ReviewCommandError('command_conflict', 409);
      }
      await client.query('COMMIT');
      started = false;
      return ExtractionReviewSessionResponseSchema.parse(existingCommand.rows[0].result);
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `review-session:${venueId}:${input.extractionResult.extraction_id}`,
    ]);

    const existingSession = await client.query<ExtractionReviewSessionRow>(
      `SELECT tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
              source_id, source_sha256, job_id, private_artifact_key, private_artifact_sha256,
              payload, created_by, created_at
       FROM app_private.extraction_review_session
       WHERE tenant_id = $1 AND extraction_id = $2`,
      [venueId, input.extractionResult.extraction_id],
    );

    const inputPayloadString = JSON.stringify(input.extractionResult);
    const inputPayloadHash = createHash('sha256')
      .update(canonicalStringify(input.extractionResult))
      .digest('hex');

    if (existingSession.rows[0]) {
      const existingRow = existingSession.rows[0];
      const existingPayloadHash = createHash('sha256')
        .update(canonicalStringify(existingRow.payload))
        .digest('hex');
      if (existingPayloadHash !== inputPayloadHash) {
        throw new ReviewCommandError('extraction_conflict', 409);
      }

      const reviewRows = await client.query<CandidateReviewRow>(
        `SELECT tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
                review_status, corrected_fields, edited_fields, incomplete_fields,
                review_note, reviewed_by, reviewed_at
         FROM app_private.candidate_review_current
         WHERE tenant_id = $1 AND extraction_id = $2`,
        [venueId, input.extractionResult.extraction_id],
      );

      const response = buildReviewSessionResponse(venueId, existingRow, reviewRows.rows);

      await client.query(
        `INSERT INTO app_private.es_command
          (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
         VALUES ($1, $2, $3, 'extraction.review_session.register', $4, $5::jsonb, $6, $7::jsonb)`,
        [
          randomUUID(),
          venueId,
          actorId,
          input.commandId,
          JSON.stringify({
            extractionId: input.extractionResult.extraction_id,
            jobId: input.jobId ?? null,
          }),
          commandHash,
          JSON.stringify(response),
        ],
      );

      await client.query('COMMIT');
      started = false;
      return response;
    }

    const sessionInsert = await client.query<ExtractionReviewSessionRow>(
      `INSERT INTO app_private.extraction_review_session
        (tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
         source_id, source_sha256, job_id, private_artifact_key, private_artifact_sha256,
         payload, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       RETURNING tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
                 source_id, source_sha256, job_id, private_artifact_key, private_artifact_sha256,
                 payload, created_by, created_at`,
      [
        venueId,
        input.extractionResult.extraction_id,
        input.extractionResult.schema_version,
        input.extractionResult.pipeline_version,
        input.extractionResult.status,
        input.extractionResult.source.source_id,
        input.extractionResult.source.sha256,
        input.jobId ?? null,
        input.privateArtifactRef?.key ?? null,
        input.privateArtifactRef?.sha256 ?? null,
        inputPayloadString,
        actorId,
      ],
    );

    const createdRow = sessionInsert.rows[0];
    if (!createdRow) {
      throw new Error('Failed to create review session');
    }
    const response = buildReviewSessionResponse(venueId, createdRow, []);

    await client.query(
      `INSERT INTO app_private.es_command
        (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
       VALUES ($1, $2, $3, 'extraction.review_session.register', $4, $5::jsonb, $6, $7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        input.commandId,
        JSON.stringify({
          extractionId: input.extractionResult.extraction_id,
          jobId: input.jobId ?? null,
        }),
        commandHash,
        JSON.stringify(response),
      ],
    );

    await client.query('COMMIT');
    started = false;
    return response;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export async function getExtractionReviewSession(
  client: Client,
  actorId: string,
  venueId: string,
  extractionId: string,
): Promise<ExtractionReviewSessionResponse> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? '')) {
      throw new ReviewCommandError('forbidden', 403);
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const sessionResult = await client.query<ExtractionReviewSessionRow>(
      `SELECT tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
              source_id, source_sha256, job_id, private_artifact_key, private_artifact_sha256,
              payload, created_by, created_at
       FROM app_private.extraction_review_session
       WHERE tenant_id = $1 AND extraction_id = $2`,
      [venueId, extractionId],
    );
    if (!sessionResult.rows[0]) {
      throw new ReviewCommandError('not_found', 404);
    }

    const reviewRows = await client.query<CandidateReviewRow>(
      `SELECT tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
              review_status, corrected_fields, edited_fields, incomplete_fields,
              review_note, reviewed_by, reviewed_at
       FROM app_private.candidate_review_current
       WHERE tenant_id = $1 AND extraction_id = $2`,
      [venueId, extractionId],
    );

    await client.query('COMMIT');
    started = false;
    return buildReviewSessionResponse(venueId, sessionResult.rows[0], reviewRows.rows);
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export async function saveCandidateReviewCommand(
  client: Client,
  actorId: string,
  venueId: string,
  extractionId: string,
  candidateId: string,
  input: ReviewCandidateCommand,
): Promise<ReviewCandidateItemResponse> {
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? '')) {
      throw new ReviewCommandError('forbidden', 403);
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const commandHash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: 'candidate.review.save',
          extractionId,
          candidateId,
          expectedVersion: input.expectedVersion,
          action: input.action,
          corrected: input.corrected ?? null,
          incompleteFields: input.incompleteFields ?? null,
          reviewNote: input.reviewNote ?? null,
        }),
      )
      .digest('hex');

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${input.commandId}`,
    ]);

    const existingCommand = await client.query<{ request_hash: string; result: unknown }>(
      `SELECT request_hash, result
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [venueId, actorId, input.commandId],
    );
    if (existingCommand.rows[0]) {
      if (existingCommand.rows[0].request_hash !== commandHash) {
        throw new ReviewCommandError('command_conflict', 409);
      }
      await client.query('COMMIT');
      started = false;
      return ReviewCandidateItemResponseSchema.parse(existingCommand.rows[0].result);
    }

    const sessionResult = await client.query<ExtractionReviewSessionRow>(
      `SELECT tenant_id, extraction_id, schema_version, pipeline_version, extraction_status,
              source_id, source_sha256, job_id, private_artifact_key, private_artifact_sha256,
              payload, created_by, created_at
       FROM app_private.extraction_review_session
       WHERE tenant_id = $1 AND extraction_id = $2`,
      [venueId, extractionId],
    );
    if (!sessionResult.rows[0]) {
      throw new ReviewCommandError('not_found', 404);
    }

    const extractionResult = ReviewCandidateResultSchema.parse(sessionResult.rows[0].payload);
    const candidate = extractionResult.candidates.find((c) => c.candidate_id === candidateId);
    if (!candidate) {
      throw new ReviewCommandError('not_found', 404);
    }

    if (extractionResult.schema_version === 1 && input.corrected) {
      if (input.corrected.subcategory !== undefined || input.corrected.price_text !== undefined) {
        throw new ReviewCommandError('invalid_candidate', 400);
      }
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `candidate-review:${venueId}:${extractionId}:${candidateId}`,
    ]);

    const currentResult = await client.query<CandidateReviewRow>(
      `SELECT tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
              review_status, corrected_fields, edited_fields, incomplete_fields,
              review_note, reviewed_by, reviewed_at
       FROM app_private.candidate_review_current
       WHERE tenant_id = $1 AND extraction_id = $2 AND candidate_id = $3`,
      [venueId, extractionId, candidateId],
    );

    const currentRow = currentResult.rows[0];
    const currentVersion = currentRow?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new ReviewCommandError('version_conflict', 409);
    }

    const version = currentVersion + 1;
    const revisionId = randomUUID();
    const eventId = randomUUID();
    const streamId = candidateStreamId(venueId, extractionId, candidateId);

    let reviewStatus: 'corrected' | 'rejected' | 'incomplete';
    let correctedFields: Record<string, unknown> = {};
    let editedFields: ReviewEditableField[] = [];
    let incompleteFields: ReviewEditableField[] = [];
    const reviewNote =
      input.reviewNote !== undefined ? input.reviewNote : (currentRow?.review_note ?? null);

    if (input.action === 'correct') {
      reviewStatus = 'corrected';
      const priorCorrected =
        currentRow?.review_status === 'corrected' || currentRow?.review_status === 'incomplete'
          ? (currentRow.corrected_fields ?? {})
          : {};
      correctedFields = { ...priorCorrected, ...input.corrected };
      editedFields = (Object.keys(correctedFields) as ReviewEditableField[])
        .filter((k) => correctedFields[k] !== undefined)
        .sort();
      const priorIncomplete = (currentRow?.incomplete_fields ?? []) as ReviewEditableField[];
      incompleteFields =
        input.incompleteFields ?? priorIncomplete.filter((f) => !(f in (input.corrected ?? {})));
    } else if (input.action === 'mark_incomplete') {
      reviewStatus = 'incomplete';
      incompleteFields = input.incompleteFields ?? [];
      const priorCorrected =
        currentRow?.review_status === 'corrected' || currentRow?.review_status === 'incomplete'
          ? (currentRow.corrected_fields ?? {})
          : {};
      if (input.corrected) {
        correctedFields = { ...priorCorrected, ...input.corrected };
        editedFields = (Object.keys(correctedFields) as ReviewEditableField[])
          .filter((k) => correctedFields[k] !== undefined)
          .sort();
      } else {
        correctedFields = priorCorrected;
        editedFields = (currentRow?.edited_fields ?? []) as ReviewEditableField[];
      }
    } else {
      // reject
      reviewStatus = 'rejected';
      correctedFields = {};
      editedFields = [];
      incompleteFields = [];
    }

    const reviewedAt = new Date().toISOString();

    const reviewRecord: CandidateReviewRecord = CandidateReviewRecordSchema.parse({
      extractionId,
      candidateId,
      revisionId,
      version,
      reviewStatus,
      corrected: correctedFields,
      editedFields,
      incompleteFields,
      reviewNote,
      reviewedBy: actorId,
      reviewedAt,
      publishable: false,
    });

    const effective = resolveEffectiveFields(candidate, reviewRecord.corrected);
    const itemResponse: ReviewCandidateItemResponse = {
      candidate,
      review: reviewRecord,
      effective,
    };

    const eventPayload = JSON.stringify({
      ...reviewRecord,
      commandId: input.commandId,
    });

    await client.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata)
       VALUES ($1, $2, 'candidate_review', $3, $4, 1, 'candidate.review.saved', $5::jsonb, $6::jsonb)`,
      [
        eventId,
        venueId,
        streamId,
        version,
        eventPayload,
        JSON.stringify({ actorId, extractionId, candidateId }),
      ],
    );

    if (currentRow) {
      await client.query(
        `UPDATE app_private.candidate_review_current
         SET version = $4, revision_id = $5, review_status = $6, corrected_fields = $7::jsonb,
             edited_fields = $8, incomplete_fields = $9, review_note = $10,
             reviewed_by = $11, reviewed_at = $12
         WHERE tenant_id = $1 AND extraction_id = $2 AND candidate_id = $3`,
        [
          venueId,
          extractionId,
          candidateId,
          version,
          revisionId,
          reviewStatus,
          JSON.stringify(correctedFields),
          editedFields,
          incompleteFields,
          reviewNote,
          actorId,
          reviewedAt,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO app_private.candidate_review_current
          (tenant_id, extraction_id, candidate_id, stream_id, version, revision_id,
           review_status, corrected_fields, edited_fields, incomplete_fields, review_note,
           reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
        [
          venueId,
          extractionId,
          candidateId,
          streamId,
          version,
          revisionId,
          reviewStatus,
          JSON.stringify(correctedFields),
          editedFields,
          incompleteFields,
          reviewNote,
          actorId,
          reviewedAt,
        ],
      );
    }

    await client.query(
      `INSERT INTO app_private.es_command
        (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
       VALUES ($1, $2, $3, 'candidate.review.save', $4, $5::jsonb, $6, $7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        input.commandId,
        JSON.stringify({
          extractionId,
          candidateId,
          expectedVersion: input.expectedVersion,
          action: input.action,
        }),
        commandHash,
        JSON.stringify(itemResponse),
      ],
    );

    await client.query(
      `INSERT INTO app_private.outbox (id, tenant_id, event_id, topic, payload)
       VALUES ($1, $2, $3, 'candidate.review.saved', $4::jsonb)`,
      [
        randomUUID(),
        venueId,
        eventId,
        JSON.stringify({ eventId, extractionId, candidateId, revisionId, version }),
      ],
    );

    await client.query('COMMIT');
    started = false;
    return itemResponse;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export function replayCandidateReview(
  events: readonly CandidateReviewEvent[],
): CandidateReviewRecord | null {
  if (events.length === 0) return null;
  const first = events[0];
  if (!first || first.streamType !== 'candidate_review') {
    throw new ReplayError('mixed stream replay');
  }

  let record: CandidateReviewRecord | null = null;
  for (const event of events) {
    if (
      event.tenantId !== first.tenantId ||
      event.streamType !== 'candidate_review' ||
      event.streamId !== first.streamId ||
      event.version !== (record?.version ?? 0) + 1
    ) {
      throw new ReplayError('candidate review stream is not contiguous');
    }
    if (event.schemaVersion !== 1 || event.eventType !== 'candidate.review.saved') {
      throw new ReplayError('unsupported candidate review event');
    }
    if (!event.payload || typeof event.payload !== 'object') {
      throw new ReplayError('candidate review event payload is invalid');
    }
    const payload = event.payload as Record<string, unknown>;
    const parsed = CandidateReviewRecordSchema.safeParse({
      extractionId: payload.extractionId,
      candidateId: payload.candidateId,
      revisionId: payload.revisionId,
      version: payload.version,
      reviewStatus: payload.reviewStatus,
      corrected: payload.corrected ?? {},
      editedFields: payload.editedFields ?? [],
      incompleteFields: payload.incompleteFields ?? [],
      reviewNote: payload.reviewNote ?? null,
      reviewedBy:
        (event.metadata as { actorId?: string } | undefined)?.actorId ?? payload.reviewedBy ?? null,
      reviewedAt:
        payload.reviewedAt ??
        (event.occurredAt instanceof Date
          ? event.occurredAt.toISOString()
          : event.occurredAt
            ? new Date(event.occurredAt).toISOString()
            : undefined),
      publishable: false,
    });
    if (!parsed.success || parsed.data.version !== event.version) {
      throw new ReplayError('candidate review event payload does not match its stream');
    }
    record = parsed.data;
  }
  return record;
}
