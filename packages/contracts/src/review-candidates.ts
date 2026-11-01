import { z } from 'zod';

const text = z.string().refine((value) => value.trim().length > 0, 'Expected non-empty text');
const candidateFields = [
  'description',
  'category',
  'price_amount',
  'price_currency',
  'ingredients',
] as const;

export const ReviewCandidateSchema = z
  .strictObject({
    candidate_id: text,
    original: z.strictObject({
      name: text.max(160),
      description: text.max(4000).nullable(),
      category: text.nullable(),
      subcategory: text.nullable().optional(),
      category_page_number: z.number().int().positive().nullable().optional(),
      price_text: text.max(160).nullable().optional(),
      price_amount: z
        .string()
        .regex(/^(?:\d+(?:\.\d+)?|-0(?:\.0+)?)(?:[eE][+-]?\d+)?$/)
        .nullable(),
      price_currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable(),
      ingredients: z.array(text).nullable(),
      source_id: text,
      source_text: text,
      image_id: text.nullable(),
      review_warnings: z.array(text),
      status: z.literal('needs_review'),
    }),
    evidence: z
      .array(
        z.strictObject({
          segment_id: text,
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        }),
      )
      .min(1),
    missing_fields: z.array(z.enum(candidateFields)),
  })
  .superRefine((candidate, ctx) => {
    const expected = candidateFields.filter(
      (field) =>
        candidate.original[field] === null &&
        !(field === 'price_amount' && candidate.original.price_text != null),
    );
    if (JSON.stringify(candidate.missing_fields) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing_fields'],
        message:
          'missing_fields must match the original fields; printed price options are not a missing price',
      });
    }
  });

export const ReviewCandidateResultSchema = z
  .strictObject({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    extraction_id: text,
    pipeline_version: z.union([z.literal('2'), z.literal('3')]),
    status: z.enum(['complete', 'incomplete', 'failed']),
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }).nullable(),
    extraction_model: z.string().nullable(),
    source: z.strictObject({
      source_id: text,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      kind: z.enum(['pdf', 'image', 'website', 'text']),
      location: text,
      retrieved_at: z.iso.datetime({ offset: true }),
      size_bytes: z.number().int().positive().max(12_000_000),
    }),
    segments: z.array(
      z.strictObject({
        segment_id: text,
        page_number: z.number().int().positive().nullable(),
        method: z.enum(['text', 'html', 'pdf_native', 'ocr_space_engine3']),
        status: z.enum(['ready', 'skipped', 'failed']),
        text: z.string(),
        native_text: z.string().nullable(),
        error: z.string().nullable(),
        warnings: z.array(z.string()),
        metadata: z.record(z.string(), z.unknown()),
      }),
    ),
    candidates: z.array(ReviewCandidateSchema),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .superRefine((result, ctx) => {
    const segments = new Map(result.segments.map((segment) => [segment.segment_id, segment]));
    const issue = (path: (string | number)[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (
      !(
        (result.schema_version === 1 && result.pipeline_version === '2') ||
        (result.schema_version === 2 && result.pipeline_version === '3')
      )
    ) {
      issue(['pipeline_version'], 'Review schema and pipeline versions do not match');
    }
    if (
      result.schema_version === 1 &&
      result.candidates.some(
        (candidate) =>
          candidate.original.subcategory != null ||
          candidate.original.category_page_number != null ||
          candidate.original.price_text != null,
      )
    ) {
      issue(['candidates'], 'Category hierarchy and printed price fields require review schema 2');
    }
    if (segments.size !== result.segments.length) {
      issue(['segments'], 'Segment identifiers must be unique');
    }
    if (
      new Set(result.candidates.map((candidate) => candidate.candidate_id)).size !==
      result.candidates.length
    ) {
      issue(['candidates'], 'Candidate identifiers must be unique within an extraction');
    }
    if (result.source.source_id !== `sha256:${result.source.sha256}`) {
      issue(['source', 'source_id'], 'Source identifier must match its hash');
    }
    if (result.status === 'failed' && result.candidates.length > 0) {
      issue(['candidates'], 'A failed extraction cannot contain reviewable candidates');
    }
    const headingPages = new Set(
      result.segments
        .filter(
          (segment) =>
            segment.status === 'ready' && segment.error === null && segment.text.trim().length > 0,
        )
        .map((segment) => segment.page_number),
    );
    result.candidates.forEach((candidate, index) => {
      if (candidate.original.source_id !== result.source.source_id) {
        issue(
          ['candidates', index, 'original', 'source_id'],
          'Candidate source does not match the extraction source',
        );
      }
      if (
        candidate.original.category_page_number != null &&
        !headingPages.has(candidate.original.category_page_number)
      ) {
        issue(
          ['candidates', index, 'original', 'category_page_number'],
          'Category heading must reference a readable, error-free source page',
        );
      }
      const passages: string[] = [];
      for (const span of candidate.evidence) {
        const segment = segments.get(span.segment_id);
        if (!segment || segment.status !== 'ready' || segment.error !== null) {
          issue(
            ['candidates', index, 'evidence'],
            'Candidate evidence must reference a ready, error-free segment',
          );
          continue;
        }
        // Python offsets count Unicode code points, rather than JavaScript UTF-16 units.
        const characters = Array.from(segment.text);
        if (!(span.start < span.end && span.end <= characters.length)) {
          issue(
            ['candidates', index, 'evidence'],
            'Candidate evidence offsets are outside the source text',
          );
          continue;
        }
        passages.push(characters.slice(span.start, span.end).join(''));
      }
      if (passages.join('\n') !== candidate.original.source_text) {
        issue(
          ['candidates', index, 'evidence'],
          'Candidate evidence must reconstruct the original source text',
        );
      }
    });
  });

export type ReviewCandidate = z.infer<typeof ReviewCandidateSchema>;
export type ReviewCandidateResult = z.infer<typeof ReviewCandidateResultSchema>;
