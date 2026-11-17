import { createHash, randomUUID } from 'node:crypto';
import type { ReviewCandidateResult } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { withOwnerMenuTransaction } from '../owner-menu';
import { safeFetch } from '../retrieval/fetcher';
import { parseHtmlSource } from '../retrieval/parser';
import {
  createIngestionJob,
  type DishDraftRow,
  IngestionError,
  type MenuIngestionJobRow,
} from './repository';

const MAX_HTML_DISHES = 150;
const SOURCE_KIND = 'jsonld_menu';

/**
 * Only source-grounded Schema.org MenuItem entries are eligible. Arbitrary page
 * paragraphs cannot become a dish merely because they contain a price.
 */
export async function retrieveStructuredHtmlMenu(url: string) {
  const source = await safeFetch(url);
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(source.contentType)) {
    return { source, items: [] };
  }
  const parsed = parseHtmlSource(source.content, 'url-jsonld', source.finalUrl);
  const items = parsed.segments
    .filter((segment) => segment.metadata?.schema_type === 'MenuItem')
    .slice(0, MAX_HTML_DISHES)
    .map((segment) => {
      const data = segment.metadata ?? {};
      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 160) : '';
      if (!name) return null;
      const description =
        typeof data.description === 'string' ? data.description.slice(0, 4000) : null;
      const price =
        typeof data.price_text === 'string' &&
        /^(0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(data.price_text)
          ? data.price_text
          : null;
      const currency =
        typeof data.price_currency === 'string' && /^[A-Z]{3}$/.test(data.price_currency)
          ? data.price_currency
          : null;
      return {
        name,
        description,
        price,
        currency,
        sourceText: segment.text,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return { source, items };
}

export async function persistStructuredHtmlMenu(
  client: Client,
  actor: string,
  venue: string,
  originalUrl: string,
  key: string,
  found: NonNullable<Awaited<ReturnType<typeof retrieveStructuredHtmlMenu>>>,
): Promise<MenuIngestionJobRow> {
  const { source, items } = found;
  if (items.length === 0) throw new IngestionError('menu_items_not_found', 422);
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `html-menu:${venue}:${key}`,
    ]);
    const jobId = randomUUID();
    const sourceHash = createHash('sha256').update(source.bytes).digest('hex');
    const job = await createIngestionJob(
      client,
      {
        id: jobId,
        tenantId: venue,
        sourceType: 'url',
        sourceUrl: originalUrl,
        sourceHash,
        idempotencyKey: key,
        maxAttempts: 1,
      },
      { inTransaction: true },
    );
    if (job.status === 'complete') return job;
    if (job.status !== 'queued') throw new IngestionError('job_not_retryable', 409);

    const sourceId = `sha256:${sourceHash}`;
    for (const [index, item] of items.entries()) {
      const candidateId = `html-item-${index + 1}`;
      const spanEnd = Array.from(item.sourceText).length;
      if (spanEnd === 0) continue;
      await client.query(
        `INSERT INTO app_private.dish_drafts (
          id,tenant_id,job_id,draft_id,candidate_id,draft_index,
          name,description,price_text,price_amount,price_currency,
          source_id,source_text,evidence,review_warnings,extraction_status,review_status
        ) VALUES (
          $1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'needs_review','pending'
        )`,
        [
          randomUUID(),
          venue,
          job.id,
          candidateId,
          index,
          item.name,
          item.description,
          item.price,
          item.price,
          item.currency,
          sourceId,
          item.sourceText,
          JSON.stringify({
            source_kind: SOURCE_KIND,
            source_sha256: sourceHash,
            final_url: source.finalUrl,
            code_point_spans: [{ segment_id: candidateId, start: 0, end: spanEnd }],
          }),
          [
            'Imported from structured website metadata; owner must verify all fields, ingredients and allergens.',
          ],
        ],
      );
    }
    const provenance = {
      kind: SOURCE_KIND,
      originalUrl,
      finalUrl: source.finalUrl,
      retrievedAt: source.retrievedAt,
      sizeBytes: source.bytes.byteLength,
    };
    const result = await client.query<MenuIngestionJobRow>(
      `UPDATE app_private.menu_ingestion_jobs
       SET status='complete', started_at=now(), finished_at=now(),
           draft_count=$3, source_uploaded=true, source_provenance=$4::jsonb,
           result_storage_key=$5
       WHERE tenant_id=$1 AND id=$2 AND status='queued' RETURNING *`,
      [
        venue,
        job.id,
        items.length,
        JSON.stringify(provenance),
        `reports/${venue}/${job.id}/html-jsonld`,
      ],
    );
    if (result.rowCount !== 1) throw new IngestionError('job_state_conflict', 409);
    return result.rows[0]!;
  });
}

/**
 * Build an evidence-linked review payload from the server-persisted originals,
 * never from client-submitted dish fields. Existing candidate review commands
 * remain responsible for corrections, versioning, and publication eligibility.
 */
export function structuredHtmlReviewResult(
  job: MenuIngestionJobRow,
  drafts: readonly DishDraftRow[],
): ReviewCandidateResult {
  const provenance = job.source_provenance as Record<string, unknown> | null;
  if (
    job.source_type !== 'url' ||
    provenance?.kind !== SOURCE_KIND ||
    job.status !== 'complete' ||
    !job.source_hash ||
    !job.source_url ||
    typeof provenance.retrievedAt !== 'string' ||
    typeof provenance.sizeBytes !== 'number'
  )
    throw new IngestionError('review_not_ready', 409);
  if (drafts.length !== job.draft_count || drafts.length === 0)
    throw new IngestionError('review_draft_mismatch', 409);
  const sourceId = `sha256:${job.source_hash}`;
  const sorted = [...drafts].sort((a, b) => a.draft_index - b.draft_index);
  const segments = sorted.map((draft) => ({
    segment_id: draft.candidate_id!,
    page_number: null,
    method: 'html' as const,
    status: 'ready' as const,
    text: draft.source_text!,
    native_text: null,
    error: null,
    warnings: [] as string[],
    metadata: { source_kind: SOURCE_KIND },
  }));
  const candidates = sorted.map((draft) => {
    if (!draft.candidate_id || !draft.source_text || draft.source_id !== sourceId)
      throw new IngestionError('review_draft_mismatch', 409);
    const original = {
      name: draft.name!,
      description: draft.description,
      category: draft.category,
      price_amount: draft.price_amount,
      price_currency: draft.price_currency,
      ingredients: draft.ingredients as string[] | null,
      source_id: draft.source_id,
      source_text: draft.source_text,
      image_id: draft.image_id,
      review_warnings: draft.review_warnings,
      status: 'needs_review' as const,
    };
    const missing_fields = (
      ['description', 'category', 'price_amount', 'price_currency', 'ingredients'] as const
    ).filter(
      (field) =>
        original[field] === null && !(field === 'price_amount' && draft.price_text != null),
    );
    return {
      candidate_id: draft.candidate_id,
      original: { ...original, price_text: draft.price_text ?? null },
      evidence: [
        { segment_id: draft.candidate_id, start: 0, end: Array.from(draft.source_text).length },
      ],
      missing_fields,
    };
  });
  const date = job.finished_at ? new Date(job.finished_at).toISOString() : new Date().toISOString();
  return {
    schema_version: 2,
    pipeline_version: '3',
    extraction_id: `html:${job.id}`,
    status: 'complete',
    started_at: job.started_at ? new Date(job.started_at).toISOString() : date,
    finished_at: date,
    extraction_model: null,
    source: {
      source_id: sourceId,
      sha256: job.source_hash,
      kind: 'website',
      location: job.source_url,
      retrieved_at: provenance.retrievedAt,
      size_bytes: provenance.sizeBytes,
    },
    segments,
    candidates,
    warnings: ['Website metadata is unverified; confirm each dish before publication.'],
    errors: [],
  };
}
