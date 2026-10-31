import { describe, expect, it } from 'vitest';
import { adaptPythonExtractionResult, normalizePriceAmount } from './adapter.js';

describe('Ingestion Adapter: normalizePriceAmount', () => {
  it('normalizes valid decimal strings without precision loss', () => {
    expect(normalizePriceAmount('8.50')).toBe('8.50');
    expect(normalizePriceAmount('0.00')).toBe('0.00');
    expect(normalizePriceAmount('0')).toBe('0');
    expect(normalizePriceAmount('1200.00')).toBe('1200.00');
    expect(normalizePriceAmount('1,200.50')).toBe('1200.50');
    expect(normalizePriceAmount(14.99)).toBe('14.99');
    expect(normalizePriceAmount(0)).toBe('0');
  });

  it('returns null for null or undefined input', () => {
    expect(normalizePriceAmount(null)).toBeNull();
    expect(normalizePriceAmount(undefined)).toBeNull();
  });

  it('throws on non-numeric or negative values', () => {
    expect(() => normalizePriceAmount('-5.00')).toThrow(/Invalid price amount format/);
    expect(() => normalizePriceAmount('abc')).toThrow(/Invalid price amount format/);
    expect(() => normalizePriceAmount('$12.50')).toThrow(/Invalid price amount format/);
  });
});

describe('Ingestion Adapter: adaptPythonExtractionResult', () => {
  const baseSegment = {
    segment_id: 'seg_1',
    page_number: 1,
    method: 'pdf_native' as const,
    status: 'ready' as const,
    text: 'Soup 🍜 $8.50\nSalad 🥗 $12.00\nSteak $24.95',
    native_text: null,
    error: null,
    warnings: [],
    metadata: {},
  };

  const baseSourceRecord = {
    source_id: 'src_doc_1',
    sha256: 'a'.repeat(64),
    kind: 'pdf' as const,
    location: 'https://example.com/menu.pdf',
    retrieved_at: '2026-10-24T12:00:00.000Z',
    size_bytes: 2048,
    snapshot_base64: 'c29tZSBwZGYgZGF0YQ==',
  };

  it('adapts a valid complete extraction result preserving exact provenance and precision', () => {
    // Slicing "Steak $24.95":
    // "Soup 🍜 $8.50\nSalad 🥗 $12.00\n"
    // 'S','o','u','p',' ','🍜',' ','$','8','.','5','0','\n' = 13 code points
    // 'S','a','l','a','d',' ','🥗',' ','$','1','2','.','0','0','\n' = 15 code points
    // Total prefix: 28 code points
    // "Steak $24.95" length: 12 code points
    // start: 28, end: 40
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai',
      extraction_model: 'gpt-4o',
      ocr_engine: 3,
      library_versions: { pymupdf: '1.24.0' },
      configuration: { batch_pages: 10 },
      segments: [baseSegment],
      drafts: [
        {
          name: 'Steak',
          description: 'Grilled sirloin steak with herb butter',
          category: 'Mains',
          price_amount: '24.95',
          price_currency: 'USD',
          ingredients: ['beef', 'butter', 'herbs'],
          source_id: 'src_doc_1',
          source_text: 'Steak $24.95',
          image_id: null,
          review_warnings: ['Verify cook temperature.'],
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:steak_01',
          draft_index: 0,
          spans: [
            {
              segment_id: 'seg_1',
              start: 28,
              end: 40,
            },
          ],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.status).toBe('complete');
    expect(res.hasReviewableDrafts).toBe(true);
    expect(res.drafts).toHaveLength(1);
    expect(res.invalidDrafts).toHaveLength(0);

    const draft = res.drafts[0]!;
    expect(draft.name).toBe('Steak');
    expect(draft.description).toBe('Grilled sirloin steak with herb butter');
    expect(draft.category).toBe('Mains');
    expect(draft.price_amount).toBe('24.95');
    expect(draft.price_currency).toBe('USD');
    expect(draft.ingredients).toEqual(['beef', 'butter', 'herbs']);
    expect(draft.source_id).toBe('src_doc_1');
    expect(draft.source_text).toBe('Steak $24.95');
    expect(draft.status).toBe('needs_review'); // Invariant C
    expect(draft.review_warnings).toEqual(['Verify cook temperature.']);

    // Spans: both code points and UTF-16 code units are stored
    expect(draft.code_point_spans).toEqual([{ segment_id: 'seg_1', start: 28, end: 40 }]);
    // In UTF-16: '🍜' adds +1, '🥗' adds +1, so prefix is 30 UTF-16 units
    expect(draft.utf16_spans).toEqual([{ segment_id: 'seg_1', start: 30, end: 42 }]);
  });

  it('correctly validates and converts non-BMP emoji character offsets', () => {
    // "Soup 🍜 $8.50"
    // Code points: 12 ('S','o','u','p',' ','🍜',' ','$','8','.','5','0')
    // UTF-16 units: 13
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai',
      extraction_model: 'gpt-4o',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [baseSegment],
      drafts: [
        {
          name: 'Soup',
          description: null,
          category: 'Starters',
          price_amount: '8.50',
          price_currency: 'CAD',
          ingredients: null,
          source_id: 'src_doc_1',
          source_text: 'Soup 🍜 $8.50',
          image_id: null,
          review_warnings: [],
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:soup_01',
          draft_index: 0,
          spans: [
            {
              segment_id: 'seg_1',
              start: 0,
              end: 12, // Unicode code points
            },
          ],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    const draft = res.drafts[0]!;
    expect(draft.code_point_spans[0]).toEqual({
      segment_id: 'seg_1',
      start: 0,
      end: 12,
    });
    expect(draft.utf16_spans[0]).toEqual({
      segment_id: 'seg_1',
      start: 0,
      end: 13, // UTF-16 includes 2 units for emoji
    });
    // Check slice reconstruction
    expect(baseSegment.text.slice(0, 13)).toBe('Soup 🍜 $8.50');
  });

  it('preserves unknown facts as null without fabricating values (Invariant B)', () => {
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'layout',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [
        {
          segment_id: 'seg_minimal',
          method: 'text' as const,
          status: 'ready' as const,
          text: 'Chefs Surprise - Ask server',
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          name: 'Chefs Surprise',
          source_id: 'src_doc_1',
          source_text: 'Chefs Surprise - Ask server',
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:surprise',
          draft_index: 0,
          spans: [
            {
              segment_id: 'seg_minimal',
              start: 0,
              end: 27,
            },
          ],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    const draft = res.drafts[0]!;
    expect(draft.description).toBeNull();
    expect(draft.category).toBeNull();
    expect(draft.price_amount).toBeNull();
    expect(draft.price_currency).toBeNull();
    expect(draft.ingredients).toBeNull();
    expect(draft.image_id).toBeNull();
    expect(draft.status).toBe('needs_review');
  });

  it('preserves zero-price and thousand-separator prices without precision drift', () => {
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [
        {
          segment_id: 'seg_prices',
          method: 'text' as const,
          status: 'ready' as const,
          text: 'Water: $0.00\nCaviar: $1,250.00',
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          name: 'Water',
          price_amount: '0.00',
          price_currency: 'USD',
          source_id: 'src_doc_1',
          source_text: 'Water: $0.00',
          status: 'needs_review',
        },
        {
          name: 'Caviar',
          price_amount: '1,250.00',
          price_currency: 'USD',
          source_id: 'src_doc_1',
          source_text: 'Caviar: $1,250.00',
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:water',
          draft_index: 0,
          spans: [{ segment_id: 'seg_prices', start: 0, end: 12 }],
        },
        {
          draft_id: 'draft:caviar',
          draft_index: 1,
          spans: [{ segment_id: 'seg_prices', start: 13, end: 30 }],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.drafts[0]?.price_amount).toBe('0.00');
    expect(res.drafts[1]?.price_amount).toBe('1250.00');
  });

  it('preserves valid partial results when status is incomplete (Invariant G)', () => {
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'incomplete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [
        {
          segment_id: 'seg_p1',
          method: 'text' as const,
          status: 'ready' as const,
          text: 'Valid Dish $10.00',
          warnings: [],
          metadata: {},
        },
        {
          segment_id: 'seg_p2',
          method: 'ocr_space_engine3' as const,
          status: 'failed' as const,
          text: '',
          error: 'OCR timeout on page 2',
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          name: 'Valid Dish',
          price_amount: '10.00',
          source_id: 'src_doc_1',
          source_text: 'Valid Dish $10.00',
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:valid_dish',
          draft_index: 0,
          spans: [{ segment_id: 'seg_p1', start: 0, end: 17 }],
        },
      ],
      capture_requests: [],
      warnings: ['Page 2 acquisition failed'],
      errors: ['Page 2: OCR timeout on page 2'],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.status).toBe('incomplete');
    expect(res.hasReviewableDrafts).toBe(true);
    expect(res.drafts).toHaveLength(1);
    expect(res.drafts[0]?.name).toBe('Valid Dish');
    expect(res.errors).toContain('Page 2: OCR timeout on page 2');
    expect(res.warnings).toContain('Page 2 acquisition failed');
  });

  it('rejects drafts whose spans fail exact slice verification', () => {
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'complete',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [
        {
          segment_id: 'seg_1',
          method: 'text' as const,
          status: 'ready' as const,
          text: 'Pasta Primavera $18.00',
          warnings: [],
          metadata: {},
        },
      ],
      drafts: [
        {
          name: 'Pasta Primavera',
          source_id: 'src_doc_1',
          source_text: 'Pasta Carbonara $19.00', // Does not match segment text!
          status: 'needs_review',
        },
      ],
      evidence: [
        {
          draft_id: 'draft:pasta',
          draft_index: 0,
          spans: [{ segment_id: 'seg_1', start: 0, end: 22 }],
        },
      ],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.status).toBe('failed');
    expect(res.drafts).toHaveLength(0);
    expect(res.invalidDrafts).toHaveLength(1);
    expect(res.invalidDrafts[0]?.errors[0]).toMatch(/Span slice mismatch/);
  });

  it('handles a failed pipeline run with zero drafts gracefully', () => {
    const rawResult = {
      schema_version: 1,
      pipeline_version: '2',
      status: 'failed',
      source: baseSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'layout',
      ocr_engine: 3,
      library_versions: {},
      configuration: {},
      segments: [],
      drafts: [],
      evidence: [],
      capture_requests: [],
      warnings: [],
      errors: ['No reviewable dishes were extracted.'],
    };

    const res = adaptPythonExtractionResult(rawResult);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.status).toBe('failed');
    expect(res.hasReviewableDrafts).toBe(false);
    expect(res.drafts).toHaveLength(0);
    expect(res.errors).toContain('No reviewable dishes were extracted.');
  });

  it('fails with actionable errors when top-level schema is malformed or versions unsupported', () => {
    // Unsupported schema version
    const invalidVersion = {
      schema_version: 99,
      pipeline_version: '2',
      status: 'complete',
      started_at: '2026-10-24T12:00:00.000Z',
    };
    const resVer = adaptPythonExtractionResult(invalidVersion);
    expect(resVer.success).toBe(false);
    if (!resVer.success) {
      expect(resVer.errors.some((e) => e.includes('schema_version'))).toBe(true);
    }

    // Completely malformed object
    const resBad = adaptPythonExtractionResult({ garbage: true });
    expect(resBad.success).toBe(false);
  });
});
