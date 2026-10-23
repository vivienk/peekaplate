import type { BoundedRetrievalResult } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { prepareS3Vis01Handoff } from './handoff';

describe('S3-VIS-01 Downstream Ingestion Handoff Integration', () => {
  const samplePassageText = 'Heirloom Tomato Salad with burrata, balsamic reduction: $16.50';
  const sampleSuccessResult: BoundedRetrievalResult = {
    schema_version: 1,
    status: 'success',
    passages: [
      {
        passage_id: 'pass_web_1_0_62',
        source: {
          source_id: 'src_bistro_menu',
          segment_id: 'src_bistro_menu#seg-3',
        },
        text: samplePassageText,
        start_offset: 0,
        end_offset: samplePassageText.length,
        rank: 1,
        score: 0.94,
      },
    ],
    warnings: [],
  };

  it('transforms successful bounded retrieval into structured S3-VIS-01 candidates', () => {
    const handoff = prepareS3Vis01Handoff(sampleSuccessResult, {
      dishName: 'Heirloom Tomato Salad',
      currency: 'USD',
    });

    expect(handoff.readyForIngestion).toBe(true);
    expect(handoff.retrievalStatus).toBe('success');
    expect(handoff.candidates).toHaveLength(1);

    const candidate = handoff.candidates[0];
    expect(candidate).toBeDefined();
    if (candidate) {
      expect(candidate.name).toBe('Heirloom Tomato Salad');
      expect(candidate.price_amount).toBe(16.5);
      expect(candidate.price_currency).toBe('USD');
      expect(candidate.source_id).toBe('src_bistro_menu');
      expect(candidate.source_text).toBe(samplePassageText);

      // Verifies exact provenance survival
      expect(candidate.evidence.spans).toHaveLength(1);
      const span = candidate.evidence.spans[0];
      expect(span?.segment_id).toBe('src_bistro_menu#seg-3');
      expect(span?.start).toBe(0);
      expect(span?.end).toBe(samplePassageText.length);

      // Review & publication boundary: candidates must NOT be auto-published
      expect(candidate.status).toBe('needs_review');
    }
  });

  it('omits price_currency when omitted or invalid ISO format rather than inventing USD', () => {
    const handoffNoCurrency = prepareS3Vis01Handoff(sampleSuccessResult, {
      dishName: 'Heirloom Tomato Salad',
    });
    expect(handoffNoCurrency.candidates[0]?.price_currency).toBeUndefined();

    const handoffSymbolCurrency = prepareS3Vis01Handoff(sampleSuccessResult, {
      dishName: 'Heirloom Tomato Salad',
      currency: '$',
    });
    expect(handoffSymbolCurrency.candidates[0]?.price_currency).toBeUndefined();
  });

  it('prevents candidate fabrication when retrieval status is no_result', () => {
    const noResult: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'no_result',
      passages: [],
      warnings: ['No matching dishes found'],
    };

    const handoff = prepareS3Vis01Handoff(noResult, {
      dishName: 'Nonexistent Caviar',
    });

    expect(handoff.readyForIngestion).toBe(false);
    expect(handoff.retrievalStatus).toBe('no_result');
    expect(handoff.candidates).toHaveLength(0);
    expect(handoff.unresolvedWarnings.some((w) => w.includes('Ingestion skipped'))).toBe(true);
  });

  it('prevents candidate fabrication when retrieval status is failed', () => {
    const failedResult: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'failed',
      passages: [],
      warnings: ['All candidate sources unreachable'],
    };

    const handoff = prepareS3Vis01Handoff(failedResult, {
      dishName: 'Roast Duck',
    });

    expect(handoff.readyForIngestion).toBe(false);
    expect(handoff.retrievalStatus).toBe('failed');
    expect(handoff.candidates).toHaveLength(0);
  });

  it('handles ambiguous retrieval by adding explicit review warnings for human staff', () => {
    const ambiguousResult: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'ambiguous',
      passages: [
        {
          passage_id: 'pass_1',
          source: { source_id: 'src_1', segment_id: 'seg_1' },
          text: 'Seafood Chowder Bowl: $12.00',
          start_offset: 0,
          end_offset: 28,
          rank: 1,
          score: 0.88,
        },
        {
          passage_id: 'pass_2',
          source: { source_id: 'src_2', segment_id: 'seg_2' },
          text: 'Seafood Chowder Cup: $7.50',
          start_offset: 0,
          end_offset: 26,
          rank: 2,
          score: 0.86,
        },
      ],
      warnings: ['Conflicting price points detected'],
    };

    const handoff = prepareS3Vis01Handoff(ambiguousResult, {
      dishName: 'Seafood Chowder',
    });

    expect(handoff.readyForIngestion).toBe(true);
    expect(handoff.retrievalStatus).toBe('ambiguous');
    expect(handoff.candidates).toHaveLength(2);
    expect(
      handoff.unresolvedWarnings.some((w) =>
        w.includes('human review must confirm correct dish formulation'),
      ),
    ).toBe(true);
  });

  it('rejects malformed retrieval payloads with strict schema error', () => {
    const invalidResult = {
      status: 'success',
      passages: [{ invalid_field: true }],
    };

    expect(() => prepareS3Vis01Handoff(invalidResult, { dishName: 'Tacos' })).toThrow();
  });
});
