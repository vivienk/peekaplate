import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ExtractionDishDraftSchema,
  MenuExtractionResultSchema,
  StructuredDishDraftSchema,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { adaptPythonExtractionResult } from './adapter.js';
import { createHttpPythonExtractor } from './transport.js';

function loadFixture<T = unknown>(filename: string): T {
  const filePath = resolve(process.cwd(), 'tests/fixtures/menu-ingestion', filename);
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

describe('S3-VIS-01 / VIS-02: Comprehensive Contract & Fixture Verification', () => {
  describe('Requirement 3.1 & 3.2: Schema Compatibility & Field Preservation', () => {
    it('accepts current schema 2 / pipeline 3 input (representative-extraction-v2.json) and preserves all fields', () => {
      const v2Input = loadFixture('representative-extraction-v2.json');
      const v2Expected = loadFixture<any[]>('representative-candidates-v2.json');

      const adapted = adaptPythonExtractionResult(v2Input);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('incomplete'); // Preserves incomplete status due to failed page 4
      expect(adapted.drafts).toHaveLength(5);
      expect(adapted.errors).toContain('Page 4: OCR timeout on page 4');

      // Trace required fields through every draft
      for (let i = 0; i < v2Expected.length; i++) {
        const expected = v2Expected[i];
        const actual = adapted.drafts[i]!;

        expect(actual.draft_id).toBe(expected.draft_id);
        expect(actual.candidate_id).toBe(expected.candidate_id);
        expect(actual.draft_index).toBe(expected.draft_index);
        expect(actual.name).toBe(expected.name);
        expect(actual.description).toBe(expected.description);
        expect(actual.category).toBe(expected.category);
        expect(actual.subcategory).toBe(expected.subcategory);
        expect(actual.category_page_number).toBe(expected.category_page_number);
        expect(actual.price_text).toBe(expected.price_text);
        expect(actual.price_amount).toBe(expected.price_amount);
        expect(actual.price_currency).toBe(expected.price_currency);
        expect(actual.source_id).toBe(expected.source_id);
        expect(actual.status).toBe('needs_review');
        expect(actual.code_point_spans).toEqual(expected.code_point_spans);
        expect(actual.utf16_spans).toEqual(expected.utf16_spans);
      }
    });

    it('accepts legacy schema 1 / pipeline 2 input (representative-extraction.json) and preserves compatibility', () => {
      const v1Input = loadFixture('representative-extraction.json');
      const v1Expected = loadFixture<any[]>('representative-candidates.json');

      const adapted = adaptPythonExtractionResult(v1Input);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('complete');
      expect(adapted.drafts).toHaveLength(2);

      for (let i = 0; i < v1Expected.length; i++) {
        const expected = v1Expected[i];
        const actual = adapted.drafts[i]!;

        expect(actual.draft_id).toBe(expected.draft_id);
        expect(actual.name).toBe(expected.name);
        expect(actual.price_amount).toBe(expected.price_amount);
        expect(actual.price_currency).toBe(expected.price_currency);
        expect(actual.status).toBe('needs_review');
        expect(actual.code_point_spans).toEqual(expected.code_point_spans);
      }
    });

    it('distinguishes multi-option prices, zero price, and unknown price correctly (priced fixtures)', () => {
      // 1. Grouped price options from v2: "8.50 / 12.50 CAD"
      const v2Input = loadFixture<any>('representative-extraction-v2.json');
      const adapted = adaptPythonExtractionResult(v2Input);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      const multiOptionDraft = adapted.drafts[0];
      expect(multiOptionDraft?.price_text).toBe('8.50 / 12.50 CAD');
      expect(multiOptionDraft?.price_currency).toBe('CAD');
      expect(multiOptionDraft?.price_amount).toBeNull(); // scalar is null, NOT fabricated

      // 2. Explicit zero price candidate
      const zeroDraft = adapted.drafts[1];
      expect(zeroDraft?.name).toBe('Garden Salad');
      expect(zeroDraft?.price_amount).toBe('0.00'); // Explicit 0.00 is NOT treated as null
      expect(zeroDraft?.price_currency).toBe('CAD');

      // 3. Unknown price candidate
      const unknownDraft = adapted.drafts[2];
      expect(unknownDraft?.name).toBe('Chef Surprise');
      expect(unknownDraft?.price_amount).toBeNull();
      expect(unknownDraft?.price_currency).toBeNull();
      expect(unknownDraft?.price_text).toBeNull();

      // 4. Single unambiguous price candidate
      const singlePriceDraft = adapted.drafts[3];
      expect(singlePriceDraft?.name).toBe('24/7 FEAST PLATTER');
      expect(singlePriceDraft?.price_text).toBe('1595');
      expect(singlePriceDraft?.price_amount).toBe('1595');
      expect(singlePriceDraft?.price_currency).toBe('PHP');
    });
  });

  describe('Requirement 6: Multi-Span Evidence Reconstruction', () => {
    it('reconstructs candidate supported by multiple spans across source segment', () => {
      const v2Input = loadFixture<any>('representative-extraction-v2.json');
      const adapted = adaptPythonExtractionResult(v2Input);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      const multiSpanDraft = adapted.drafts.find((d) => d.name === 'Special Ribs');
      expect(multiSpanDraft).toBeDefined();
      expect(multiSpanDraft?.code_point_spans).toHaveLength(2);
      expect(multiSpanDraft?.code_point_spans[0]).toEqual({
        segment_id: 'seg_p2',
        start: 28,
        end: 40,
      });
      expect(multiSpanDraft?.code_point_spans[1]).toEqual({
        segment_id: 'seg_p2',
        start: 41,
        end: 53,
      });
    });

    it('rejects invalid extraction where span extends beyond segment text length (invalid-extraction.json)', () => {
      const invalidInput = loadFixture('invalid-extraction.json');
      const adapted = adaptPythonExtractionResult(invalidInput);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('failed');
      expect(adapted.drafts).toHaveLength(0);
      expect(adapted.invalidDrafts).toHaveLength(1);
      expect(adapted.invalidDrafts[0]?.errors[0]).toMatch(/out of bounds/);
    });

    it('rejects draft referencing failed or skipped segment', () => {
      const rawWithFailedSegment = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'incomplete',
        started_at: '2026-10-27T10:00:00.000Z',
        segments: [
          {
            segment_id: 'seg_failed',
            page_number: 1,
            method: 'ocr_space_engine3',
            status: 'failed',
            text: '',
            error: 'OCR crashed',
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            name: 'Ghost Dish',
            source_id: 'src_1',
            source_text: 'Ghost Dish',
            status: 'needs_review',
            review_warnings: [],
          },
        ],
        evidence: [
          {
            draft_id: 'draft_ghost',
            draft_index: 0,
            spans: [{ segment_id: 'seg_failed', start: 0, end: 10 }],
          },
        ],
        warnings: [],
        errors: ['Page 1: OCR crashed'],
      };

      const adapted = adaptPythonExtractionResult(rawWithFailedSegment);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.drafts).toHaveLength(0);
      expect(adapted.invalidDrafts).toHaveLength(1);
      expect(adapted.invalidDrafts[0]?.errors[0]).toMatch(/invalid status "failed"/);
    });
  });

  describe('Requirement 6: Unicode Code-Point Boundary Enforcement', () => {
    it('validates Unicode code points rather than UTF-16 code units (field-limits.json)', () => {
      const limits = loadFixture<any>('field-limits.json');

      const nameBoundaryValid = '🍜'.repeat(limits.name_limit);
      const nameBoundaryInvalid = '🍜'.repeat(limits.name_limit + 1);
      const descBoundaryValid = '🥗'.repeat(limits.description_limit);
      const descBoundaryInvalid = '🥗'.repeat(limits.description_limit + 1);
      const priceBoundaryValid = '1'.repeat(limits.price_text_limit);
      const priceBoundaryInvalid = '1'.repeat(limits.price_text_limit + 1);

      // 160 emoji: 160 code points, but 320 UTF-16 code units
      expect(Array.from(nameBoundaryValid).length).toBe(160);
      expect(nameBoundaryValid.length).toBe(320);

      // Valid boundary draft (160 code points)
      const validDraft = {
        name: nameBoundaryValid,
        description: descBoundaryValid,
        price_text: priceBoundaryValid,
        source_id: 'src_unicode',
        source_text: 'sample',
        status: 'needs_review',
      };
      const validParsed = ExtractionDishDraftSchema.safeParse(validDraft);
      expect(validParsed.success).toBe(true);

      // Over limit name (161 code points)
      expect(Array.from(nameBoundaryInvalid).length).toBe(161);
      const invalidNameDraft = {
        ...validDraft,
        name: nameBoundaryInvalid,
      };
      const invalidNameParsed = ExtractionDishDraftSchema.safeParse(invalidNameDraft);
      expect(invalidNameParsed.success).toBe(false);
      if (!invalidNameParsed.success) {
        expect(invalidNameParsed.error.issues[0]?.message).toMatch(/at most 160 code points/);
      }

      // Over limit description (4001 code points)
      expect(Array.from(descBoundaryInvalid).length).toBe(4001);
      const invalidDescDraft = {
        ...validDraft,
        description: descBoundaryInvalid,
      };
      const invalidDescParsed = ExtractionDishDraftSchema.safeParse(invalidDescDraft);
      expect(invalidDescParsed.success).toBe(false);

      // Over limit price_text (161 code points)
      expect(Array.from(priceBoundaryInvalid).length).toBe(161);
      const invalidPriceDraft = {
        ...validDraft,
        price_text: priceBoundaryInvalid,
      };
      const invalidPriceParsed = ExtractionDishDraftSchema.safeParse(invalidPriceDraft);
      expect(invalidPriceParsed.success).toBe(false);
    });
  });

  describe('Section 9.2: Worker-to-Python Extraction Transport', () => {
    it('dispatches correlated HTTP request and returns parsed extraction response', async () => {
      const mockResult = loadFixture('representative-extraction-v2.json');
      const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe('https://extraction.example.internal/extract');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer test-token-123');
        expect(headers['X-Job-ID']).toBe('job_100');
        expect(headers['X-Tenant-ID']).toBe('tenant_200');

        const body = JSON.parse(init?.body as string);
        expect(body.job_id).toBe('job_100');
        expect(body.source_type).toBe('pdf');

        return new Response(JSON.stringify(mockResult), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction.example.internal',
        authToken: 'test-token-123',
        fetchFn: customFetch as any,
      });

      const fakeJob: any = {
        id: 'job_100',
        tenant_id: 'tenant_200',
        source_type: 'pdf',
        source_url: null,
        source_storage_key: 'menus/input.pdf',
        source_hash: 'b'.repeat(64),
        idempotency_key: 'idem_100',
      };

      const result = await extractor(fakeJob);
      expect(result).toEqual(mockResult);
    });

    it('maps HTTP errors and timeouts to IngestionError with accurate error codes', async () => {
      const timeoutFetch = async () => {
        const error = new Error('The operation was aborted');
        error.name = 'TimeoutError';
        throw error;
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction.example.internal',
        fetchFn: timeoutFetch as any,
      });

      const fakeJob: any = {
        id: 'job_timeout',
        tenant_id: 'tenant_timeout',
        source_type: 'url',
        source_url: 'https://example.com/menu',
        idempotency_key: 'idem_timeout',
      };

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_timeout',
        status: 504,
      });
    });

    it('correctly matches evidence and preserves original draft_index when drafts are non-contiguous', () => {
      const payload: any = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T12:00:00.000Z',
        finished_at: '2026-10-27T12:00:01.000Z',
        extraction_mode: 'ai',
        ocr_engine: 3,
        library_versions: {},
        configuration: {},
        segments: [
          {
            segment_id: 'seg_1',
            page_number: 1,
            method: 'pdf_native',
            status: 'ready',
            text: 'Tacos 10 USD Burrito 12 USD Enchilada 14 USD',
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            candidate_id: 'cand_tacos',
            draft_id: 'draft_tacos',
            draft_index: 0,
            name: 'Tacos',
            price_amount: '10.00',
            price_currency: 'USD',
            source_id: 'src_1',
            source_text: 'Tacos 10 USD',
            status: 'needs_review',
            review_warnings: [],
          },
          // Note: index 1 was filtered out by producer! Only index 2 exists:
          {
            candidate_id: 'cand_enchilada',
            draft_id: 'draft_enchilada',
            draft_index: 2,
            name: 'Enchilada',
            price_amount: '14.00',
            price_currency: 'USD',
            source_id: 'src_1',
            source_text: 'Enchilada 14 USD',
            status: 'needs_review',
            review_warnings: [],
          },
        ],
        evidence: [
          {
            draft_id: 'draft_tacos',
            draft_index: 0,
            spans: [{ segment_id: 'seg_1', start: 0, end: 12 }],
          },
          {
            draft_id: 'draft_enchilada',
            draft_index: 2,
            spans: [{ segment_id: 'seg_1', start: 28, end: 44 }],
          },
        ],
        capture_requests: [],
        warnings: [],
        errors: [],
      };

      const adapted = adaptPythonExtractionResult(payload);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.drafts).toHaveLength(2);
      expect(adapted.drafts[0]?.draft_index).toBe(0);
      expect(adapted.drafts[0]?.name).toBe('Tacos');
      expect(adapted.drafts[1]?.draft_index).toBe(2); // Non-contiguous index preserved!
      expect(adapted.drafts[1]?.name).toBe('Enchilada');
    });
  });
});
