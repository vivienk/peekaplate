import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type BoundedRetrievalResult,
  SourceInputSchema,
  SourceInputSegmentSchema,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import {
  codePointToUtf16Offset,
  convertSpanToCodePoints,
  convertSpanToUtf16,
  mapVis02HandoffToSourceInput,
  mapVis02SegmentToSourceSegment,
  prepareS3Vis01Handoff,
  transformRetrievalToVis02Evidence,
  utf16ToCodePointOffset,
  type Vis02ExtractionHandoff,
  type Vis02SourceSegment,
  validateSpanSourceSlice,
} from './handoff';

describe('S3-VIS-04 × VIS-02 Compatibility Adapter & Handoff Integration', () => {
  const samplePassageText = 'Heirloom Tomato Salad with burrata, balsamic reduction: $16.50';
  const sampleSha = 'd8b2e3f4a5c60123456789abcdef0123456789abcdef0123456789abcdef1234';
  const sampleSuccessResult: BoundedRetrievalResult = {
    schema_version: 1,
    status: 'success',
    passages: [
      {
        passage_id: 'pass_web_1_0_62',
        source: {
          source_id: `sha256:${sampleSha}`,
          segment_id: `sha256:${sampleSha}#page-1`,
          source_sha256: sampleSha,
          original_url: 'https://bistro.example.com/menu',
          final_url: 'https://bistro.example.com/menu.html',
          retrieved_at: '2026-10-22T20:00:00.000Z',
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

  describe('Requirement 1 & 4: Provenance, source identity and decoupled structure', () => {
    it('transforms bounded retrieval into decoupled VIS-02 drafts[] and evidence[] linked by draft_id', () => {
      const { drafts, evidence, warnings } = transformRetrievalToVis02Evidence(sampleSuccessResult);

      expect(drafts).toHaveLength(1);
      expect(evidence).toHaveLength(1);
      expect(warnings).toHaveLength(0);

      const draft = drafts[0]!;
      const ev = evidence[0]!;

      // 1. Linked by draft_id and draft_index
      expect(draft.source_id).toBe(`sha256:${sampleSha}`);
      expect(ev.draft_id).toBe('draft_pass_web_1_0_62');
      expect(ev.draft_index).toBe(0);

      // 2. Strict review boundary preserved
      expect(draft.status).toBe('needs_review');

      // 3. Price heuristic removed: no ungrounded price fabrication
      expect(draft.price_amount).toBeNull();
      expect(
        draft.review_warnings.some((w) =>
          w.includes('price and entity grounding require downstream LLM extraction'),
        ),
      ).toBe(true);

      // 4. Evidence span preserves segment identity
      expect(ev.spans).toHaveLength(1);
      expect(ev.spans[0]?.segment_id).toBe(`sha256:${sampleSha}#page-1`);
      expect(ev.spans[0]?.start).toBe(0);
      expect(ev.spans[0]?.end).toBe(samplePassageText.length);
    });

    it('preserves URL provenance fields in retrieval passages', () => {
      const passage = sampleSuccessResult.passages[0]!;
      expect(passage.source.source_sha256).toBe(sampleSha);
      expect(passage.source.original_url).toBe('https://bistro.example.com/menu');
      expect(passage.source.final_url).toBe('https://bistro.example.com/menu.html');
      expect(passage.source.retrieved_at).toBe('2026-10-22T20:00:00.000Z');
    });

    it('preserves candidate structure and decoupled evidence in prepareS3Vis01Handoff', () => {
      const handoff = prepareS3Vis01Handoff(sampleSuccessResult, {
        dishName: 'Heirloom Tomato Salad',
        currency: 'USD',
      });

      expect(handoff.readyForIngestion).toBe(true);
      expect(handoff.retrievalStatus).toBe('success');
      expect(handoff.candidates).toHaveLength(1);
      expect(handoff.decoupledEvidence).toHaveLength(1);

      const candidate = handoff.candidates[0]!;
      expect(candidate.name).toBe('Heirloom Tomato Salad');
      expect(candidate.price_currency).toBe('USD');
      // Price regex removed from candidate generation
      expect(candidate.price_amount).toBeUndefined();
      expect(candidate.status).toBe('needs_review');
      expect(candidate.evidence.spans[0]?.segment_id).toBe(`sha256:${sampleSha}#page-1`);
    });
  });

  describe('Requirement 2: Unicode code-point vs UTF-16 offset semantics', () => {
    // Concrete test case from Mohammad: 'Soup 🍜 $8.50'
    const emojiMenuText = 'Soup 🍜 $8.50';

    it('calculates exact offsets across emoji boundaries under both conventions', () => {
      // In JS (UTF-16 code units), '🍜' (U+1F35C) takes 2 code units
      expect(emojiMenuText.length).toBe(13);
      // In Python (Unicode code points), '🍜' is 1 code point
      expect(Array.from(emojiMenuText).length).toBe(12);

      const jsPriceStart = emojiMenuText.indexOf('$8.50'); // 8
      const jsPriceEnd = jsPriceStart + '$8.50'.length; // 13

      // Convert to Python Unicode code points
      const cpPriceStart = utf16ToCodePointOffset(emojiMenuText, jsPriceStart);
      const cpPriceEnd = utf16ToCodePointOffset(emojiMenuText, jsPriceEnd);

      expect(cpPriceStart).toBe(7);
      expect(cpPriceEnd).toBe(12);

      // Verify slice equality in both domains
      expect(emojiMenuText.slice(jsPriceStart, jsPriceEnd)).toBe('$8.50');
      expect(Array.from(emojiMenuText).slice(cpPriceStart, cpPriceEnd).join('')).toBe('$8.50');

      // Round-trip conversion
      expect(codePointToUtf16Offset(emojiMenuText, cpPriceStart)).toBe(jsPriceStart);
      expect(codePointToUtf16Offset(emojiMenuText, cpPriceEnd)).toBe(jsPriceEnd);
    });

    it('converts spans between UTF-16 and Unicode code-point representations', () => {
      const utf16Span = { segment_id: 'seg_emoji', start: 8, end: 13 };
      const cpSpan = convertSpanToCodePoints(emojiMenuText, utf16Span);

      expect(cpSpan).toEqual({ segment_id: 'seg_emoji', start: 7, end: 12 });

      const backToUtf16 = convertSpanToUtf16(emojiMenuText, cpSpan);
      expect(backToUtf16).toEqual(utf16Span);
    });

    it('validates exact source-slice equality against segment text', () => {
      const validCheck = validateSpanSourceSlice(
        emojiMenuText,
        { segment_id: 'seg_emoji', start: 7, end: 12 },
        '$8.50',
        'codepoint',
      );
      expect(validCheck.valid).toBe(true);
      expect(validCheck.actualSlice).toBe('$8.50');

      const invalidCheck = validateSpanSourceSlice(
        emojiMenuText,
        { segment_id: 'seg_emoji', start: 0, end: 4 },
        'Stew', // Expected 'Soup' but text is 'Stew'
        'codepoint',
      );
      expect(invalidCheck.valid).toBe(false);
      expect(invalidCheck.actualSlice).toBe('Soup');
      expect(invalidCheck.error).toContain('does not match expected passage text');
    });

    it('rejects a case where span length matches but content differs', () => {
      // 4 characters long, but wrong slice
      const check = validateSpanSourceSlice(
        'Beef Taco and Fish Taco',
        { segment_id: 'seg_taco', start: 0, end: 9 }, // 'Beef Taco'
        'Fish Taco', // Length is 9, but text at [0, 9] is 'Beef Taco'
        'utf16',
      );
      expect(check.valid).toBe(false);
      expect(check.actualSlice).toBe('Beef Taco');
    });

    it('rejects out-of-range or inverted spans', () => {
      expect(
        validateSpanSourceSlice('Short', { segment_id: 'seg', start: 10, end: 20 }, 'anything')
          .valid,
      ).toBe(false);

      expect(
        validateSpanSourceSlice('Short', { segment_id: 'seg', start: 4, end: 2 }, 'anything').valid,
      ).toBe(false);
    });

    describe('transformRetrievalToVis02Evidence Unicode offset regression tests (Raghav review)', () => {
      const soupEmojiText = 'Soup 🍜 $8.50';
      const soupSegmentId = 'sha256:abc#page-1';

      const soupResultAtZero: BoundedRetrievalResult = {
        schema_version: 1,
        status: 'success',
        passages: [
          {
            passage_id: 'p_soup_0_13',
            source: {
              source_id: 'sha256:abc',
              segment_id: soupSegmentId,
            },
            text: soupEmojiText,
            start_offset: 0,
            end_offset: 13, // 13 UTF-16 code units (🍜 is 2 code units)
            score: 0.95,
            rank: 1,
          },
        ],
        warnings: [],
      };

      const embeddedSegText = 'Special 🍲: Soup 🍜 $8.50 - Extra Spicy';
      // In embeddedSegText:
      // 'Special 🍲: ' has 1 emoji (2 UTF-16 code units, 1 code point) + 10 ASCII chars = 12 UTF-16 code units, 11 code points
      // 'Soup 🍜 $8.50' has 1 emoji (2 UTF-16 units, 1 code point) + 11 chars = 13 UTF-16 code units, 12 code points
      const embeddedResult: BoundedRetrievalResult = {
        schema_version: 1,
        status: 'success',
        passages: [
          {
            passage_id: 'p_soup_12_25',
            source: {
              source_id: 'sha256:abc',
              segment_id: soupSegmentId,
            },
            text: soupEmojiText,
            start_offset: 12, // in UTF-16
            end_offset: 25, // 12 + 13 = 25 in UTF-16
            score: 0.92,
            rank: 1,
          },
        ],
        warnings: [],
      };

      describe('Case A: sourceSegments provided', () => {
        it('emits exact Python code-point offsets for passage at offset 0 and reconstructs slice', () => {
          const { evidence } = transformRetrievalToVis02Evidence(soupResultAtZero, {
            sourceSegments: { [soupSegmentId]: soupEmojiText },
          });

          expect(evidence).toHaveLength(1);
          const span = evidence[0]!.spans[0]!;
          expect(span.segment_id).toBe(soupSegmentId);

          // Assert exact expected code-point offsets (12 code points vs 13 UTF-16 units)
          expect(span.start).toBe(0);
          expect(span.end).toBe(12);
          expect(span.end).not.toBe(soupResultAtZero.passages[0]!.end_offset);

          // Slicing original source using output offsets reconstructs exact evidence text
          const reconstructed = Array.from(soupEmojiText).slice(span.start, span.end).join('');
          expect(reconstructed).toBe(soupEmojiText);
        });

        it('emits exact Python code-point offsets when embedded in longer segment with emoji prefix', () => {
          const { evidence } = transformRetrievalToVis02Evidence(embeddedResult, {
            sourceSegments: { [soupSegmentId]: embeddedSegText },
          });

          const span = evidence[0]!.spans[0]!;
          expect(span.segment_id).toBe(soupSegmentId);

          // In UTF-16, offsets were [12, 25]
          // In Unicode code points, offsets are [11, 23] (due to '🍲' in prefix and '🍜' in passage)
          expect(span.start).toBe(11);
          expect(span.end).toBe(23);
          expect(span.start).not.toBe(embeddedResult.passages[0]!.start_offset);
          expect(span.end).not.toBe(embeddedResult.passages[0]!.end_offset);

          // Slicing original source using output offsets reconstructs exact evidence text
          const reconstructed = Array.from(embeddedSegText).slice(span.start, span.end).join('');
          expect(reconstructed).toBe(soupEmojiText);
        });

        it('fails explicitly when required segment is missing from sourceSegments without silent fallback', () => {
          expect(() =>
            transformRetrievalToVis02Evidence(soupResultAtZero, {
              sourceSegments: { 'other_segment#page-2': 'Unrelated text' },
            }),
          ).toThrow(/Missing source segment text for segment/);
        });
      });

      describe('Case B: sourceSegments absent', () => {
        it('safely converts passage at offset 0 using trusted passage text and reconstructs exact slice', () => {
          const { evidence } = transformRetrievalToVis02Evidence(soupResultAtZero);

          expect(evidence).toHaveLength(1);
          const span = evidence[0]!.spans[0]!;
          expect(span.segment_id).toBe(soupSegmentId);

          // In UTF-16, end_offset was 13. In code points, it must be 12.
          expect(span.start).toBe(0);
          expect(span.end).toBe(12);
          expect(span.end).not.toBe(soupResultAtZero.passages[0]!.end_offset);

          // Slicing trusted passage text using code-point offsets reconstructs exact evidence text
          const reconstructed = Array.from(soupEmojiText).slice(span.start, span.end).join('');
          expect(reconstructed).toBe(soupEmojiText);
        });

        it('fails explicitly when passage start_offset > 0 without sourceSegments', () => {
          // When start_offset > 0, characters before start_offset are unknown.
          // The adapter must fail explicitly rather than emitting inaccurate offsets.
          expect(() => transformRetrievalToVis02Evidence(embeddedResult)).toThrow(
            /Cannot convert segment offsets to Unicode code points without source segment text when passage start_offset \(12\) > 0/,
          );
        });

        it('emits unchanged UTF-16 offsets when offsetUnit is explicitly "utf16"', () => {
          const { evidence } = transformRetrievalToVis02Evidence(soupResultAtZero, {
            offsetUnit: 'utf16',
          });

          const span = evidence[0]!.spans[0]!;
          expect(span.start).toBe(0);
          expect(span.end).toBe(13); // UTF-16 code units
        });
      });
    });
  });

  describe('Requirement 3: Price grounding and currency handling', () => {
    it('does NOT infer or default currency to USD when currency is omitted', () => {
      const handoff = prepareS3Vis01Handoff(sampleSuccessResult, {
        dishName: 'Heirloom Tomato Salad',
      });
      expect(handoff.candidates[0]?.price_currency).toBeUndefined();
    });

    it('does NOT infer currency from symbol like $', () => {
      const handoff = prepareS3Vis01Handoff(sampleSuccessResult, {
        dishName: 'Heirloom Tomato Salad',
        currency: '$',
      });
      expect(handoff.candidates[0]?.price_currency).toBeUndefined();
    });

    it('does NOT extract heuristic prices from passage text into candidates', () => {
      const handoff = prepareS3Vis01Handoff(sampleSuccessResult, {
        dishName: 'Heirloom Tomato Salad',
        currency: 'USD',
      });
      // The passage has '$16.50', but we strictly leave candidate price_amount undefined
      expect(handoff.candidates[0]?.price_amount).toBeUndefined();
    });
  });

  describe('Requirement 5: Failure handling and schema boundaries', () => {
    it('prevents candidate fabrication when retrieval status is no_result', () => {
      const noResult: BoundedRetrievalResult = {
        schema_version: 1,
        status: 'no_result',
        passages: [],
        warnings: ['No matching dishes found'],
      };

      const handoff = prepareS3Vis01Handoff(noResult, { dishName: 'Caviar' });
      expect(handoff.readyForIngestion).toBe(false);
      expect(handoff.candidates).toHaveLength(0);
      expect(handoff.decoupledEvidence).toHaveLength(0);
    });

    it('prevents candidate fabrication when retrieval status is failed', () => {
      const failedResult: BoundedRetrievalResult = {
        schema_version: 1,
        status: 'failed',
        passages: [],
        warnings: ['All candidate sources unreachable'],
      };

      const handoff = prepareS3Vis01Handoff(failedResult, { dishName: 'Duck' });
      expect(handoff.readyForIngestion).toBe(false);
      expect(handoff.candidates).toHaveLength(0);
    });

    it('handles ambiguous retrieval by adding explicit review warnings for staff', () => {
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
        ],
        warnings: ['Conflicting price points detected'],
      };

      const handoff = prepareS3Vis01Handoff(ambiguousResult, {
        dishName: 'Seafood Chowder',
      });

      expect(handoff.readyForIngestion).toBe(true);
      expect(handoff.retrievalStatus).toBe('ambiguous');
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

  describe('Finding P2: Apply correct Unicode offsets to the VIS-01 handoff (prepareS3Vis01Handoff)', () => {
    const soupEmojiText = 'Soup 🍜 $8.50';
    const soupSegmentId = 'sha256:abc#page-1';

    const soupResultAtZero: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'success',
      passages: [
        {
          passage_id: 'p_soup_0_13',
          source: {
            source_id: 'sha256:abc',
            segment_id: soupSegmentId,
          },
          text: soupEmojiText,
          start_offset: 0,
          end_offset: 13, // 13 UTF-16 code units (🍜 is 2 code units)
          score: 0.95,
          rank: 1,
        },
      ],
      warnings: [],
    };

    const embeddedSegText = 'Special 🍲: Soup 🍜 $8.50 - Extra Spicy';
    const embeddedResult: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'success',
      passages: [
        {
          passage_id: 'p_soup_12_25',
          source: {
            source_id: 'sha256:abc',
            segment_id: soupSegmentId,
          },
          text: soupEmojiText,
          start_offset: 12, // in UTF-16
          end_offset: 25, // 12 + 13 = 25 in UTF-16
          score: 0.92,
          rank: 1,
        },
      ],
      warnings: [],
    };

    it('emits Python code-point end offset 12 instead of UTF-16 end offset 13 for Soup 🍜 $8.50 at offset 0', () => {
      const handoff = prepareS3Vis01Handoff(soupResultAtZero, { dishName: 'Ramen Soup' });

      expect(handoff.candidates).toHaveLength(1);
      expect(handoff.decoupledEvidence).toHaveLength(1);

      const candidateSpan = handoff.candidates[0]!.evidence.spans[0]!;
      const decoupledSpan = handoff.decoupledEvidence[0]!.spans[0]!;

      // Both VIS-01 and decoupled VIS-02 spans must have code-point offsets
      expect(candidateSpan.start).toBe(0);
      expect(candidateSpan.end).toBe(12); // 12 code points, NOT 13 UTF-16 code units!
      expect(decoupledSpan.start).toBe(0);
      expect(decoupledSpan.end).toBe(12);

      // Reconstructed slice using code-point offsets matches exact text
      const reconstructed = Array.from(soupEmojiText)
        .slice(candidateSpan.start, candidateSpan.end)
        .join('');
      expect(reconstructed).toBe(soupEmojiText);
    });

    it('converts offsets accurately when emoji precedes a passage at a non-zero offset', () => {
      const handoff = prepareS3Vis01Handoff(
        embeddedResult,
        { dishName: 'Ramen Soup' },
        { sourceSegments: { [soupSegmentId]: embeddedSegText } },
      );

      const candidateSpan = handoff.candidates[0]!.evidence.spans[0]!;
      // 'Special 🍲: ' has 1 emoji, taking 12 UTF-16 units and 11 code points
      // In code points, span must be [11, 23]
      expect(candidateSpan.start).toBe(11);
      expect(candidateSpan.end).toBe(23);

      const reconstructed = Array.from(embeddedSegText)
        .slice(candidateSpan.start, candidateSpan.end)
        .join('');
      expect(reconstructed).toBe(soupEmojiText);
    });

    it('handles multiple non-BMP characters preceding a passage accurately', () => {
      const multiEmojiPrefix = '🌮 🍕 🍜 - Specials: Soup 🍜 $8.50';
      // '🌮 🍕 🍜 - Specials: ' has 3 emojis (each 2 UTF-16 units, 1 code point)
      // Length in UTF-16: 6 + 15 = 21
      // Length in code points: 3 + 15 = 18
      const multiEmojiResult: BoundedRetrievalResult = {
        schema_version: 1,
        status: 'success',
        passages: [
          {
            passage_id: 'p_soup_multi',
            source: { source_id: 'sha256:abc', segment_id: soupSegmentId },
            text: soupEmojiText,
            start_offset: 21,
            end_offset: 34,
            rank: 1,
          },
        ],
        warnings: [],
      };

      const handoff = prepareS3Vis01Handoff(
        multiEmojiResult,
        { dishName: 'Soup' },
        { sourceSegments: { [soupSegmentId]: multiEmojiPrefix } },
      );

      const span = handoff.candidates[0]!.evidence.spans[0]!;
      expect(span.start).toBe(18);
      expect(span.end).toBe(30);

      const reconstructed = Array.from(multiEmojiPrefix).slice(span.start, span.end).join('');
      expect(reconstructed).toBe(soupEmojiText);
    });

    it('fails explicitly when start_offset > 0 and source segment text is unavailable', () => {
      expect(() => prepareS3Vis01Handoff(embeddedResult, { dishName: 'Soup' })).toThrow(
        /Cannot convert segment offsets to Unicode code points without source segment text/,
      );
    });

    it('fails explicitly when source slice text does not match expected passage text', () => {
      expect(() =>
        prepareS3Vis01Handoff(
          embeddedResult,
          { dishName: 'Soup' },
          { sourceSegments: { [soupSegmentId]: 'Completely mismatched source text content' } },
        ),
      ).toThrow(/out of bounds for segment|Slice validation failed/);
    });

    it('supports explicit offsetUnit: "utf16" override', () => {
      const handoff = prepareS3Vis01Handoff(
        soupResultAtZero,
        { dishName: 'Soup' },
        { offsetUnit: 'utf16' },
      );

      const span = handoff.candidates[0]!.evidence.spans[0]!;
      expect(span.start).toBe(0);
      expect(span.end).toBe(13); // Preserved as UTF-16 code units
    });
  });

  describe('Finding P3: Validate code-point bounds before offset conversion', () => {
    it('rejects the exact reviewer reproduction case (end: 999 on "Soup")', () => {
      // The validator must return valid: false, not valid: true
      const result = validateSpanSourceSlice(
        'Soup',
        { segment_id: 's', start: 0, end: 999 },
        'Soup',
        'codepoint',
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceed segment code-point length');
    });

    it('rejects negative start or negative end offsets', () => {
      expect(
        validateSpanSourceSlice('Soup', { segment_id: 's', start: -1, end: 4 }, 'Soup', 'codepoint')
          .valid,
      ).toBe(false);

      expect(
        validateSpanSourceSlice('Soup', { segment_id: 's', start: 0, end: -1 }, 'Soup', 'codepoint')
          .valid,
      ).toBe(false);
    });

    it('rejects fractional offsets', () => {
      expect(
        validateSpanSourceSlice(
          'Soup',
          { segment_id: 's', start: 0.5, end: 3.5 },
          'Soup',
          'codepoint',
        ).valid,
      ).toBe(false);
    });

    it('rejects inverted offsets where start > end', () => {
      expect(
        validateSpanSourceSlice('Soup', { segment_id: 's', start: 4, end: 2 }, 'Soup', 'codepoint')
          .valid,
      ).toBe(false);
    });

    it('rejects start beyond segment length', () => {
      expect(
        validateSpanSourceSlice(
          'Soup',
          { segment_id: 's', start: 10, end: 12 },
          'Soup',
          'codepoint',
        ).valid,
      ).toBe(false);
    });

    it('accepts valid end-of-string offsets', () => {
      const result = validateSpanSourceSlice(
        'Soup',
        { segment_id: 's', start: 0, end: 4 },
        'Soup',
        'codepoint',
      );
      expect(result.valid).toBe(true);
      expect(result.actualSlice).toBe('Soup');
    });

    it('accepts valid code-point span containing non-BMP emoji', () => {
      const result = validateSpanSourceSlice(
        'Soup 🍜',
        { segment_id: 's', start: 0, end: 6 }, // 6 code points
        'Soup 🍜',
        'codepoint',
      );
      expect(result.valid).toBe(true);
      expect(result.actualSlice).toBe('Soup 🍜');
    });

    it('rejects empty spans when expected passage text is non-empty', () => {
      expect(
        validateSpanSourceSlice('Soup', { segment_id: 's', start: 2, end: 2 }, 'Soup', 'codepoint')
          .valid,
      ).toBe(false);
    });

    it('codePointToUtf16Offset and utf16ToCodePointOffset throw on out-of-bounds or invalid inputs instead of clamping', () => {
      expect(() => codePointToUtf16Offset('Soup', 999)).toThrow(RangeError);
      expect(() => codePointToUtf16Offset('Soup', -1)).toThrow(RangeError);
      expect(() => codePointToUtf16Offset('Soup', 1.5)).toThrow(RangeError);

      expect(() => utf16ToCodePointOffset('Soup', 999)).toThrow(RangeError);
      expect(() => utf16ToCodePointOffset('Soup', -1)).toThrow(RangeError);
      expect(() => utf16ToCodePointOffset('Soup', 2.5)).toThrow(RangeError);
    });

    it('convertSpanToUtf16 and convertSpanToCodePoints throw on invalid spans', () => {
      expect(() => convertSpanToUtf16('Soup', { segment_id: 's', start: 0, end: 999 })).toThrow();
      expect(() =>
        convertSpanToCodePoints('Soup', { segment_id: 's', start: 0, end: 999 }),
      ).toThrow();
    });
  });

  describe('Requirement 9: Explicit VIS-01 adapter mapping & Python schema compatibility', () => {
    it('maps Python segment with nullable fields and extra fields into valid TypeScript SourceInputSegment', () => {
      const pythonSegmentFixture: Vis02SourceSegment = {
        segment_id: 'seg_py_1',
        text: 'Artisan Sourdough with salted butter: $7.00',
        page_number: null, // Python None
        method: 'ocr_space_engine3',
        status: 'ready',
        native_text: 'Raw OCR token stream without normalization',
        error: null, // Python None
        warnings: ['Low confidence on symbol $'],
        metadata: { ocr_engine: 'engine3' },
      };

      const mapped = mapVis02SegmentToSourceSegment(pythonSegmentFixture);

      // Verify nullable fields are omitted rather than passed as null
      expect(mapped.page_number).toBeUndefined();
      expect(mapped).not.toHaveProperty('page_number');
      expect(mapped.error).toBeUndefined();
      expect(mapped).not.toHaveProperty('error');

      // Verify native_text was preserved in metadata
      expect(mapped.metadata?.native_text).toBe('Raw OCR token stream without normalization');
      expect(mapped.metadata?.ocr_engine).toBe('engine3');

      // Verify status, method, warnings, and text are preserved
      expect(mapped.status).toBe('ready');
      expect(mapped.method).toBe('ocr_space_engine3');
      expect(mapped.warnings).toEqual(['Low confidence on symbol $']);
      expect(mapped.text).toBe('Artisan Sourdough with salted butter: $7.00');
    });

    it('maps full Vis02ExtractionHandoff into valid SourceInput passing Zod schema validation', () => {
      const pythonHandoffFixture: Vis02ExtractionHandoff = {
        schema_version: 1,
        pipeline_version: '2',
        status: 'complete',
        source: {
          source_id: 'src_doc_123',
          sha256: 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef1234',
          kind: 'pdf',
          location: 'https://restaurant.example.com/menu.pdf',
          retrieved_at: '2026-10-24T12:00:00.000Z',
          size_bytes: 1048576,
        },
        segments: [
          {
            segment_id: 'src_doc_123#page-1',
            page_number: 1,
            method: 'pdf_native',
            status: 'ready',
            text: 'Caesar Salad: crisp romaine, shaved parmesan, garlic croutons $14.00',
            native_text: null,
            error: null,
            warnings: [],
          },
          {
            segment_id: 'src_doc_123#page-2',
            page_number: 2,
            method: 'ocr',
            status: 'failed',
            text: 'Unreadable scanned beverage list',
            native_text: null,
            error: 'Resolution too low',
            warnings: ['Failed to process page 2'],
          },
        ],
        drafts: [],
        evidence: [],
        warnings: [],
        errors: [],
      };

      const sourceInput = mapVis02HandoffToSourceInput(pythonHandoffFixture);

      expect(sourceInput.source_id).toBe('src_doc_123');
      expect(sourceInput.sha256).toBe(pythonHandoffFixture.source?.sha256);
      expect(sourceInput.kind).toBe('pdf');
      expect(sourceInput.segments).toHaveLength(2);

      expect(sourceInput.segments![0]?.page_number).toBe(1);
      expect(sourceInput.segments![0]?.status).toBe('ready');
      expect(sourceInput.segments![0]).not.toHaveProperty('error');

      expect(sourceInput.segments![1]?.status).toBe('failed');
      expect(sourceInput.segments![1]?.error).toBe('Resolution too low');
      expect(sourceInput.segments![1]).toHaveProperty('error', 'Resolution too low');
    });

    describe('VIS-01 error: null normalization and contract boundaries (Sai review)', () => {
      it('Case 1 (Explicit null): input contains error: null; mapped output does not have own error property', () => {
        const input: Vis02SourceSegment = {
          segment_id: 'seg_explicit_null',
          text: 'Wild Mushroom Risotto with truffle oil: $22.00',
          status: 'ready',
          method: 'pdf_native',
          error: null,
          warnings: [],
        };

        const mapped = mapVis02SegmentToSourceSegment(input);

        expect(mapped.error).toBeUndefined();
        expect(mapped).not.toHaveProperty('error');
        expect(Object.prototype.hasOwnProperty.call(mapped, 'error')).toBe(false);
        expect(mapped.text).toBe('Wild Mushroom Risotto with truffle oil: $22.00');
        expect(mapped.status).toBe('ready');
        expect(mapped.method).toBe('pdf_native');
      });

      it('Case 2 (Omitted field): input has no error property; mapped output does not have own error property', () => {
        const input: Vis02SourceSegment = {
          segment_id: 'seg_omitted_error',
          text: 'Pan-seared Chilean Sea Bass: $34.00',
          status: 'ready',
          method: 'text',
          warnings: [],
        };
        expect(input).not.toHaveProperty('error');

        const mapped = mapVis02SegmentToSourceSegment(input);

        expect(mapped.error).toBeUndefined();
        expect(mapped).not.toHaveProperty('error');
        expect(Object.prototype.hasOwnProperty.call(mapped, 'error')).toBe(false);
        expect(mapped.text).toBe('Pan-seared Chilean Sea Bass: $34.00');
        expect(mapped.status).toBe('ready');
      });

      it('Case 3 (Actual error): input contains an error string; mapped output preserves it', () => {
        const input: Vis02SourceSegment = {
          segment_id: 'seg_with_error',
          text: 'Corrupted OCR text stream',
          status: 'failed',
          method: 'ocr',
          error: 'OCR engine timed out after 10000ms',
          warnings: ['Processing incomplete'],
        };

        const mapped = mapVis02SegmentToSourceSegment(input);

        expect(mapped).toHaveProperty('error', 'OCR engine timed out after 10000ms');
        expect(mapped.error).toBe('OCR engine timed out after 10000ms');
        expect(mapped.status).toBe('failed');
        expect(mapped.warnings).toEqual(['Processing incomplete']);
      });

      it('Case 4 (Failed status): a failed page/segment with error: null remains failed after mapping', () => {
        const input: Vis02SourceSegment = {
          segment_id: 'seg_failed_null_error',
          page_number: 3,
          text: 'Unparseable binary page stream',
          status: 'failed',
          method: 'ocr_space_engine3',
          error: null,
          warnings: ['Page decoding aborted by upstream worker'],
        };

        const mapped = mapVis02SegmentToSourceSegment(input);

        // Crucial: Must remain failed even though error field is null and omitted
        expect(mapped.status).toBe('failed');
        expect(mapped).not.toHaveProperty('error');
        expect(mapped.error).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(mapped, 'error')).toBe(false);
        expect(mapped.page_number).toBe(3);
        expect(mapped.warnings).toEqual(['Page decoding aborted by upstream worker']);
      });

      it('Case 5 (Contract validity): normalized output strictly satisfies SourceInputSegmentSchema and SourceInputSchema', () => {
        const nullErrorSeg: Vis02SourceSegment = {
          segment_id: 'seg_valid_null',
          text: 'Tomato Basil Soup: $9.00',
          method: 'pdf_native',
          status: 'ready',
          error: null,
          warnings: [],
        };
        const omittedErrorSeg: Vis02SourceSegment = {
          segment_id: 'seg_valid_omitted',
          text: 'Garlic Bread: $6.00',
          method: 'text',
          status: 'ready',
          warnings: [],
        };
        const actualErrorSeg: Vis02SourceSegment = {
          segment_id: 'seg_valid_error',
          text: 'Scanned beverage section',
          method: 'ocr',
          status: 'failed',
          error: 'Resolution below 150 DPI threshold',
          warnings: ['Quality check failed'],
        };
        const failedNullSeg: Vis02SourceSegment = {
          segment_id: 'seg_valid_failed_null',
          text: 'Empty page content',
          method: 'ocr_space_engine3',
          status: 'failed',
          error: null,
          warnings: ['No text detected'],
        };

        const mappedNull = mapVis02SegmentToSourceSegment(nullErrorSeg);
        const mappedOmitted = mapVis02SegmentToSourceSegment(omittedErrorSeg);
        const mappedError = mapVis02SegmentToSourceSegment(actualErrorSeg);
        const mappedFailedNull = mapVis02SegmentToSourceSegment(failedNullSeg);

        // Schema parse validations
        expect(SourceInputSegmentSchema.safeParse(mappedNull).success).toBe(true);
        expect(SourceInputSegmentSchema.safeParse(mappedOmitted).success).toBe(true);
        expect(SourceInputSegmentSchema.safeParse(mappedError).success).toBe(true);
        expect(SourceInputSegmentSchema.safeParse(mappedFailedNull).success).toBe(true);

        // Property absence/presence assertions
        expect(mappedNull).not.toHaveProperty('error');
        expect(mappedOmitted).not.toHaveProperty('error');
        expect(mappedFailedNull).not.toHaveProperty('error');
        expect(mappedError).toHaveProperty('error', 'Resolution below 150 DPI threshold');

        // Full handoff document schema validation
        const fullHandoff: Vis02ExtractionHandoff = {
          schema_version: 1,
          pipeline_version: '2',
          status: 'complete',
          source: {
            source_id: 'src_doc_norm_test',
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            kind: 'pdf',
            location: 'https://restaurant.example.com/menu.pdf',
            retrieved_at: '2026-10-24T12:00:00.000Z',
            size_bytes: 2048,
          },
          segments: [nullErrorSeg, omittedErrorSeg, actualErrorSeg, failedNullSeg],
          drafts: [],
          evidence: [],
          warnings: [],
          errors: [],
        };

        const mappedSourceInput = mapVis02HandoffToSourceInput(fullHandoff);
        const parsedSourceInput = SourceInputSchema.safeParse(mappedSourceInput);
        expect(parsedSourceInput.success).toBe(true);

        expect(mappedSourceInput.segments).toHaveLength(4);
        expect(mappedSourceInput.segments![0]).not.toHaveProperty('error');
        expect(mappedSourceInput.segments![1]).not.toHaveProperty('error');
        expect(mappedSourceInput.segments![2]).toHaveProperty(
          'error',
          'Resolution below 150 DPI threshold',
        );
        expect(mappedSourceInput.segments![3]).not.toHaveProperty('error');
        expect(mappedSourceInput.segments![3]?.status).toBe('failed');
      });
    });

    describe('VIS-02 × VIS-04 Schema & Pipeline Version Alignment', () => {
      const baseSource = {
        source_id: 'src_version_alignment_test',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        kind: 'pdf' as const,
        location: 'https://restaurant.example.com/menu.pdf',
        retrieved_at: '2026-10-28T12:00:00.000Z',
        size_bytes: 4096,
      };

      const baseSegments: Vis02SourceSegment[] = [
        {
          segment_id: 'seg_page_1',
          page_number: 1,
          method: 'pdf_native',
          status: 'ready',
          text: 'Appetizers: Soup 🍜 $8.50, Salad 🥗 $12.00',
          warnings: [],
        },
      ];

      it('accepts schema 1 / pipeline 2 handoff and preserves SourceInput and provenance', () => {
        const v1Handoff: Vis02ExtractionHandoff = {
          schema_version: 1,
          pipeline_version: '2',
          status: 'complete',
          source: baseSource,
          segments: baseSegments,
          drafts: [
            {
              name: 'Soup',
              category: 'Appetizers',
              price_amount: '8.50',
              price_currency: 'USD',
              source_id: baseSource.source_id,
              source_text: 'Soup 🍜 $8.50',
              review_warnings: [],
              status: 'needs_review',
            },
          ],
          evidence: [],
          warnings: [],
          errors: [],
        };

        const sourceInput = mapVis02HandoffToSourceInput(v1Handoff);
        expect(SourceInputSchema.safeParse(sourceInput).success).toBe(true);
        expect(sourceInput.source_id).toBe(baseSource.source_id);
        expect(sourceInput.sha256).toBe(baseSource.sha256);
        expect(sourceInput.segments).toHaveLength(1);
        expect(sourceInput.segments![0]?.text).toBe(baseSegments[0]!.text);
      });

      it('accepts schema 2 / pipeline 3 handoff with new optional dish metadata without altering SourceInput', () => {
        const v2Handoff: Vis02ExtractionHandoff = {
          schema_version: 2,
          pipeline_version: '3',
          status: 'complete',
          source: baseSource,
          segments: baseSegments,
          drafts: [
            {
              candidate_id: 'cand_garden_soup_001',
              draft_id: 'draft_soup_001',
              draft_index: 0,
              name: 'Soup',
              category: 'FOOD',
              subcategory: 'HOT_SOUPS',
              category_page_number: 1,
              price_text: '8.50 / 12.50 USD',
              price_amount: null,
              price_currency: 'USD',
              source_id: baseSource.source_id,
              source_text: 'Soup 🍜 $8.50',
              review_warnings: ['Ambiguous grouped pricing'],
              status: 'needs_review',
            },
          ],
          evidence: [],
          warnings: [],
          errors: [],
        };

        const sourceInput = mapVis02HandoffToSourceInput(v2Handoff);
        expect(SourceInputSchema.safeParse(sourceInput).success).toBe(true);
        expect(sourceInput.source_id).toBe(baseSource.source_id);
        expect(sourceInput.sha256).toBe(baseSource.sha256);
        expect(sourceInput.segments).toHaveLength(1);
        expect(sourceInput.segments![0]?.text).toBe(baseSegments[0]!.text);
        expect(sourceInput.segments![0]?.page_number).toBe(1);
      });

      it('rejects unsupported schema_version using standard Error convention', () => {
        const invalidSchemaHandoff = {
          schema_version: 3,
          pipeline_version: '3',
          status: 'complete',
          source: baseSource,
          segments: baseSegments,
          drafts: [],
          evidence: [],
          warnings: [],
          errors: [],
        } as unknown as Vis02ExtractionHandoff;

        expect(() => mapVis02HandoffToSourceInput(invalidSchemaHandoff)).toThrow(
          'Unsupported schema_version: 3. Expected 1 or 2.',
        );
      });

      it('rejects unsupported pipeline_version using standard Error convention', () => {
        const invalidPipelineHandoff = {
          schema_version: 2,
          pipeline_version: '4',
          status: 'complete',
          source: baseSource,
          segments: baseSegments,
          drafts: [],
          evidence: [],
          warnings: [],
          errors: [],
        } as unknown as Vis02ExtractionHandoff;

        expect(() => mapVis02HandoffToSourceInput(invalidPipelineHandoff)).toThrow(
          "Unsupported pipeline_version: 4. Expected '2' or '3'.",
        );
      });

      it('accepts genuine Mohammad PR #58 schema-v2/pipeline-v3 extraction fixture and maps SourceInput', () => {
        const fixturePath = resolve(
          process.cwd(),
          'tests/fixtures/menu-ingestion/vis02-mohammad-extraction-v2.json',
        );
        const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Vis02ExtractionHandoff;

        const sourceInput = mapVis02HandoffToSourceInput(fixture);
        const parsed = SourceInputSchema.safeParse(sourceInput);
        expect(parsed.success).toBe(true);

        expect(sourceInput.source_id).toBe(fixture.source?.source_id);
        expect(sourceInput.sha256).toBe(fixture.source?.sha256);
        expect(sourceInput.kind).toBe('pdf');
        expect(sourceInput.segments).toHaveLength(3);
        expect(sourceInput.segments![0]?.page_number).toBe(1);
        expect(sourceInput.segments![0]?.method).toBe('pdf_native');
        expect(sourceInput.segments![0]?.status).toBe('ready');
      });
    });
  });
});
