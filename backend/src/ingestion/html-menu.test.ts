import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ReviewCandidateResultSchema } from '@peekaplate/contracts';
import { safeFetch, type SafeFetchResult } from '../retrieval/fetcher';
import { persistStructuredHtmlMenu, retrieveStructuredHtmlMenu, structuredHtmlReviewResult } from './html-menu';
import type { DishDraftRow, MenuIngestionJobRow } from './repository';

vi.mock('../retrieval/fetcher', () => ({ safeFetch: vi.fn() }));
vi.mock('../owner-menu', () => ({
  withOwnerMenuTransaction: async (_client: unknown, _actor: string, _venue: string, work: () => Promise<unknown>) => work(),
}));
const venue = '00000000-0000-4000-8000-000000000123';
const website = 'https://restaurant.example/menu';
const html = `<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Menu","hasMenuItem":[
 {"@type":"MenuItem","name":"Miso Ramen","description":"Miso broth & noodles","offers":{"price":"18.50","priceCurrency":"USD"}},
 {"@type":"MenuItem","name":"Garlic Noodles"}]}
</script><nav>Privacy Policy</nav>`;
function source(): SafeFetchResult {
  const bytes = new TextEncoder().encode(html);
  return {
    bytes, content: html, contentType: 'text/html; charset=utf-8',
    finalUrl: website, retrievedAt: '2026-11-16T20:00:00.000Z',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    redirectCount: 0, sizeBytes: bytes.length,
  };
}
function row(hash: string): MenuIngestionJobRow {
  return {
    id: '00000000-0000-4000-8000-000000000999', tenant_id: venue,
    source_type: 'url', source_url: website, source_hash: hash,
    source_storage_key: null, result_storage_key: null,
    idempotency_key: 'html-test-key-123456', status: 'queued', attempt_count: 0,
    max_attempts: 1, claim_token: null, lease_generation: '0',
    locked_at: null, locked_by: null, error_code: null, error_details: null,
    draft_count: 0, created_at: '2026-11-16T20:00:00.000Z', started_at: null, finished_at: null,
  };
}
describe('HTML MenuItem URL ingestion', () => {
  it('retrieves source-grounded dishes without turning website chrome into menu items', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(source());
    const found = await retrieveStructuredHtmlMenu(website);
    expect(found?.items).toEqual([
      { name: 'Miso Ramen', description: 'Miso broth & noodles', price: '18.50', currency: 'USD', sourceText: 'Miso Ramen — Miso broth & noodles — 18.50' },
      { name: 'Garlic Noodles', description: null, price: null, currency: null, sourceText: 'Garlic Noodles' },
    ]);
  });

  it('persists review-only drafts and marks a source-bound job complete atomically', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(source());
    const found = await retrieveStructuredHtmlMenu(website);
    expect(found).not.toBeNull();
    const job = row(source().sha256);
    const calls: { sql: string; params?: unknown[] }[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes('INSERT INTO app_private.menu_ingestion_jobs')) return { rows: [job], rowCount: 1 };
        if (sql.includes('UPDATE app_private.menu_ingestion_jobs')) return {
          rows: [{ ...job, status: 'complete', draft_count: 2, source_uploaded: true }],
          rowCount: 1,
        };
        return { rows: [], rowCount: sql.includes('INSERT INTO app_private.dish_drafts') ? 1 : 0 };
      },
    };
    const saved = await persistStructuredHtmlMenu(
      client as never, 'owner', venue, website, 'html-test-key-123456', found!,
    );
    expect(saved.status).toBe('complete');
    const inserts = calls.filter((call) => call.sql.includes('INSERT INTO app_private.dish_drafts'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params?.[5]).toBe('Miso Ramen');
    expect(inserts[1]?.params?.[5]).toBe('Garlic Noodles');
    expect(inserts[1]?.params?.[8]).toBeNull();
    expect(inserts[0]?.sql).toContain("'needs_review','pending'");
    expect(calls.find((call) => call.sql.includes('UPDATE app_private.menu_ingestion_jobs'))?.params?.[2]).toBe(2);
  });

  it('constructs schema-valid review candidates with evidence and unknown optional facts', () => {
    const src = source();
    const job = {
      ...row(src.sha256), status: 'complete', draft_count: 1,
      started_at: '2026-11-16T20:00:00.000Z', finished_at: '2026-11-16T20:00:01.000Z',
      result_storage_key: `reports/${venue}/00000000-0000-4000-8000-000000000999/html-jsonld`,
      source_provenance: { kind: 'jsonld_menu', retrievedAt: '2026-11-16T20:00:00.000Z', sizeBytes: src.bytes.length },
    } as MenuIngestionJobRow;
    const text = 'Miso Ramen — Miso broth & noodles — 18.50';
    const dish = {
      candidate_id: 'html-item-1', draft_index: 0, name: 'Miso Ramen',
      description: 'Miso broth & noodles', category: null, price_amount: '18.50',
      price_text: '18.50', price_currency: 'USD', ingredients: null,
      source_id: `sha256:${src.sha256}`, source_text: text, image_id: null,
      review_warnings: ['Review required'],
    } as DishDraftRow;
    const result = structuredHtmlReviewResult(job, [dish]);
    expect(ReviewCandidateResultSchema.parse(result).candidates[0]?.evidence[0]?.end).toBe(Array.from(text).length);
    expect(result.candidates[0]?.missing_fields).toEqual(['category', 'ingredients']);
    expect(result.candidates[0]?.original.status).toBe('needs_review');
  });

  it('rejects mismatched or missing persisted drafts before creating a review session', () => {
    const job = {
      ...row(source().sha256), status: 'complete', draft_count: 1,
      source_provenance: { kind: 'jsonld_menu', retrievedAt: '2026-11-16T20:00:00.000Z', sizeBytes: 100 },
    } as MenuIngestionJobRow;
    expect(() => structuredHtmlReviewResult(job, [])).toThrow('review_draft_mismatch');
  });
});
