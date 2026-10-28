import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ExtractionDishDraftSchema,
  MenuExtractionResultSchema,
  StructuredDishDraftSchema,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { readExtractionCapability } from '../extraction-capability.js';
import { adaptPythonExtractionResult } from './adapter.js';
import { createHttpPythonExtractor, DEFAULT_EXTRACTION_TIMEOUT_MS } from './transport.js';

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

    it('accepts Mohammad PR #58 review candidates v2 extraction fixture (2fdc831)', () => {
      const fixture = loadFixture('vis02-mohammad-extraction-v2.json');
      const adapted = adaptPythonExtractionResult(fixture);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('incomplete');
      expect(adapted.drafts).toHaveLength(3);

      // Draft 0: Garden Soup with grouped price options and hierarchy
      const soup = adapted.drafts[0]!;
      expect(soup.name).toBe('Garden Soup');
      expect(soup.category).toBe('FOOD');
      expect(soup.subcategory).toBe('SOUPS');
      expect(soup.category_page_number).toBe(1);
      expect(soup.price_text).toBe('8.50 / 12.50 CAD');
      expect(soup.price_amount).toBeNull();
      expect(soup.price_currency).toBe('CAD');
      expect(soup.candidate_id).toBe('draft:0bbe00087c6841623c76d7b6f9da5ebf');
      expect(soup.status).toBe('needs_review');

      // Draft 1: Coffee with missing price
      const coffee = adapted.drafts[1]!;
      expect(coffee.name).toBe('Coffee');
      expect(coffee.category).toBe('HOT DRINKS');
      expect(coffee.subcategory).toBeNull();
      expect(coffee.price_amount).toBeNull();
      expect(coffee.price_text).toBeNull();
      expect(coffee.status).toBe('needs_review');

      // Draft 2: Bread with explicit 0.00 price
      const bread = adapted.drafts[2]!;
      expect(bread.name).toBe('Bread');
      expect(bread.category).toBe('BAKERY');
      expect(bread.price_amount).toBe('0.00');
      expect(bread.price_currency).toBe('CAD');
      expect(bread.status).toBe('needs_review');
    });

    it('accepts Mohammad PR #58 service bundle report artifact (2fdc831)', () => {
      const bundle = loadFixture<{ report: unknown }>('vis02-mohammad-bundle.json');
      const adapted = adaptPythonExtractionResult(bundle.report);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('incomplete');
      expect(adapted.drafts).toHaveLength(3);
      expect(adapted.drafts[0]!.name).toBe('Garden Soup');
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
        source_type: 'pdf',
        source_storage_key: 'menus/sample.pdf',
        source_hash: 'a'.repeat(64),
        idempotency_key: 'idem_timeout',
      };

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_timeout',
        status: 504,
      });
    });

    it('rejects unsupported extractor source_type without silent coercion', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extraction.example.internal',
        authToken: 'test-token',
        fetchFn: (async () => Response.json({})) as any,
      });

      const urlJob: any = {
        id: 'job_url',
        tenant_id: 'tenant_url',
        source_type: 'url',
        source_storage_key: 'menus/sample.html',
        source_hash: 'a'.repeat(64),
        idempotency_key: 'idem_url',
      };

      await expect(extractor(urlJob)).rejects.toMatchObject({
        code: 'unsupported_extractor_source_type',
        status: 400,
      });

      const textJob: any = {
        id: 'job_text',
        tenant_id: 'tenant_text',
        source_type: 'text',
        source_storage_key: 'menus/sample.txt',
        source_hash: 'b'.repeat(64),
        idempotency_key: 'idem_text',
      };

      await expect(extractor(textJob)).rejects.toMatchObject({
        code: 'unsupported_extractor_source_type',
        status: 400,
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

    it('prioritizes exact draft_id match over earlier index match when index collision occurs', () => {
      // Scenario requested in Raghav finding / Task B:
      // Draft has draft_id "draft:salmon".
      // Earlier evidence entry has draft_index 0, but belongs to draft "draft:soup".
      // Later evidence entry has draft_id "draft:salmon" (with matching spans for salmon).
      // The adapter MUST match the later exact draft_id rather than erroneously grabbing the earlier index-0 match.
      const payload: any = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T12:00:00.000Z',
        finished_at: '2026-10-27T12:00:01.000Z',
        extraction_mode: 'ai',
        segments: [
          {
            segment_id: 'seg_1',
            page_number: 1,
            method: 'pdf_native',
            status: 'ready',
            text: 'Daily Soup $6.00\nGrilled Salmon $22.00',
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            candidate_id: 'cand_salmon',
            draft_id: 'draft:salmon',
            draft_index: 0, // Note: draft says draft_index: 0
            name: 'Grilled Salmon',
            price_amount: '22.00',
            price_currency: 'USD',
            source_id: 'src_1',
            source_text: 'Grilled Salmon $22.00',
            status: 'needs_review',
            review_warnings: [],
          },
        ],
        evidence: [
          // Earlier evidence entry: matches index 0, BUT belongs to a different draft ("draft:soup") with soup spans
          {
            draft_id: 'draft:soup',
            draft_index: 0,
            spans: [{ segment_id: 'seg_1', start: 0, end: 17 }], // "Daily Soup $6.00"
          },
          // Later evidence entry: exact match for "draft:salmon" with salmon spans
          {
            draft_id: 'draft:salmon',
            draft_index: 1,
            spans: [{ segment_id: 'seg_1', start: 17, end: 38 }], // "Grilled Salmon $22.00"
          },
        ],
        capture_requests: [],
        warnings: [],
        errors: [],
      };

      const adapted = adaptPythonExtractionResult(payload);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.drafts).toHaveLength(1);
      const draft = adapted.drafts[0]!;
      expect(draft.name).toBe('Grilled Salmon');
      expect(draft.draft_id).toBe('draft:salmon');
      expect(draft.source_text).toBe('Grilled Salmon $22.00');

      // Crucial assertion: Selected evidence must be the salmon spans [17, 38], NOT the soup spans [0, 17]!
      expect(draft.code_point_spans).toEqual([
        {
          segment_id: 'seg_1',
          start: 17,
          end: 38,
        },
      ]);
    });
  });

  describe('Priority P0: Extraction Transport Semantics & Timeout Hardening', () => {
    const fakeJob: any = {
      id: 'job_test_transport',
      tenant_id: 'tenant_test_transport',
      source_type: 'pdf',
      source_storage_key: 'menus/sample.pdf',
      source_hash: 'a'.repeat(64),
      idempotency_key: 'idem_transport_p0',
    };

    it('rejects extraction call if job lacks materialized source_storage_key or source_hash', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
      });

      await expect(extractor({ ...fakeJob, source_storage_key: null })).rejects.toMatchObject({
        code: 'missing_materialized_source',
        status: 400,
      });

      await expect(extractor({ ...fakeJob, source_hash: null })).rejects.toMatchObject({
        code: 'missing_materialized_source',
        status: 400,
      });
    });

    it('exports DEFAULT_EXTRACTION_TIMEOUT_MS set to 720,000ms (12 minutes)', () => {
      expect(DEFAULT_EXTRACTION_TIMEOUT_MS).toBe(720_000);
    });

    it('successfully handles long-running extraction that exceeds 120s limit within 600s timeout', async () => {
      // Mock fetch simulating successful extraction that took 368 seconds
      const simulatedDurationSec = 368;
      const customFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        // Assert that the request signal did not abort before 600 seconds
        expect(init?.signal?.aborted).toBe(false);
        return new Response(
          JSON.stringify({
            schema_version: 2,
            pipeline_version: '3',
            status: 'complete',
            started_at: '2026-10-27T12:00:00.000Z',
            finished_at: '2026-10-27T12:06:08.000Z',
            configuration: { execution_time_seconds: simulatedDurationSec },
            segments: [],
            drafts: [],
            evidence: [],
            warnings: [],
            errors: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        timeoutMs: 600_000,
        fetchFn: customFetch as any,
      });

      const result = (await extractor(fakeJob)) as any;
      expect(result.status).toBe('complete');
      expect(result.configuration.execution_time_seconds).toBe(368);
    });

    it('triggers extraction_timeout error when request exceeds configured timeout', async () => {
      // Custom fetch that only resolves when aborted by signal
      const hangingFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            return reject(err);
          }
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        timeoutMs: 20, // 20ms quick timeout
        fetchFn: hangingFetch as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_timeout',
        status: 504,
      });
    });

    it('distinguishes explicit client abort from timeout (extraction_aborted with 499)', async () => {
      const abortController = new AbortController();

      const abortableFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          const err = new Error('This operation was aborted by the user');
          err.name = 'AbortError';
          throw err;
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted by the user');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        timeoutMs: 600_000,
        fetchFn: abortableFetch as any,
      });

      // Abort controller
      abortController.abort();

      await expect(extractor(fakeJob, { signal: abortController.signal })).rejects.toMatchObject({
        code: 'extraction_aborted',
        status: 499,
      });
    });

    it('distinguishes HTTP 400 Bad Request vs HTTP 500/502 Bad Gateway', async () => {
      const fetch400 = async () => new Response('Invalid PDF structure', { status: 400 });
      const fetch500 = async () => new Response('Internal OCR server crash', { status: 500 });

      const extractor400 = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        fetchFn: fetch400 as any,
      });
      const extractor500 = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        fetchFn: fetch500 as any,
      });

      await expect(extractor400(fakeJob)).rejects.toMatchObject({
        code: 'extraction_service_error',
        status: 400,
      });

      await expect(extractor500(fakeJob)).rejects.toMatchObject({
        code: 'extraction_service_error',
        status: 502,
      });
    });

    it('distinguishes network connectivity failures (extraction_network_error)', async () => {
      const fetchNetworkFail = async () => {
        const err = new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8000');
        throw err;
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        fetchFn: fetchNetworkFail as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'extraction_network_error',
        status: 502,
      });
    });

    it('distinguishes non-JSON responses (malformed_extraction_response)', async () => {
      const fetchHtml = async () =>
        new Response('<html><body>502 Bad Gateway from Nginx</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        fetchFn: fetchHtml as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'malformed_extraction_response',
        status: 502,
      });
    });

    it('mints signed source capability grant and attaches X-Source-Capability and X-Source-Hash headers', async () => {
      const signingSecret = 'synthetic-job-signing-key-'.repeat(3);
      const uuidJob: any = {
        id: '00000000-0000-4000-8000-000000000001',
        tenant_id: '00000000-0000-4000-8000-000000000002',
        source_type: 'pdf',
        source_storage_key:
          'menu-ingestion/sources/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000001/source',
        source_hash: 'a'.repeat(64),
        idempotency_key: 'idem_transport_cap',
      };
      let capturedRequest: Request | null = null;

      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = new Request(input, init);
        return Response.json({
          schema_version: 2,
          pipeline_version: '3',
          status: 'complete',
          segments: [],
          drafts: [],
          evidence: [],
          warnings: [],
          errors: [],
        });
      };

      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        authToken: 'service-bearer-token',
        sourceSigningSecret: signingSecret,
        fetchFn: fetchFn as any,
      });

      await extractor(uuidJob);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.headers.get('Authorization')).toBe('Bearer service-bearer-token');
      expect(capturedRequest!.headers.get('X-Job-ID')).toBe(uuidJob.id);
      expect(capturedRequest!.headers.get('X-Tenant-ID')).toBe(uuidJob.tenant_id);
      expect(capturedRequest!.headers.get('X-Source-Hash')).toBe(uuidJob.source_hash);

      const capabilityToken = capturedRequest!.headers.get('X-Source-Capability');
      expect(capabilityToken).toBeTruthy();

      const verifiedScope = await readExtractionCapability(capabilityToken!, signingSecret);
      expect(verifiedScope).toEqual({
        tenantId: uuidJob.tenant_id,
        jobId: uuidJob.id,
        sourceHash: uuidJob.source_hash,
      });
    });

    it('fails closed when capability signing secret is invalid', async () => {
      const extractor = createHttpPythonExtractor({
        serviceUrl: 'https://extractor.internal',
        sourceSigningSecret: 'too-short', // Less than 48 chars
        fetchFn: (async () => Response.json({})) as any,
      });

      await expect(extractor(fakeJob)).rejects.toMatchObject({
        code: 'capability_minting_failed',
        status: 500,
      });
    });
  });

  describe('Priority P0: Schema-v2 & Pipeline-v3 Robustness', () => {
    it('handles valid extraction with zero drafts and zero errors as complete', () => {
      const emptyValidPayload = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T10:00:00.000Z',
        finished_at: '2026-10-27T10:00:01.000Z',
        extraction_mode: 'ai',
        ocr_engine: 3,
        segments: [],
        drafts: [],
        evidence: [],
        capture_requests: [],
        warnings: [],
        errors: [],
      };

      const adapted = adaptPythonExtractionResult(emptyValidPayload);
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('complete');
      expect(adapted.drafts).toHaveLength(0);
      expect(adapted.invalidDrafts).toHaveLength(0);
      expect(adapted.hasReviewableDrafts).toBe(false);
    });

    it('rejects payload with unsupported schema_version', () => {
      const unsupportedPayload = {
        schema_version: 99,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T10:00:00.000Z',
        segments: [],
        drafts: [],
        evidence: [],
      };

      const adapted = adaptPythonExtractionResult(unsupportedPayload);
      expect(adapted.success).toBe(false);
      if (adapted.success) return;
      expect(adapted.errors.some((e) => e.includes('schema_version'))).toBe(true);
    });

    it('rejects payload with missing required draft fields', () => {
      const missingFieldPayload = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        started_at: '2026-10-27T10:00:00.000Z',
        segments: [
          {
            segment_id: 'seg_1',
            status: 'ready',
            method: 'text',
            text: 'Burger 12.00',
            warnings: [],
            metadata: {},
          },
        ],
        drafts: [
          {
            // Missing name!
            source_id: 'src_1',
            source_text: 'Burger 12.00',
            status: 'needs_review',
          },
        ],
        evidence: [
          {
            draft_id: 'draft_1',
            draft_index: 0,
            spans: [{ segment_id: 'seg_1', start: 0, end: 12 }],
          },
        ],
      };

      const adapted = adaptPythonExtractionResult(missingFieldPayload);
      expect(adapted.success).toBe(false);
      if (adapted.success) return;
      expect(adapted.errors.some((e) => e.includes('name'))).toBe(true);
    });
  });

  describe('Priority P0 / Section 6: Synthetic 35-Segment 210-Draft High-Volume Pipeline Verification', () => {
    it('validates and normalizes 35-page / 35-segment extraction with 210 drafts and 210 evidence spans without data loss', () => {
      // Construct a synthetic 35-page menu modeled on Denny's 35-page PDF structure
      // 35 pages/segments, 6 drafts per page = 210 total dish drafts and evidence spans
      const segments: any[] = [];
      const drafts: any[] = [];
      const evidence: any[] = [];

      let draftIdx = 0;
      for (let page = 1; page <= 35; page++) {
        const segId = `seg_page_${page}`;
        // Each page has text with 6 items
        let pageText = '';
        const pageItems: Array<{ name: string; start: number; end: number }> = [];

        for (let item = 1; item <= 6; item++) {
          const itemName = `Page ${page} Entree Item ${item}`;
          const priceStr = item === 1 ? '495 / 795 PHP' : `${item * 100}.00 PHP`;
          const itemText = `${itemName} - Freshly grilled selection: ${priceStr}.`;
          const start = pageText.length;
          pageText += itemText + ' ';
          const end = start + itemText.length;
          pageItems.push({ name: itemName, start, end });
        }

        segments.push({
          segment_id: segId,
          page_number: page,
          method: 'ocr_space_engine3',
          status: 'ready',
          text: pageText.trim(),
          warnings: [],
          metadata: { page_index: page - 1 },
        });

        for (let item = 1; item <= 6; item++) {
          const itemMeta = pageItems[item - 1]!;
          const candId = `cand_p${page}_d${item}`;
          const isGrouped = item === 1;

          drafts.push({
            candidate_id: candId,
            draft_id: `draft_p${page}_d${item}`,
            draft_index: draftIdx,
            name: itemMeta.name,
            description: `Description for page ${page} item ${item}`,
            category: `Category ${Math.ceil(page / 5)}`,
            subcategory: `Subcategory ${page}`,
            category_page_number: page,
            price_text: isGrouped ? '495 / 795 PHP' : `${item * 100}.00 PHP`,
            price_amount: isGrouped ? null : `${item * 100}.00`,
            price_currency: 'PHP',
            ingredients: ['spices', 'garnish'],
            source_id: 'src_dennys_pdf_synthetic',
            source_text: segments[page - 1]!.text.slice(itemMeta.start, itemMeta.end),
            image_id: null,
            review_warnings: isGrouped ? ['Ambiguous grouped pricing'] : [],
            status: 'needs_review',
          });

          evidence.push({
            draft_id: `draft_p${page}_d${item}`,
            draft_index: draftIdx,
            spans: [
              {
                segment_id: segId,
                start: itemMeta.start,
                end: itemMeta.end,
              },
            ],
          });

          draftIdx++;
        }
      }

      expect(segments).toHaveLength(35);
      expect(drafts).toHaveLength(210);
      expect(evidence).toHaveLength(210);

      const highVolumePayload = {
        schema_version: 2,
        pipeline_version: '3',
        status: 'complete',
        source: {
          source_id: 'src_dennys_pdf_synthetic',
          sha256: '2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275',
          kind: 'pdf',
          location: 'Dennys_Menu.pdf',
          retrieved_at: '2026-10-27T12:00:00.000Z',
          size_bytes: 7_200_000,
          snapshot_base64: 'c3ludGhldGljIGRhdGE=',
        },
        started_at: '2026-10-27T12:00:00.000Z',
        finished_at: '2026-10-27T12:06:08.000Z',
        extraction_mode: 'ai',
        extraction_model: 'gpt-4o',
        ocr_engine: 3,
        library_versions: { pymupdf: '1.24.0' },
        configuration: { pages: 35, execution_time_seconds: 368 },
        segments,
        drafts,
        evidence,
        capture_requests: [],
        warnings: [],
        errors: [],
      };

      const startTime = performance.now();
      const adapted = adaptPythonExtractionResult(highVolumePayload);
      const durationMs = performance.now() - startTime;

      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      expect(adapted.status).toBe('complete');
      expect(adapted.drafts).toHaveLength(210);
      expect(adapted.invalidDrafts).toHaveLength(0);
      expect(adapted.hasReviewableDrafts).toBe(true);
      expect(durationMs).toBeLessThan(500); // High-volume adaptation completes in <500ms

      // Verify draft identity stability, draft_index preservation, and price semantics across all 210 drafts
      for (let i = 0; i < adapted.drafts.length; i++) {
        const originalDraft = drafts[i]!;
        const adaptedDraft = adapted.drafts[i]!;

        expect(adaptedDraft.candidate_id).toBe(originalDraft.candidate_id);
        expect(adaptedDraft.draft_index).toBe(i);
        expect(adaptedDraft.name).toBe(originalDraft.name);
        expect(adaptedDraft.status).toBe('needs_review');
        expect(adaptedDraft.category_page_number).toBe(originalDraft.category_page_number);
        expect(adaptedDraft.subcategory).toBe(originalDraft.subcategory);
        expect(adaptedDraft.price_text).toBe(originalDraft.price_text);
        expect(adaptedDraft.price_amount).toBe(originalDraft.price_amount);
        expect(adaptedDraft.price_currency).toBe('PHP');
        expect(adaptedDraft.code_point_spans).toHaveLength(1);
        expect(adaptedDraft.code_point_spans[0]?.segment_id).toBe(
          `seg_page_${originalDraft.category_page_number}`,
        );
      }
    });
  });
});
