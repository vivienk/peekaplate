import type { StructuredDishDraft } from '@peekaplate/contracts';

export type DatabaseClient = {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[] | undefined,
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

export class IngestionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    message?: string | undefined,
  ) {
    super(message ?? code);
    this.name = 'IngestionError';
  }
}

export type MenuIngestionJobRow = {
  id: string;
  tenant_id: string;
  source_type: 'url' | 'pdf' | 'photo' | 'text';
  source_url: string | null;
  source_hash: string | null;
  source_storage_key: string | null;
  result_storage_key: string | null;
  idempotency_key: string;
  status: 'queued' | 'running' | 'complete' | 'incomplete' | 'failed';
  attempt_count: number;
  max_attempts: number;
  claim_token: string | null;
  lease_generation: string;
  locked_at: string | null;
  locked_by: string | null;
  error_code: string | null;
  error_details: string | null;
  draft_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type DishDraftRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  draft_id: string;
  candidate_id?: string | null;
  draft_index: number;
  name: string;
  description: string | null;
  category: string | null;
  subcategory?: string | null;
  category_page_number?: number | null;
  price_text?: string | null;
  price_amount: string | null;
  price_currency: string | null;
  ingredients: unknown[] | null;
  source_id: string;
  source_text: string;
  image_id: string | null;
  evidence: Record<string, unknown>;
  review_warnings: string[];
  extraction_status: 'needs_review';
  review_status: 'pending' | 'accepted' | 'rejected' | 'edited' | 'superseded';
  reviewed_by: string | null;
  reviewed_at: string | null;
  published_dish_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Creates or retrieves an idempotent menu ingestion job.
 */
export async function createIngestionJob(
  client: DatabaseClient,
  params: {
    id?: string | undefined;
    tenantId: string;
    sourceType: 'url' | 'pdf' | 'photo' | 'text';
    sourceUrl?: string | null | undefined;
    sourceHash?: string | null | undefined;
    sourceStorageKey?: string | null | undefined;
    idempotencyKey: string;
    maxAttempts?: number | undefined;
  },
): Promise<MenuIngestionJobRow> {
  const id = params.id ?? crypto.randomUUID();
  const maxAttempts = params.maxAttempts ?? 3;

  const result = await client.query<MenuIngestionJobRow>(
    `INSERT INTO app_private.menu_ingestion_jobs (
      id, tenant_id, source_type, source_url, source_hash, source_storage_key, idempotency_key, max_attempts
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
      SET id = app_private.menu_ingestion_jobs.id
    RETURNING *;`,
    [
      id,
      params.tenantId,
      params.sourceType,
      params.sourceUrl ?? null,
      params.sourceHash ?? null,
      params.sourceStorageKey ?? null,
      params.idempotencyKey,
      maxAttempts,
    ],
  );

  const row = result.rows[0];
  if (!row) throw new IngestionError('job_creation_failed', 500);
  return row;
}

/**
 * Atomically claims a queued, timed-out running, or incomplete job.
 * Grants a new claim_token and increments lease_generation.
 */
export async function claimIngestionJob(
  client: DatabaseClient,
  params: {
    tenantId: string;
    jobId: string;
    workerId: string;
    leaseTimeoutMinutes?: number | undefined;
  },
): Promise<{ claimToken: string; leaseGeneration: string } | null> {
  const timeout = params.leaseTimeoutMinutes ?? 10;
  const result = await client.query<{ claim_token: string; lease_generation: string }>(
    `UPDATE app_private.menu_ingestion_jobs
     SET status = 'running',
         claim_token = gen_random_uuid(),
         lease_generation = lease_generation + 1,
         locked_at = now(),
         locked_by = $1,
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, now()),
         finished_at = NULL
     WHERE id = $2 AND tenant_id = $3
       AND (
         status = 'queued'
         OR (status = 'running' AND locked_at < now() - ($4 || ' minutes')::interval)
         OR (status = 'incomplete' AND attempt_count < max_attempts)
       )
     RETURNING claim_token, lease_generation;`,
    [params.workerId, params.jobId, params.tenantId, timeout.toString()],
  );

  if (!result.rows[0]) return null;
  return {
    claimToken: result.rows[0].claim_token,
    leaseGeneration: result.rows[0].lease_generation,
  };
}

/**
 * Renews an active worker lease to prevent timeout during long operations.
 */
export async function renewJobLease(
  client: DatabaseClient,
  params: {
    tenantId: string;
    jobId: string;
    claimToken: string;
    leaseTimeoutMinutes?: number | undefined;
  },
): Promise<boolean> {
  const timeout = params.leaseTimeoutMinutes ?? 10;
  const result = await client.query(
    `UPDATE app_private.menu_ingestion_jobs
     SET locked_at = now()
     WHERE id = $1 AND tenant_id = $2
       AND status = 'running'
       AND claim_token = $3
       AND locked_at >= now() - ($4 || ' minutes')::interval;`,
    [params.jobId, params.tenantId, params.claimToken, timeout.toString()],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Persists normalized extracted dish drafts into app_private.dish_drafts
 * under transaction-level lease fencing, eliminating TOCTOU races.
 */
export async function persistExtractedDrafts(
  client: DatabaseClient,
  params: {
    tenantId: string;
    jobId: string;
    claimToken: string;
    drafts: StructuredDishDraft[];
    status?: 'complete' | 'incomplete' | undefined;
    resultStorageKey?: string | null | undefined;
    leaseTimeoutMinutes?: number | undefined;
  },
): Promise<{ persistedCount: number; supersededCount: number }> {
  const timeout = params.leaseTimeoutMinutes ?? 10;
  const targetStatus = params.status ?? 'complete';

  // 1. Transaction and RLS scope
  await client.query('BEGIN;');
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true);", [params.tenantId]);

    // 2. Validate Fencing Token and Lease Freshness under Exclusive Row Lock
    const lockCheck = await client.query(
      `SELECT lease_generation
       FROM app_private.menu_ingestion_jobs
       WHERE id = $1 AND tenant_id = $2
         AND status = 'running'
         AND claim_token = $3
         AND locked_at >= now() - ($4 || ' minutes')::interval
       FOR UPDATE;`,
      [params.jobId, params.tenantId, params.claimToken, timeout.toString()],
    );

    if ((lockCheck.rowCount ?? 0) === 0) {
      throw new IngestionError('lease_expired_or_reclaimed', 409);
    }

    // 3. Batch-upsert drafts
    let persistedCount = 0;
    for (const draft of params.drafts) {
      const draftUuid = crypto.randomUUID();

      const insertResult = await client.query(
        `INSERT INTO app_private.dish_drafts (
          id, tenant_id, job_id, draft_id, candidate_id, draft_index, name, description, category,
          subcategory, category_page_number, price_text, price_amount, price_currency,
          ingredients, source_id, source_text, image_id, evidence, review_warnings,
          extraction_status, review_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'needs_review', 'pending'
        )
        ON CONFLICT (tenant_id, job_id, draft_index) DO UPDATE
        SET draft_id = EXCLUDED.draft_id,
            candidate_id = EXCLUDED.candidate_id,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            subcategory = EXCLUDED.subcategory,
            category_page_number = EXCLUDED.category_page_number,
            price_text = EXCLUDED.price_text,
            price_amount = EXCLUDED.price_amount,
            price_currency = EXCLUDED.price_currency,
            ingredients = EXCLUDED.ingredients,
            source_id = EXCLUDED.source_id,
            source_text = EXCLUDED.source_text,
            image_id = EXCLUDED.image_id,
            evidence = EXCLUDED.evidence,
            review_warnings = EXCLUDED.review_warnings,
            updated_at = now()
        WHERE app_private.dish_drafts.review_status = 'pending';`,
        [
          draftUuid,
          params.tenantId,
          params.jobId,
          draft.draft_id,
          draft.candidate_id ?? draft.draft_id,
          draft.draft_index,
          draft.name,
          draft.description ?? null,
          draft.category ?? null,
          draft.subcategory ?? null,
          draft.category_page_number ?? null,
          draft.price_text ?? null,
          draft.price_amount ?? null,
          draft.price_currency ?? null,
          draft.ingredients ? JSON.stringify(draft.ingredients) : null,
          draft.source_id,
          draft.source_text,
          draft.image_id ?? null,
          JSON.stringify({
            code_point_spans: draft.code_point_spans,
            utf16_spans: draft.utf16_spans,
          }),
          draft.review_warnings ?? [],
        ],
      );

      if ((insertResult.rowCount ?? 0) > 0) {
        persistedCount += 1;
      }
    }

    // 4. Mark surplus pending drafts as superseded (not human-rejected)
    const persistedIndices = params.drafts.map((d) => d.draft_index);
    const supersedeResult = await client.query(
      `UPDATE app_private.dish_drafts
       SET review_warnings = array_append(review_warnings, 'superseded_by_retry'),
           review_status = 'superseded',
           updated_at = now()
       WHERE tenant_id = $1 AND job_id = $2
         AND NOT (draft_index = ANY($3::integer[])) AND review_status = 'pending';`,
      [params.tenantId, params.jobId, persistedIndices],
    );
    const supersededCount = supersedeResult.rowCount ?? 0;

    // 5. Finalize job status and release lease
    const completionResult = await client.query(
      `UPDATE app_private.menu_ingestion_jobs
       SET status = $1,
           draft_count = $2,
           result_storage_key = COALESCE($3, result_storage_key),
           finished_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           claim_token = NULL
       WHERE id = $4 AND tenant_id = $5
         AND status = 'running'
         AND claim_token = $6
         AND locked_at >= now() - ($7 || ' minutes')::interval;`,
      [
        targetStatus,
        params.drafts.length,
        params.resultStorageKey ?? null,
        params.jobId,
        params.tenantId,
        params.claimToken,
        timeout.toString(),
      ],
    );

    if ((completionResult.rowCount ?? 0) === 0) {
      throw new IngestionError('lease_expired_at_completion', 409);
    }

    await client.query('COMMIT;');
    return { persistedCount, supersededCount };
  } catch (error) {
    try {
      await client.query('ROLLBACK;');
    } catch {
      // rollback error suppressed
    }
    throw error;
  }
}

/**
 * Fails a job due to unrecoverable or retry-exhausted extraction error.
 */
export async function failIngestionJob(
  client: DatabaseClient,
  params: {
    tenantId: string;
    jobId: string;
    claimToken: string;
    errorCode: string;
    errorDetails?: string | null | undefined;
    leaseTimeoutMinutes?: number | undefined;
  },
): Promise<void> {
  const timeout = params.leaseTimeoutMinutes ?? 10;
  await client.query(
    `UPDATE app_private.menu_ingestion_jobs
     SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
         error_code = $1,
         error_details = $2,
         finished_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
         locked_at = NULL,
         locked_by = NULL,
         claim_token = NULL
     WHERE id = $3 AND tenant_id = $4
       AND status = 'running'
       AND claim_token = $5
       AND locked_at >= now() - ($6 || ' minutes')::interval;`,
    [
      params.errorCode,
      params.errorDetails ?? null,
      params.jobId,
      params.tenantId,
      params.claimToken,
      timeout.toString(),
    ],
  );
}

/**
 * Retrieves an ingestion job by ID.
 */
export async function getIngestionJob(
  client: DatabaseClient,
  tenantId: string,
  jobId: string,
): Promise<MenuIngestionJobRow | null> {
  const result = await client.query<MenuIngestionJobRow>(
    `SELECT * FROM app_private.menu_ingestion_jobs
     WHERE tenant_id = $1 AND id = $2;`,
    [tenantId, jobId],
  );
  return result.rows[0] ?? null;
}

/**
 * Lists reviewable dish drafts for a tenant.
 */
export async function listDishDrafts(
  client: DatabaseClient,
  params: {
    tenantId: string;
    reviewStatus?: 'pending' | 'accepted' | 'rejected' | 'edited' | 'superseded' | undefined;
    jobId?: string | undefined;
  },
): Promise<DishDraftRow[]> {
  const result = await client.query<DishDraftRow>(
    `SELECT * FROM app_private.dish_drafts
     WHERE tenant_id = $1
       AND ($2::text IS NULL OR review_status = $2)
       AND ($3::uuid IS NULL OR job_id = $3)
     ORDER BY created_at DESC, draft_index ASC;`,
    [params.tenantId, params.reviewStatus ?? null, params.jobId ?? null],
  );
  return result.rows;
}

/**
 * Approves a dish draft and links it to the published dish projection.
 */
export async function approveDishDraft(
  client: DatabaseClient,
  params: {
    actorId: string;
    tenantId: string;
    draftId: string;
    publishedDishId: string;
  },
): Promise<DishDraftRow> {
  const result = await client.query<DishDraftRow>(
    `UPDATE app_private.dish_drafts
     SET review_status = 'accepted',
         reviewed_by = $1,
         reviewed_at = now(),
         published_dish_id = $2,
         updated_at = now()
     WHERE tenant_id = $3 AND id = $4 AND review_status = 'pending'
     RETURNING *;`,
    [params.actorId, params.publishedDishId, params.tenantId, params.draftId],
  );

  const row = result.rows[0];
  if (!row) throw new IngestionError('draft_not_pending_or_not_found', 404);
  return row;
}
