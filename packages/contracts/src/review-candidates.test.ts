import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReviewCandidateResultSchema } from './index';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../processing/tests/fixtures/review-candidates/representative-candidates.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const spans = JSON.parse(
  readFileSync(
    new URL('../../../processing/tests/fixtures/source-spans.json', import.meta.url),
    'utf8',
  ),
);
const fixtureV2 = JSON.parse(
  readFileSync(
    new URL(
      '../../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

describe('RES-01.1 review candidate contract', () => {
  it('uses the same Unicode field limits as Python', () => {
    const limits = JSON.parse(
      readFileSync(
        new URL(
          '../../../processing/tests/fixtures/review-candidates/field-limits.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    for (const { field, limit, character } of limits) {
      const input = structuredClone(fixtureV2);
      const candidate = input.candidates[0];
      candidate.original[field] = character.repeat(limit);
      candidate.missing_fields = candidate.missing_fields.filter(
        (value: string) => value !== field,
      );
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(true);
      candidate.original[field] += character;
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
  });

  it('preserves v2 hierarchy and price options from the Python export', () => {
    const result = ReviewCandidateResultSchema.parse(fixtureV2);
    expect(result).toEqual(fixtureV2);
    const [soup, coffee, bread] = result.candidates;
    expect(soup?.original.subcategory).toBe('SOUPS');
    expect(soup?.original.category_page_number).toBe(1);
    expect(soup?.original.price_text).toBe('8.50 / 12.50 CAD');
    expect(soup?.original.price_amount).toBeNull();
    expect(soup?.missing_fields).not.toContain('price_amount');
    expect(coffee?.missing_fields).toContain('price_amount');
    expect(coffee?.original.subcategory).toBeUndefined();
    expect(bread?.original.price_amount).toBe('0.00');
  });

  it('preserves Python-validated candidate box links in existing segment metadata', () => {
    const input = JSON.parse(
      readFileSync(
        new URL(
          '../../../processing/tests/fixtures/review-candidates/box-evidence-candidates.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const result = ReviewCandidateResultSchema.parse(input);
    expect(result).toEqual(input);
    expect(result.candidates[0]?.evidence).toEqual(fixture.candidates[0].evidence);
    expect(result.candidates[0]?.original.status).toBe('needs_review');
    expect(result.segments[0]?.metadata.candidate_box_evidence).toEqual({
      [input.candidates[0].candidate_id]: [
        {
          page_number: 1,
          saved_region_index: 0,
          text: '8.50',
          box: { left: 10.25, top: 20, width: 30.5, height: 12 },
        },
      ],
    });
    // The TypeScript metadata envelope preserves producer-validated facts; it
    // does not independently prove the OCR join or field/row correctness.
  });

  it('rejects missing or unusable category heading pages', () => {
    for (const page of [999, 2, 3]) {
      const input = structuredClone(fixtureV2);
      input.candidates[0].original.category_page_number = page;
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
    const input = structuredClone(fixtureV2);
    input.segments[1].status = 'ready';
    input.segments[1].error = 'Unresolved heading-page error';
    input.candidates[0].original.category_page_number = 2;
    expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    input.segments[1].error = null;
    expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
  });

  it('rejects mixed versions and new fields under the legacy version', () => {
    for (const [schema, pipeline] of [
      [1, '3'],
      [2, '2'],
    ]) {
      const input = { ...fixture, schema_version: schema, pipeline_version: pipeline };
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
    for (const [field, value] of [
      ['subcategory', 'SOUPS'],
      ['category_page_number', 1],
      ['price_text', '8.50'],
    ] as const) {
      const input = structuredClone(fixture);
      input.candidates[0].original[field] = value;
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
    const input = structuredClone(fixtureV2);
    input.candidates[0].missing_fields.push('price_amount');
    expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
  });

  it('accepts precision-preserving decimal strings and signed zero', () => {
    for (const amount of ['8.5000', '1E+8', '0E-8', '-0.00']) {
      const input = structuredClone(fixture);
      input.candidates[0].original.price_amount = amount;
      expect(ReviewCandidateResultSchema.parse(input).candidates[0]?.original.price_amount).toBe(
        amount,
      );
    }
  });

  it('accepts the shared Python export with priced, missing and zero-price candidates', () => {
    const result = ReviewCandidateResultSchema.parse(fixture);
    expect(result).toEqual(fixture);
    expect(result.candidates.map((candidate) => candidate.original.price_amount)).toEqual([
      '8.50',
      null,
      '0.00',
    ]);
    expect(result.candidates[1]?.missing_fields).toContain('price_amount');
    expect(result.segments.map((segment) => segment.status)).toEqual([
      'ready',
      'failed',
      'skipped',
    ]);
    expect(result.status).toBe('incomplete');
  });

  it('preserves code-point evidence with astral Unicode and nonzero offsets', () => {
    for (const span of spans) {
      const input = structuredClone(fixture);
      input.segments[0].text = span.text;
      for (const candidate of input.candidates) {
        candidate.original.source_text = span.evidence_text;
        Object.assign(candidate.evidence[0], span.code_point_span);
      }
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(true);
      for (const candidate of input.candidates) {
        Object.assign(candidate.evidence[0], span.utf16_span);
      }
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
  });

  it('keeps IDs, original values and metadata when the candidate order changes', () => {
    const input = structuredClone(fixture);
    input.candidates.reverse();
    input.segments[0].metadata.ocr_regions = [
      { text: 'Coffee', left: 20, top: 30, width: 50, height: 15 },
    ];
    const result = ReviewCandidateResultSchema.parse(input);
    expect(result.extraction_id).toBe(fixture.extraction_id);
    expect(result.candidates).toEqual([...fixture.candidates].reverse());
    expect(result.segments[0]?.metadata).toEqual(input.segments[0].metadata);
  });

  it('rejects broken links, offsets, amounts, invented confidence and publication', () => {
    const mutations = [
      (value: typeof fixture) => {
        value.schema_version = 2;
      },
      (value: typeof fixture) => {
        value.source.location = '   ';
      },
      (value: typeof fixture) => {
        value.candidates[0].candidate_id = '   ';
      },
      (value: typeof fixture) => {
        value.started_at = '2026-10-25T12:00:00';
      },
      (value: typeof fixture) => {
        value.venue_id = 'browser-authority';
      },
      (value: typeof fixture) => {
        value.source.source_id = 'wrong-source';
      },
      (value: typeof fixture) => {
        value.candidates[0].original.source_id = 'wrong-source';
      },
      (value: typeof fixture) => {
        value.candidates[0].original.price_amount = '-1.00';
      },
      (value: typeof fixture) => {
        value.candidates[0].original.price_amount = 8.5;
      },
      (value: typeof fixture) => {
        value.candidates[0].original.status = 'approved';
      },
      (value: typeof fixture) => {
        value.candidates[0].original.source_text = 'invented';
      },
      (value: typeof fixture) => {
        value.candidates[0].confidence = 0.95;
      },
      (value: typeof fixture) => {
        value.candidates[0].published = true;
      },
      (value: typeof fixture) => {
        value.candidates[1].missing_fields = [];
      },
      (value: typeof fixture) => {
        value.candidates[0].evidence = [];
      },
      (value: typeof fixture) => {
        value.candidates[0].evidence[0].segment_id = 'missing';
      },
      (value: typeof fixture) => {
        value.candidates[0].evidence[0].start = -1;
      },
      (value: typeof fixture) => {
        value.candidates[0].evidence[0].end = 10000;
      },
      (value: typeof fixture) => {
        value.candidates[0].evidence[0].start = 10000;
      },
      (value: typeof fixture) => {
        value.candidates[1].candidate_id = value.candidates[0].candidate_id;
      },
      (value: typeof fixture) => {
        value.segments.push(value.segments[0]);
      },
      (value: typeof fixture) => {
        value.segments[0].status = 'failed';
      },
      (value: typeof fixture) => {
        value.segments[0].status = 'skipped';
      },
      (value: typeof fixture) => {
        value.segments[0].error = 'error despite ready';
      },
      (value: typeof fixture) => {
        value.status = 'failed';
      },
    ];
    for (const mutate of mutations) {
      const input = structuredClone(fixture);
      mutate(input);
      expect(ReviewCandidateResultSchema.safeParse(input).success).toBe(false);
    }
  });

  it('retains a failed extraction as an explicit empty result', () => {
    const input = { ...fixture, status: 'failed', candidates: [] };
    expect(ReviewCandidateResultSchema.parse(input).errors).toEqual(fixture.errors);
  });
});
