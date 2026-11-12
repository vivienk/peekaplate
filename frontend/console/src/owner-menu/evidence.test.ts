import { describe, expect, it } from 'vitest';
import { evidenceExcerpts, pageProblems } from './evidence';
import { reviewSession } from './fixtures.test-helpers';

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
