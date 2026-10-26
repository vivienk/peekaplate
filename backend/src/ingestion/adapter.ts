import {
  type ExtractionDishDraft,
  type ExtractionDraftEvidence,
  type ExtractionSourceRecord,
  type ExtractionSourceSegment,
  type ExtractionSourceSpan,
  type MenuExtractionResult,
  MenuExtractionResultSchema,
  type StructuredDishDraft,
  StructuredDishDraftSchema,
} from '@peekaplate/contracts';
import {
  codePointToUtf16Offset,
  utf16ToCodePointOffset,
  validateSpanSourceSlice,
} from '../retrieval/handoff.js';

export type InvalidDraftRecord = {
  draftIndex: number;
  draftId?: string;
  name: string;
  errors: string[];
};

export type IngestionAdaptationSuccess = {
  success: true;
  status: 'complete' | 'incomplete' | 'failed';
  sourceRecord: ExtractionSourceRecord | null;
  drafts: StructuredDishDraft[];
  invalidDrafts: InvalidDraftRecord[];
  segments: ExtractionSourceSegment[];
  warnings: string[];
  errors: string[];
  hasReviewableDrafts: boolean;
};

export type IngestionAdaptationFailure = {
  success: false;
  errors: string[];
};

export type IngestionAdaptationResult = IngestionAdaptationSuccess | IngestionAdaptationFailure;

export type IngestionAdapterOptions = {
  strictSliceValidation?: boolean;
};

/**
 * Normalizes price values into exact decimal strings (e.g. "8.50", "1200.00", "0.00")
 * without any floating-point arithmetic or drift.
 */
export function normalizePriceAmount(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const str = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid price amount format: "${raw}"`);
  }
  return str;
}

/**
 * Validates a Python extraction result and normalizes it into a persistence-ready
 * internal representation while preserving exact provenance, code-point and UTF-16
 * offsets, decimal price precision, review warnings, and strict 'needs_review' status.
 */
export function adaptPythonExtractionResult(
  rawInput: unknown,
  options: IngestionAdapterOptions = {},
): IngestionAdaptationResult {
  const strictSlice = options.strictSliceValidation !== false;

  // 1. Validate complete top-level schema
  const parsed = MenuExtractionResultSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`,
      ),
    };
  }

  const extraction: MenuExtractionResult = parsed.data;
  const segmentsMap = new Map<string, ExtractionSourceSegment>();
  for (const seg of extraction.segments) {
    segmentsMap.set(seg.segment_id, seg);
  }

  // If status is failed and there are no drafts, return valid failed result
  if (extraction.status === 'failed' && extraction.drafts.length === 0) {
    return {
      success: true,
      status: 'failed',
      sourceRecord: extraction.source ?? null,
      drafts: [],
      invalidDrafts: [],
      segments: extraction.segments,
      warnings: [...extraction.warnings],
      errors: [
        ...extraction.errors,
        ...(extraction.errors.length === 0
          ? ['Extraction failed: no reviewable dishes extracted']
          : []),
      ],
      hasReviewableDrafts: false,
    };
  }

  const validDrafts: StructuredDishDraft[] = [];
  const invalidDrafts: InvalidDraftRecord[] = [];
  const accumulatedErrors: string[] = [...extraction.errors];
  const accumulatedWarnings: string[] = [...extraction.warnings];

  // 2. Validate and adapt each draft
  for (let i = 0; i < extraction.drafts.length; i++) {
    const draft = extraction.drafts[i];
    if (!draft) continue;

    const draftErrors: string[] = [];

    // Locate matching evidence
    const evidence = extraction.evidence.find(
      (e) => e.draft_index === i || (e.draft_id && e.draft_id.includes(draft.name)),
    );

    if (!evidence || evidence.spans.length === 0) {
      invalidDrafts.push({
        draftIndex: i,
        name: draft.name,
        errors: [`Missing evidence spans for draft at index ${i} ("${draft.name}")`],
      });
      continue;
    }

    const codePointSpans: ExtractionSourceSpan[] = [];
    const utf16Spans: ExtractionSourceSpan[] = [];

    for (const span of evidence.spans) {
      const seg = segmentsMap.get(span.segment_id);
      if (!seg) {
        draftErrors.push(`Source segment "${span.segment_id}" not found in extraction segments`);
        continue;
      }

      const segText = seg.text;
      const totalCodePoints = Array.from(segText).length;

      if (span.start < 0 || span.end > totalCodePoints || span.start >= span.end) {
        draftErrors.push(
          `Span offsets [${span.start}, ${span.end}] out of bounds for segment "${span.segment_id}" (total code points: ${totalCodePoints})`,
        );
        continue;
      }

      // Verify exact slice equality in Unicode code points
      const actualCodePointSlice = Array.from(segText).slice(span.start, span.end).join('');

      if (strictSlice && actualCodePointSlice !== draft.source_text) {
        draftErrors.push(
          `Span slice mismatch: segment slice "${actualCodePointSlice}" does not match draft source_text "${draft.source_text}"`,
        );
        continue;
      }

      // Convert to UTF-16 code units
      let utf16Start: number;
      let utf16End: number;
      try {
        utf16Start = codePointToUtf16Offset(segText, span.start);
        utf16End = codePointToUtf16Offset(segText, span.end);
      } catch (err) {
        draftErrors.push(
          `Failed converting code point offsets [${span.start}, ${span.end}] to UTF-16: ${(err as Error).message}`,
        );
        continue;
      }

      if (strictSlice) {
        const actualUtf16Slice = segText.slice(utf16Start, utf16End);
        if (actualUtf16Slice !== draft.source_text) {
          draftErrors.push(
            `UTF-16 slice mismatch: segment slice "${actualUtf16Slice}" does not match draft source_text "${draft.source_text}"`,
          );
          continue;
        }
      }

      codePointSpans.push({
        segment_id: span.segment_id,
        start: span.start,
        end: span.end,
      });

      utf16Spans.push({
        segment_id: span.segment_id,
        start: utf16Start,
        end: utf16End,
      });
    }

    if (draftErrors.length > 0 || codePointSpans.length === 0) {
      invalidDrafts.push({
        draftIndex: i,
        draftId: evidence.draft_id,
        name: draft.name,
        errors: draftErrors.length > 0 ? draftErrors : ['No valid spans found'],
      });
      continue;
    }

    // Price precision handling
    let normalizedPrice: string | null = null;
    if (draft.price_amount !== null && draft.price_amount !== undefined) {
      try {
        normalizedPrice = normalizePriceAmount(draft.price_amount);
      } catch (err) {
        invalidDrafts.push({
          draftIndex: i,
          draftId: evidence.draft_id,
          name: draft.name,
          errors: [(err as Error).message],
        });
        continue;
      }
    }

    const structuredDraft: StructuredDishDraft = {
      draft_id: evidence.draft_id,
      draft_index: i,
      name: draft.name,
      description: draft.description ?? null,
      category: draft.category ?? null,
      price_amount: normalizedPrice,
      price_currency: draft.price_currency ?? null,
      ingredients: draft.ingredients ?? null,
      source_id: draft.source_id,
      source_text: draft.source_text,
      image_id: draft.image_id ?? null,
      code_point_spans: codePointSpans,
      utf16_spans: utf16Spans,
      review_warnings: [...draft.review_warnings],
      status: 'needs_review',
    };

    // Validate structured draft schema
    const draftValidation = StructuredDishDraftSchema.safeParse(structuredDraft);
    if (!draftValidation.success) {
      invalidDrafts.push({
        draftIndex: i,
        draftId: evidence.draft_id,
        name: draft.name,
        errors: draftValidation.error.issues.map((iss) => iss.message),
      });
      continue;
    }

    validDrafts.push(draftValidation.data);
  }

  // Determine overall status
  let finalStatus: 'complete' | 'incomplete' | 'failed';
  if (validDrafts.length > 0 && invalidDrafts.length === 0 && extraction.status === 'complete') {
    finalStatus = 'complete';
  } else if (validDrafts.length > 0) {
    finalStatus = 'incomplete';
  } else {
    finalStatus = 'failed';
  }

  if (invalidDrafts.length > 0) {
    accumulatedErrors.push(
      `${invalidDrafts.length} draft(s) failed validation and were excluded from reviewable drafts`,
    );
  }

  return {
    success: true,
    status: finalStatus,
    sourceRecord: extraction.source ?? null,
    drafts: validDrafts,
    invalidDrafts,
    segments: extraction.segments,
    warnings: accumulatedWarnings,
    errors: accumulatedErrors,
    hasReviewableDrafts: validDrafts.length > 0,
  };
}
