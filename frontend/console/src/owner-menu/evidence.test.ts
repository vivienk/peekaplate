import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidenceExcerpts, pageProblems } from './evidence';
import { reviewSession } from './fixtures.test-helpers';

// The vectors the Python producer and the contracts share: offsets count Unicode code points.
type SpanVector = {
  segment_id: string;
  text: string;
  evidence_text: string;
  code_point_span: { start: number; end: number };
  utf16_span: { start: number; end: number };
};
const SPAN_VECTORS = JSON.parse(
  readFileSync(
    new URL('../../../../processing/tests/fixtures/source-spans.json', import.meta.url),
    'utf8',
  ),
) as SpanVector[];

// The synthetic review session with its first page and first candidate pointed at one vector.
function sessionForVector(vector: SpanVector) {
  const session = reviewSession();
  const item = session.items[0];
  const segment = session.extractionResult.segments[0];
  if (!item || !segment) throw new Error('fixture has no candidates');
  session.extractionResult.segments[0] = {
    ...segment,
    segment_id: vector.segment_id,
    text: vector.text,
  };
  const pointed = {
    ...item,
    candidate: {
      ...item.candidate,
      evidence: [{ segment_id: vector.segment_id, ...vector.code_point_span }],
    },
  };
  return { session, item: pointed };
}

describe('evidenceExcerpts', () => {
  it('cuts the stored page text at the candidate evidence offsets', () => {
    const session = reviewSession();
    const item = session.items[0];
    if (!item) throw new Error('fixture has no candidates');
    const excerpts = evidenceExcerpts(session, item);
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts[0]).toMatchObject({ page: 1 });
    expect(excerpts[0]?.text).toContain('Garden Soup - vegetables - 8.50 / 12.50 CAD');
  });

  // Mohammad's PR156 review: String.slice counts UTF-16 units, so an emoji before the span cut the
  // price short ("Soup 🍜 $8.5", "Soup 🍜 $8"). Both shared vectors must come back exactly.
  it.each(SPAN_VECTORS.map((vector) => [vector.segment_id, vector] as const))(
    'cuts %s at Unicode code points, not UTF-16 units',
    (_id, vector) => {
      // The vector really is one where the two conventions differ.
      expect(vector.utf16_span).not.toEqual(vector.code_point_span);
      const { session, item } = sessionForVector(vector);
      expect(evidenceExcerpts(session, item).map((excerpt) => excerpt.text)).toEqual([
        vector.evidence_text,
      ]);
    },
  );

  it('never rewrites the stored source text or its offsets', () => {
    const vector = SPAN_VECTORS[1];
    if (!vector) throw new Error('shared vectors are missing');
    const { session, item } = sessionForVector(vector);
    const before = JSON.stringify({ session, item });
    evidenceExcerpts(session, item);
    expect(JSON.stringify({ session, item })).toBe(before);
  });

  it('shows nothing rather than guessing when the segment is missing', () => {
    const session = reviewSession();
    const item = session.items[0];
    if (!item) throw new Error('fixture has no candidates');
    const orphan = {
      ...item,
      candidate: {
        ...item.candidate,
        evidence: [{ segment_id: 'missing#page-9', start: 0, end: 5 }],
      },
    };
    expect(evidenceExcerpts(session, orphan)).toEqual([]);
  });
});

describe('pageProblems', () => {
  it('lists pages that were not read', () => {
    const problems = pageProblems(reviewSession());
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.status !== 'ready')).toBe(true);
  });
});
