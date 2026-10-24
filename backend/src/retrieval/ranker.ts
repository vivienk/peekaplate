import {
  type EvidencePassage,
  MAX_AGGREGATE_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  MAX_PASSAGES,
} from '@peekaplate/contracts';
import type { ExtractedSegment } from './parser';

export type CandidatePassage = {
  passage_id: string;
  source_id: string;
  segment_id: string;
  text: string;
  start_offset: number;
  end_offset: number;
  score: number;
  provenance?:
    | {
        source_sha256?: string | undefined;
        original_url?: string | undefined;
        final_url?: string | undefined;
        retrieved_at?: string | undefined;
      }
    | undefined;
};

export type RankingOptions = {
  maxPassages?: number | undefined;
  maxContextChars?: number | undefined;
  relevanceThreshold?: number | undefined;
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

/**
 * Tokenizes a string into search terms, excluding common stop words.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s$]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Computes deterministic relevance score between a query and a segment.
 */
export function scoreSegment(
  query: string,
  queryTokens: string[],
  segmentText: string,
  isMenuScope = false,
): { score: number; bestMatchIndex: number } {
  const lowerText = segmentText.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();

  let score = 0;
  let bestMatchIndex = -1;

  // 1. Exact phrase match
  const exactIndex = lowerText.indexOf(normalizedQuery);
  if (exactIndex !== -1) {
    score += 0.5;
    bestMatchIndex = exactIndex;
  }

  // 2. Token overlap match
  if (queryTokens.length > 0) {
    let matchedTokens = 0;
    const tokenIndices: number[] = [];

    for (const token of queryTokens) {
      const idx = lowerText.indexOf(token);
      if (idx !== -1) {
        matchedTokens++;
        tokenIndices.push(idx);
        if (bestMatchIndex === -1) {
          bestMatchIndex = idx;
        }
      }
    }

    const tokenRatio = matchedTokens / queryTokens.length;
    score += tokenRatio * 0.35;

    // 3. Proximity bonus (if multiple tokens are near each other)
    if (tokenIndices.length >= 2) {
      tokenIndices.sort((a, b) => a - b);
      const firstIdx = tokenIndices[0];
      const lastIdx = tokenIndices[tokenIndices.length - 1];
      if (firstIdx !== undefined && lastIdx !== undefined) {
        const span = lastIdx - firstIdx;
        if (span <= 100) {
          score += 0.1;
        }
      }
    }
  }

  // 4. Menu / Price indicator bonus (suggests authentic menu item entry)
  if (/(\$\s*\d+|\d+\.\d{2}|CAD|USD|€|£)/.test(segmentText)) {
    score += 0.1;
  }

  // 5. Menu section scope boost
  if (isMenuScope) {
    score += 0.05;
  }

  // 6. Boilerplate penalty (cookie, copyright, navigation disclaimer)
  if (
    /cookie|privacy policy|terms of service|copyright|all rights reserved|powered by/i.test(
      segmentText,
    )
  ) {
    score = Math.max(0, score - 0.4);
  }

  // Normalize score to [0, 1] range, rounded to 4 decimals for determinism
  const normalizedScore = Math.min(1, Math.max(0, Math.round(score * 10000) / 10000));
  return { score: normalizedScore, bestMatchIndex: Math.max(0, bestMatchIndex) };
}

/**
 * Extracts a candidate passage window from the segment preserving exact offsets.
 */
export function extractPassageFromSegment(
  sourceId: string,
  segment: ExtractedSegment,
  query: string,
  queryTokens: string[],
): CandidatePassage | null {
  const { score, bestMatchIndex } = scoreSegment(
    query,
    queryTokens,
    segment.text,
    segment.is_menu_scope,
  );

  if (score <= 0.05) {
    return null; // Not relevant
  }

  let startOffset = 0;
  let endOffset = segment.text.length;

  // If segment text fits in max passage length, use the whole segment
  if (segment.text.length > MAX_PASSAGE_CHARS) {
    // Center a window around bestMatchIndex
    const halfWindow = Math.floor(MAX_PASSAGE_CHARS / 2);
    startOffset = Math.max(0, bestMatchIndex - halfWindow);
    endOffset = Math.min(segment.text.length, startOffset + MAX_PASSAGE_CHARS);

    // If near the end, shift start backward
    if (endOffset - startOffset < MAX_PASSAGE_CHARS && startOffset > 0) {
      startOffset = Math.max(0, endOffset - MAX_PASSAGE_CHARS);
    }

    // Try to align start to a newline or space boundary if close
    if (startOffset > 0) {
      const spaceIdx = segment.text.indexOf(' ', startOffset);
      if (spaceIdx !== -1 && spaceIdx - startOffset < 30) {
        startOffset = spaceIdx + 1;
      }
    }
  }

  const passageText = segment.text.slice(startOffset, endOffset);
  if (passageText.length === 0) return null;

  // Deterministic stable passage ID
  const passageId = `p_${sourceId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${segment.segment_id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${startOffset}_${endOffset}`;

  return {
    passage_id: passageId,
    source_id: sourceId,
    segment_id: segment.segment_id,
    text: passageText,
    start_offset: startOffset,
    end_offset: endOffset,
    score,
    ...(segment.provenance ? { provenance: segment.provenance } : {}),
  };
}

/**
 * Extracts and normalizes explicit prices from text for conflict detection.
 */
export function extractPrices(text: string): string[] {
  const priceRegex = /(?:\$|CAD|USD|EUR|€|£)\s*(\d+(?:\.\d{1,2})?)|\b(\d+\.\d{2})\b/g;
  const prices = new Set<string>();
  for (const m of text.matchAll(priceRegex)) {
    const val = m[1] ?? m[2];
    if (val !== undefined) {
      const num = Number.parseFloat(val);
      if (!Number.isNaN(num) && num > 0) {
        prices.add(num.toFixed(2));
      }
    }
  }
  return [...prices].sort();
}

/**
 * Checks whether two candidate passages contain mutually conflicting explicit prices.
 */
export function hasConflictingPrices(textA: string, textB: string): boolean {
  const pricesA = extractPrices(textA);
  const pricesB = extractPrices(textB);
  if (pricesA.length === 0 || pricesB.length === 0) return false;
  return pricesA.some((p) => !pricesB.includes(p)) || pricesB.some((p) => !pricesA.includes(p));
}

/**
 * Calculates word Jaccard similarity between two texts for deduplication.
 */
function jaccardSimilarity(textA: string, textB: string): number {
  const setA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Deduplicates and ranks candidate passages deterministically.
 * Preserves conflicting evidence (e.g. differing prices for the same dish)
 * so that contradictions remain visible for ambiguity detection.
 */
export function rankAndBoundPassages(
  candidates: CandidatePassage[],
  options: RankingOptions = {},
): { passages: EvidencePassage[]; isAmbiguous: boolean } {
  const maxPassages = options.maxPassages ?? MAX_PASSAGES;
  const maxContextChars = options.maxContextChars ?? MAX_AGGREGATE_PASSAGE_CHARS;
  const relevanceThreshold = options.relevanceThreshold ?? 0.25;

  // 1. Filter candidates below threshold
  const filtered = candidates.filter((c) => c.score >= relevanceThreshold);

  // 2. Deterministic sort: descending by score, tie-break by source_id, segment_id, start_offset
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source_id !== b.source_id) return a.source_id.localeCompare(b.source_id);
    if (a.segment_id !== b.segment_id) return a.segment_id.localeCompare(b.segment_id);
    return a.start_offset - b.start_offset;
  });

  // 3. Deduplication with contradiction preservation
  const deduplicated: CandidatePassage[] = [];
  let detectedConflict = false;

  for (const cand of filtered) {
    let isDuplicate = false;

    for (const existing of deduplicated) {
      // Check segment overlap within the same segment of the same source
      if (cand.source_id === existing.source_id && cand.segment_id === existing.segment_id) {
        if (cand.start_offset < existing.end_offset && cand.end_offset > existing.start_offset) {
          isDuplicate = true;
          break;
        }
      }

      // Check text Jaccard similarity
      if (jaccardSimilarity(cand.text, existing.text) > 0.8) {
        // If the candidates contain conflicting explicit prices or details, do NOT discard them!
        // Preserving both candidates allows conflict detection to surface the contradiction.
        if (hasConflictingPrices(cand.text, existing.text)) {
          detectedConflict = true;
          // Do not treat as duplicate
          continue;
        }

        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      deduplicated.push(cand);
    }
  }

  // 4. Check for ambiguity: conflicting details detected during deduplication
  // or multiple top-ranking candidates with near-equal scores but differing prices
  let isAmbiguous = detectedConflict;

  if (!isAmbiguous && deduplicated.length >= 2) {
    const topScore = deduplicated[0]?.score ?? 0;
    const candidatesToCheck = deduplicated.filter(
      (c) => c.score >= 0.5 && Math.abs(topScore - c.score) <= 0.15,
    );
    for (let i = 0; i < candidatesToCheck.length; i++) {
      for (let j = i + 1; j < candidatesToCheck.length; j++) {
        const c1 = candidatesToCheck[i]!;
        const c2 = candidatesToCheck[j]!;
        if (hasConflictingPrices(c1.text, c2.text)) {
          isAmbiguous = true;
          break;
        }
      }
      if (isAmbiguous) break;
    }
  }

  // 5. Bound passages count and aggregate context size
  const finalPassages: EvidencePassage[] = [];
  let totalChars = 0;

  for (let i = 0; i < deduplicated.length; i++) {
    if (finalPassages.length >= maxPassages) break;

    const cand = deduplicated[i];
    if (!cand) continue;
    if (totalChars + cand.text.length > maxContextChars) {
      continue; // Skip passage if it would exceed aggregate context size
    }

    totalChars += cand.text.length;
    finalPassages.push({
      passage_id: cand.passage_id,
      source: {
        source_id: cand.source_id,
        segment_id: cand.segment_id,
        ...(cand.provenance?.source_sha256 ? { source_sha256: cand.provenance.source_sha256 } : {}),
        ...(cand.provenance?.original_url ? { original_url: cand.provenance.original_url } : {}),
        ...(cand.provenance?.final_url ? { final_url: cand.provenance.final_url } : {}),
        ...(cand.provenance?.retrieved_at ? { retrieved_at: cand.provenance.retrieved_at } : {}),
      },
      text: cand.text,
      start_offset: cand.start_offset,
      end_offset: cand.end_offset,
      rank: finalPassages.length + 1,
      score: cand.score,
    });
  }

  return { passages: finalPassages, isAmbiguous };
}
