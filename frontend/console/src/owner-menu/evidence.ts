// FE-06.2: the source text behind an extracted dish, for showing next to Screen 9's fields.
// Excerpts come only from the stored extraction segments the review session returned, cut at
// the candidate's evidence offsets; nothing is re-read, guessed or summarised.
import type {
  ExtractionReviewSessionResponse,
  ReviewCandidateItemResponse,
} from '@peekaplate/contracts';

export type EvidenceExcerpt = { page: number | null; text: string; segmentId: string };

export type PageProblem = { page: number | null; status: string; error: string | null };

export function evidenceExcerpts(
  session: ExtractionReviewSessionResponse,
  item: ReviewCandidateItemResponse,
): EvidenceExcerpt[] {
  const segments = new Map(session.extractionResult.segments.map((s) => [s.segment_id, s]));
  return item.candidate.evidence.flatMap((span) => {
    const segment = segments.get(span.segment_id);
    if (!segment || typeof segment.text !== 'string') return [];
    // Evidence offsets come from the Python producer and count Unicode code points, not
    // JavaScript UTF-16 units (the convention in contracts' review-candidates.ts). Slicing the
    // string directly cut an excerpt short after an emoji or other astral character.
    const text = Array.from(segment.text).slice(span.start, span.end).join('').trim();
    return text === ''
      ? []
      : [{ page: segment.page_number ?? null, text, segmentId: span.segment_id }];
  });
}

// Pages that were not read, so the owner knows the list of dishes may be missing some.
export function pageProblems(session: ExtractionReviewSessionResponse): PageProblem[] {
  return session.extractionResult.segments
    .filter((segment) => segment.status !== 'ready')
    .map((segment) => ({
      page: segment.page_number ?? null,
      status: segment.status,
      error: segment.error ?? null,
    }));
}
