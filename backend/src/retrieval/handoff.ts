import {
  type BoundedRetrievalResult,
  BoundedRetrievalResultSchema,
  type EvidencePassage,
  type SourceInput,
  SourceInputSchema,
  type SourceInputSegment,
  SourceInputSegmentSchema,
} from '@peekaplate/contracts';

/**
 * ============================================================================
 * UNICODE CODE-POINT <-> UTF-16 CODE-UNIT OFFSET CONVERSION
 * ============================================================================
 * Python len(str) and string slicing s[start:end] operate on Unicode code points
 * (scalar values), while JavaScript length and slice() operate on UTF-16 code units.
 * For BMP characters (ASCII, Latin), 1 code point = 1 code unit.
 * For astral / non-BMP characters (e.g. 🍜 U+1F35C), 1 code point = 2 code units.
 */

/**
 * Converts a UTF-16 string index (JS offset) to a Unicode code-point index (Python offset).
 */
export function utf16ToCodePointOffset(text: string, utf16Offset: number): number {
  if (!Number.isInteger(utf16Offset) || utf16Offset < 0) {
    throw new RangeError(`Invalid UTF-16 offset: ${utf16Offset}. Must be a non-negative integer.`);
  }
  if (utf16Offset > text.length) {
    throw new RangeError(`UTF-16 offset ${utf16Offset} exceeds text length (${text.length})`);
  }
  return Array.from(text.slice(0, utf16Offset)).length;
}

/**
 * Converts a Unicode code-point index (Python offset) to a UTF-16 string index (JS offset).
 */
export function codePointToUtf16Offset(text: string, codePointOffset: number): number {
  if (!Number.isInteger(codePointOffset) || codePointOffset < 0) {
    throw new RangeError(
      `Invalid code point offset: ${codePointOffset}. Must be a non-negative integer.`,
    );
  }
  let cp = 0;
  let i = 0;
  while (i < text.length && cp < codePointOffset) {
    const code = text.codePointAt(i);
    if (code === undefined) break;
    i += code > 0xffff ? 2 : 1;
    cp++;
  }
  if (cp < codePointOffset) {
    throw new RangeError(
      `Code point offset ${codePointOffset} exceeds text code-point length (${cp})`,
    );
  }
  return i;
}

/**
 * Converts a source span from JavaScript UTF-16 offsets to Python Unicode code-point offsets.
 */
export function convertSpanToCodePoints(
  segmentText: string,
  span: { segment_id: string; start: number; end: number },
): { segment_id: string; start: number; end: number } {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.start > segmentText.length ||
    span.end > segmentText.length
  ) {
    throw new Error(
      `Invalid UTF-16 span [${span.start}, ${span.end}] for segment text of length ${segmentText.length}`,
    );
  }
  return {
    segment_id: span.segment_id,
    start: utf16ToCodePointOffset(segmentText, span.start),
    end: utf16ToCodePointOffset(segmentText, span.end),
  };
}

/**
 * Converts a source span from Python Unicode code-point offsets to JavaScript UTF-16 offsets.
 */
export function convertSpanToUtf16(
  segmentText: string,
  span: { segment_id: string; start: number; end: number },
): { segment_id: string; start: number; end: number } {
  const totalCodePoints = Array.from(segmentText).length;
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.start > totalCodePoints ||
    span.end > totalCodePoints
  ) {
    throw new Error(
      `Invalid code-point span [${span.start}, ${span.end}] for segment text of length ${totalCodePoints} code points`,
    );
  }
  return {
    segment_id: span.segment_id,
    start: codePointToUtf16Offset(segmentText, span.start),
    end: codePointToUtf16Offset(segmentText, span.end),
  };
}

/**
 * Validates that slicing the stored segment text by the given span reconstructs
 * the exact expected passage text.
 *
 * Matching span lengths alone is insufficient: this verifies exact slice equality.
 */
export function validateSpanSourceSlice(
  segmentText: string,
  span: { segment_id: string; start: number; end: number },
  expectedPassageText: string,
  offsetUnit: 'utf16' | 'codepoint' = 'utf16',
): { valid: boolean; actualSlice: string; error?: string } {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start
  ) {
    return {
      valid: false,
      actualSlice: '',
      error: `Invalid span boundaries: start=${span.start}, end=${span.end}`,
    };
  }

  if (span.start === span.end && expectedPassageText.length > 0) {
    return {
      valid: false,
      actualSlice: '',
      error: `Empty span [${span.start}, ${span.end}] for non-empty expected text`,
    };
  }

  let utf16Start: number;
  let utf16End: number;

  if (offsetUnit === 'codepoint') {
    const totalCodePoints = Array.from(segmentText).length;
    if (span.start > totalCodePoints || span.end > totalCodePoints) {
      return {
        valid: false,
        actualSlice: '',
        error: `Span code-point offsets [${span.start}, ${span.end}] exceed segment code-point length (${totalCodePoints})`,
      };
    }
    utf16Start = codePointToUtf16Offset(segmentText, span.start);
    utf16End = codePointToUtf16Offset(segmentText, span.end);
  } else {
    if (span.start > segmentText.length || span.end > segmentText.length) {
      return {
        valid: false,
        actualSlice: '',
        error: `Span [${span.start}, ${span.end}] exceeds segment text length (${segmentText.length})`,
      };
    }
    utf16Start = span.start;
    utf16End = span.end;
  }

  const actualSlice = segmentText.slice(utf16Start, utf16End);
  if (actualSlice !== expectedPassageText) {
    return {
      valid: false,
      actualSlice,
      error: `Reconstructed slice does not match expected passage text (expected: "${expectedPassageText}", got: "${actualSlice}")`,
    };
  }

  return { valid: true, actualSlice };
}

/**
 * ============================================================================
 * VIS-02 COMPATIBLE SCHEMA TYPES
 * ============================================================================
 * Aligned with Mohammad's Python schemas in processing/src/peekaplate_processing/schemas.py
 */

export type Vis02SourceSpan = {
  segment_id: string;
  start: number; // Unicode code points in wire contract, or UTF-16 in local JS
  end: number;
};

export type Vis02DraftEvidence = {
  draft_id: string;
  draft_index: number;
  spans: Vis02SourceSpan[];
};

export type Vis02DishDraft = {
  draft_id?: string | null;
  candidate_id?: string | null;
  draft_index?: number | null;
  name: string;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;
  category_page_number?: number | null;
  price_text?: string | null;
  price_amount?: string | null; // Decimal string e.g. "16.50", never heuristic
  price_currency?: string | null; // ISO 3-letter code e.g. "USD", or null
  ingredients?: string[] | null;
  source_id: string;
  source_text: string;
  image_id?: string | null;
  review_warnings: string[];
  status: 'needs_review';
};

export type Vis02SourceRecord = {
  source_id: string;
  sha256: string;
  kind: 'pdf' | 'image' | 'website' | 'text' | 'url' | 'html';
  location: string;
  retrieved_at: string;
  size_bytes: number;
  snapshot_base64?: string | undefined;
};

export type Vis02SourceSegment = {
  segment_id: string;
  page_number?: number | null;
  method: 'text' | 'html' | 'pdf_native' | 'ocr' | 'ocr_space_engine3';
  status: 'ready' | 'skipped' | 'failed';
  text: string;
  native_text?: string | null;
  error?: string | null;
  warnings: string[];
  metadata?: Record<string, unknown>;
};

export type Vis02ExtractionHandoff = {
  schema_version: 1 | 2;
  pipeline_version: '2' | '3';
  status: 'complete' | 'incomplete' | 'failed';
  source?: Vis02SourceRecord | null | undefined;
  segments: Vis02SourceSegment[];
  drafts: Vis02DishDraft[];
  evidence: Vis02DraftEvidence[];
  warnings: string[];
  errors: string[];
};

/**
 * ============================================================================
 * S3-VIS-01 INGESTION HANDOFF ADAPTER
 * ============================================================================
 */

export type IngestionSourceSpan = {
  segment_id: string;
  start: number;
  end: number;
};

export type IngestionDraftEvidence = {
  draft_id: string;
  draft_index: number;
  spans: IngestionSourceSpan[];
};

export type StructuredDishDraft = {
  name: string;
  description?: string | undefined;
  price_amount?: number | undefined;
  price_currency?: string | undefined;
  source_id: string;
  source_text: string;
  evidence: IngestionDraftEvidence;
  status: 'needs_review';
  review_warnings: string[];
};

export type S3Vis01HandoffResult = {
  readyForIngestion: boolean;
  retrievalStatus: BoundedRetrievalResult['status'];
  candidates: StructuredDishDraft[];
  decoupledEvidence: Vis02DraftEvidence[];
  unresolvedWarnings: string[];
};

export type TransformToVis02Options = {
  offsetUnit?: 'utf16' | 'codepoint';
  sourceSegments?: Record<string, string> | Map<string, string>;
  strictSliceValidation?: boolean;
};

/**
 * Transforms a BoundedRetrievalResult into Mohammad's decoupled VIS-02 format
 * (separate drafts[] and evidence[] joined by draft_id and draft_index).
 *
 * Offset Semantics:
 * - The retrieval ranker calculates passage offsets in JavaScript UTF-16 code units.
 * - VIS-02 requires Python-style Unicode code-point offsets.
 * - When offsetUnit is 'codepoint' (default):
 *   - If sourceSegments is provided:
 *     - If the segment text is found, offsets are converted from UTF-16 to Unicode code points.
 *     - If strictSliceValidation is enabled (default: true), exact slice reconstruction is verified.
 *     - If the segment text is missing from sourceSegments, fails explicitly with a validation error.
 *   - If sourceSegments is absent:
 *     - If passage.start_offset === 0, passage.text is the exact segment prefix from offset 0,
 *       allowing safe conversion: spanStart = 0, spanEnd = code point count of passage.text.
 *     - If passage.start_offset > 0, characters preceding start_offset are unknown (non-BMP characters
 *       would shift code-point offsets). Conversion cannot be safely established, so it fails explicitly.
 * - When offsetUnit is 'utf16':
 *   - Offsets pass through as UTF-16 code units.
 * - Removal of heuristic price regex: price_amount is strictly null until extracted by downstream LLM.
 * - Strict 'needs_review' review boundary.
 */
/**
 * Helper to convert and validate a passage's character offsets for downstream handoffs.
 * Ensures consistent Unicode code-point and UTF-16 offset handling across both VIS-01 and VIS-02 paths.
 */
export function convertPassageSpan(
  passage: EvidencePassage,
  options: TransformToVis02Options = {},
): { spanStart: number; spanEnd: number } {
  const offsetUnit = options.offsetUnit ?? 'codepoint';
  const sourceSegments = options.sourceSegments;
  const strictSliceValidation = options.strictSliceValidation !== false;

  let spanStart: number;
  let spanEnd: number;

  if (offsetUnit === 'codepoint') {
    if (sourceSegments) {
      const segText =
        sourceSegments instanceof Map
          ? sourceSegments.get(passage.source.segment_id)
          : sourceSegments[passage.source.segment_id];

      if (segText === undefined) {
        throw new Error(
          `Missing source segment text for segment "${passage.source.segment_id}"; cannot convert offsets to Unicode code points.`,
        );
      }

      if (
        passage.start_offset < 0 ||
        passage.end_offset > segText.length ||
        passage.start_offset > passage.end_offset
      ) {
        throw new Error(
          `Passage offsets [${passage.start_offset}, ${passage.end_offset}] out of bounds for segment "${passage.source.segment_id}" (length ${segText.length})`,
        );
      }

      const expectedSlice = segText.slice(passage.start_offset, passage.end_offset);
      if (expectedSlice !== passage.text) {
        throw new Error(
          `Slice validation failed for passage ${passage.passage_id}: segment text at [${passage.start_offset}, ${passage.end_offset}] does not match passage text`,
        );
      }

      spanStart = utf16ToCodePointOffset(segText, passage.start_offset);
      spanEnd = utf16ToCodePointOffset(segText, passage.end_offset);

      if (strictSliceValidation) {
        const check = validateSpanSourceSlice(
          segText,
          { segment_id: passage.source.segment_id, start: spanStart, end: spanEnd },
          passage.text,
          'codepoint',
        );
        if (!check.valid) {
          throw new Error(
            `Slice validation failed for passage ${passage.passage_id}: ${check.error}`,
          );
        }
      }
    } else {
      // sourceSegments is absent.
      // If start_offset is 0, passage.text is the exact segment prefix from offset 0 to end_offset.
      if (passage.start_offset === 0) {
        spanStart = 0;
        spanEnd = utf16ToCodePointOffset(passage.text, passage.text.length);

        if (strictSliceValidation) {
          const check = validateSpanSourceSlice(
            passage.text,
            { segment_id: passage.source.segment_id, start: spanStart, end: spanEnd },
            passage.text,
            'codepoint',
          );
          if (!check.valid) {
            throw new Error(
              `Slice validation failed for passage ${passage.passage_id}: ${check.error}`,
            );
          }
        }
      } else {
        // When start_offset > 0, characters preceding start_offset in the original segment are unknown.
        // Any non-BMP characters in that prefix would shift code-point offsets.
        // Conversion cannot be safely established without the original segment text.
        throw new Error(
          `Cannot convert segment offsets to Unicode code points without source segment text when passage start_offset (${passage.start_offset}) > 0 for passage "${passage.passage_id}". Provide sourceSegments to enable safe offset conversion.`,
        );
      }
    }
  } else {
    // offsetUnit === 'utf16'
    spanStart = passage.start_offset;
    spanEnd = passage.end_offset;

    if (sourceSegments) {
      const segText =
        sourceSegments instanceof Map
          ? sourceSegments.get(passage.source.segment_id)
          : sourceSegments[passage.source.segment_id];

      if (segText !== undefined) {
        if (strictSliceValidation) {
          const check = validateSpanSourceSlice(
            segText,
            { segment_id: passage.source.segment_id, start: spanStart, end: spanEnd },
            passage.text,
            'utf16',
          );
          if (!check.valid) {
            throw new Error(
              `Slice validation failed for passage ${passage.passage_id}: ${check.error}`,
            );
          }
        }
      } else if (strictSliceValidation) {
        throw new Error(
          `Missing source segment text for segment "${passage.source.segment_id}" in sourceSegments`,
        );
      }
    }
  }

  return { spanStart, spanEnd };
}

export function transformRetrievalToVis02Evidence(
  rawResult: unknown,
  options: TransformToVis02Options = {},
): {
  drafts: Vis02DishDraft[];
  evidence: Vis02DraftEvidence[];
  warnings: string[];
} {
  const result = BoundedRetrievalResultSchema.parse(rawResult);
  const warnings: string[] = [...result.warnings];

  const drafts: Vis02DishDraft[] = [];
  const evidence: Vis02DraftEvidence[] = [];

  for (let i = 0; i < result.passages.length; i++) {
    const passage = result.passages[i];
    if (!passage) continue;

    const draftId = `draft_${passage.passage_id}`;
    const { spanStart, spanEnd } = convertPassageSpan(passage, options);

    const span: Vis02SourceSpan = {
      segment_id: passage.source.segment_id,
      start: spanStart,
      end: spanEnd,
    };

    evidence.push({
      draft_id: draftId,
      draft_index: i,
      spans: [span],
    });

    drafts.push({
      name: `Candidate Evidence #${passage.rank}`,
      description: passage.text,
      category: null,
      price_amount: null, // Strictly null: price grounding requires VIS-02 / S3-VIS-01 LLM extraction
      price_currency: null,
      ingredients: null,
      source_id: passage.source.source_id,
      source_text: passage.text,
      image_id: null,
      review_warnings: [
        `Extracted from rank #${passage.rank} evidence passage (${passage.source.segment_id})`,
        ...(passage.score ? [`Retrieval score: ${passage.score}`] : []),
        'Candidate contains raw passage evidence; price and entity grounding require downstream LLM extraction.',
      ],
      status: 'needs_review',
    });
  }

  return { drafts, evidence, warnings };
}

/**
 * Transforms a BoundedRetrievalResult into S3-VIS-01 structured candidate input.
 *
 * Preserves exact segment provenance and character offsets, maps passages
 * to SourceSpan objects, and enforces the review boundary by ensuring all
 * candidate drafts are marked 'needs_review' and never automatically published.
 *
 * In compliance with Mohammad's VIS-02 audit, this function applies Unicode code-point
 * offset conversion and source-slice validation consistently with VIS-02.
 */
export function prepareS3Vis01Handoff(
  rawResult: unknown,
  metadata: { dishName: string; currency?: string },
  options: TransformToVis02Options = {},
): S3Vis01HandoffResult {
  const result = BoundedRetrievalResultSchema.parse(rawResult);

  if (result.status !== 'success' && result.status !== 'ambiguous') {
    return {
      readyForIngestion: false,
      retrievalStatus: result.status,
      candidates: [],
      decoupledEvidence: [],
      unresolvedWarnings: [
        ...result.warnings,
        `Ingestion skipped: retrieval status was '${result.status}'`,
      ],
    };
  }

  const candidates: StructuredDishDraft[] = [];
  const decoupledEvidence: Vis02DraftEvidence[] = [];
  const warnings: string[] = [...result.warnings];

  const isoCurrency =
    metadata.currency && /^[A-Z]{3}$/.test(metadata.currency) ? metadata.currency : undefined;

  for (let i = 0; i < result.passages.length; i++) {
    const passage = result.passages[i];
    if (!passage) continue;

    const draftId = `draft_${passage.passage_id}`;
    const { spanStart, spanEnd } = convertPassageSpan(passage, options);

    const spans: IngestionSourceSpan[] = [
      {
        segment_id: passage.source.segment_id,
        start: spanStart,
        end: spanEnd,
      },
    ];

    decoupledEvidence.push({
      draft_id: draftId,
      draft_index: i,
      spans,
    });

    candidates.push({
      name: metadata.dishName,
      description: passage.text,
      ...(isoCurrency ? { price_currency: isoCurrency } : {}),
      source_id: passage.source.source_id,
      source_text: passage.text,
      evidence: {
        draft_id: draftId,
        draft_index: i,
        spans,
      },
      status: 'needs_review', // Strict staff review boundary: never published automatically
      review_warnings: [
        `Extracted from rank #${passage.rank} evidence passage (${passage.source.segment_id})`,
        ...(passage.score ? [`Retrieval score: ${passage.score}`] : []),
        'Evidence passage attached; dish price grounding requires downstream LLM verification.',
      ],
    });
  }

  if (result.status === 'ambiguous') {
    warnings.push(
      'Retrieval produced ambiguous candidates; human review must confirm correct dish formulation.',
    );
  }

  return {
    readyForIngestion: candidates.length > 0,
    retrievalStatus: result.status,
    candidates,
    decoupledEvidence,
    unresolvedWarnings: warnings,
  };
}

/**
 * ============================================================================
 * EXPLICIT VIS-02 -> RETRIEVAL SOURCE INPUT ADAPTER
 * ============================================================================
 * Maps upstream Python extraction output into the strict TypeScript SourceInputSchema.
 * Explicitly normalizes nullable fields (null -> undefined) and preserves
 * provenance, metadata, warnings, and errors without arbitrary passthrough.
 */
export function mapVis02SegmentToSourceSegment(seg: Vis02SourceSegment): SourceInputSegment {
  const metadata: Record<string, unknown> = {
    ...(seg.metadata ?? {}),
  };
  if (seg.native_text !== null && seg.native_text !== undefined) {
    metadata.native_text = seg.native_text;
  }

  const normalized = {
    segment_id: seg.segment_id,
    text: seg.text,
    ...(seg.page_number !== null && seg.page_number !== undefined && seg.page_number > 0
      ? { page_number: seg.page_number }
      : {}),
    ...(seg.method ? { method: seg.method } : {}),
    ...(seg.status ? { status: seg.status } : {}),
    ...(typeof seg.error === 'string' && seg.error.length > 0 ? { error: seg.error } : {}),
    ...(seg.warnings && seg.warnings.length > 0 ? { warnings: [...seg.warnings] } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  return SourceInputSegmentSchema.parse(normalized);
}

export function mapVis02HandoffToSourceInput(handoff: Vis02ExtractionHandoff): SourceInput {
  if (handoff.schema_version !== 1 && handoff.schema_version !== 2) {
    throw new Error(
      `Unsupported schema_version: ${(handoff as { schema_version: unknown }).schema_version}. Expected 1 or 2.`,
    );
  }
  if (handoff.pipeline_version !== '2' && handoff.pipeline_version !== '3') {
    throw new Error(
      `Unsupported pipeline_version: ${(handoff as { pipeline_version: unknown }).pipeline_version}. Expected '2' or '3'.`,
    );
  }

  const source = handoff.source;
  const sourceId = source?.source_id ?? 'vis02_source';

  const segments = (handoff.segments || []).map(mapVis02SegmentToSourceSegment);

  const normalized = {
    source_id: sourceId,
    ...(source?.sha256 ? { sha256: source.sha256 } : {}),
    ...(source?.kind ? { kind: source.kind } : {}),
    ...(source?.location ? { location: source.location } : {}),
    ...(source?.retrieved_at ? { retrieved_at: source.retrieved_at } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };

  return SourceInputSchema.parse(normalized);
}
