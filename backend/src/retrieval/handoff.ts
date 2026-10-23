import {
  type BoundedRetrievalResult,
  BoundedRetrievalResultSchema,
  type EvidencePassage,
} from '@peekaplate/contracts';

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
  unresolvedWarnings: string[];
};

/**
 * Transforms a BoundedRetrievalResult into S3-VIS-01 structured candidate input.
 *
 * Preserves exact segment provenance and character offsets, maps passages
 * to SourceSpan objects, and enforces the review boundary by ensuring all
 * candidate drafts are marked 'needs_review' and never automatically published.
 */
export function prepareS3Vis01Handoff(
  rawResult: unknown,
  metadata: { dishName: string; currency?: string },
): S3Vis01HandoffResult {
  // Validate retrieval response against shared contract
  const result = BoundedRetrievalResultSchema.parse(rawResult);

  // If retrieval did not succeed, do NOT fabricate candidate drafts
  if (result.status !== 'success' && result.status !== 'ambiguous') {
    return {
      readyForIngestion: false,
      retrievalStatus: result.status,
      candidates: [],
      unresolvedWarnings: [
        ...result.warnings,
        `Ingestion skipped: retrieval status was '${result.status}'`,
      ],
    };
  }

  const candidates: StructuredDishDraft[] = [];
  const warnings: string[] = [...result.warnings];

  // Map each passage to a structured dish draft candidate
  for (let i = 0; i < result.passages.length; i++) {
    const passage = result.passages[i];
    if (!passage) continue;

    // Extract price if present
    const priceMatch = passage.text.match(/\$\s*(\d+(?:\.\d{2})?)/);
    const rawPrice = priceMatch?.[1];
    const priceAmount = rawPrice ? Number.parseFloat(rawPrice) : undefined;

    const draftId = `draft_${passage.passage_id}`;
    const spans: IngestionSourceSpan[] = [
      {
        segment_id: passage.source.segment_id,
        start: passage.start_offset,
        end: passage.end_offset,
      },
    ];

    const isoCurrency =
      metadata.currency && /^[A-Z]{3}$/.test(metadata.currency) ? metadata.currency : undefined;

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
      ],
      ...(priceAmount !== undefined ? { price_amount: priceAmount } : {}),
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
    unresolvedWarnings: warnings,
  };
}
