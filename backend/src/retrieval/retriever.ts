import {
  type BoundedRetrievalResult,
  BoundedRetrievalResultSchema,
  type RetrievalRequest,
  RetrievalRequestSchema,
} from '@peekaplate/contracts';
import { type SafeFetchOptions, safeFetch } from './fetcher';
import { type ExtractedSegment, parseHtmlSource, parsePlainTextSource } from './parser';
import {
  type CandidatePassage,
  extractPassageFromSegment,
  rankAndBoundPassages,
  tokenizeQuery,
} from './ranker';
import { SecurityValidationError } from './security';

export type RetrievalExecutionOptions = SafeFetchOptions & {
  maxFetchedSources?: number | undefined;
};

export const MAX_FETCHED_SOURCES = 5;

/**
 * Executes bounded menu evidence retrieval for downstream ingestion (S3-VIS-01).
 *
 * Discovers candidate sources, validates public URLs against SSRF policies,
 * fetches content safely with timeout and redirect limits, segments source text,
 * deterministically ranks evidence matching the query, enforces strict context bounds,
 * and returns a schema-validated BoundedRetrievalResult.
 */
export async function retrieveMenuEvidence(
  rawRequest: unknown,
  options: RetrievalExecutionOptions = {},
): Promise<BoundedRetrievalResult> {
  const warnings: string[] = [];
  const maxFetchedSources = options.maxFetchedSources ?? MAX_FETCHED_SOURCES;

  // 1. Validate request against agreed schema
  let request: RetrievalRequest;
  try {
    request = RetrievalRequestSchema.parse(rawRequest);
  } catch (err: unknown) {
    return BoundedRetrievalResultSchema.parse({
      schema_version: 1,
      status: 'failed',
      passages: [],
      warnings: [`Invalid retrieval request: ${err instanceof Error ? err.message : String(err)}`],
    });
  }

  const query = request.query;
  const queryTokens = tokenizeQuery(query);
  const allSegments: { sourceId: string; segment: ExtractedSegment }[] = [];
  let successfulSourceCount = 0;
  let failedSourceCount = 0;

  // 2. Process directly provided sources
  if (request.sources && request.sources.length > 0) {
    for (const src of request.sources) {
      const sourceProvenance = {
        source_sha256: src.sha256,
        original_url:
          src.location && (src.kind === 'url' || src.kind === 'website') ? src.location : undefined,
        retrieved_at: src.retrieved_at,
      };

      if (src.segments && src.segments.length > 0) {
        let validSegmentCount = 0;
        let failedSegmentCount = 0;

        for (const seg of src.segments) {
          // Preserve upstream segment-level warnings
          if (seg.warnings && seg.warnings.length > 0) {
            for (const w of seg.warnings) {
              warnings.push(`[${seg.segment_id}] ${w}`);
            }
          }

          // Handle incomplete / failed / skipped pages explicitly
          if (seg.status === 'failed' || seg.status === 'skipped' || seg.error) {
            failedSegmentCount++;
            warnings.push(
              `Source '${src.source_id}' segment '${seg.segment_id}' marked as ${seg.status ?? 'failed'}${seg.error ? `: ${seg.error}` : ''}`,
            );
            // CRITICAL: Never index a segment marked failed or skipped, regardless of whether it has text
            continue;
          }

          // If the segment has no readable text, skip indexing it
          if (!seg.text || seg.text.trim().length === 0) {
            continue;
          }

          allSegments.push({
            sourceId: src.source_id,
            segment: {
              segment_id: seg.segment_id,
              text: seg.text,
              ...(seg.page_number !== undefined ? { page_number: seg.page_number } : {}),
              method: seg.method || 'text',
              ...(seg.metadata ? { metadata: seg.metadata } : {}),
              provenance: sourceProvenance,
            },
          });
          validSegmentCount++;
        }

        if (validSegmentCount > 0) {
          successfulSourceCount++;
          if (failedSegmentCount > 0) {
            warnings.push(
              `Source '${src.source_id}' partially indexed (${validSegmentCount} valid, ${failedSegmentCount} failed/skipped)`,
            );
          }
        } else {
          failedSourceCount++;
          warnings.push(
            `Source '${src.source_id}' contained no usable segments (${failedSegmentCount} failed/skipped)`,
          );
        }
      } else if (src.content) {
        if (src.kind === 'html' || src.kind === 'website') {
          const parsed = parseHtmlSource(src.content, src.source_id, src.location);
          for (const seg of parsed.segments) {
            allSegments.push({
              sourceId: src.source_id,
              segment: { ...seg, provenance: sourceProvenance },
            });
          }
          warnings.push(...parsed.warnings);
        } else {
          const parsed = parsePlainTextSource(
            src.content,
            src.source_id,
            src.kind === 'pdf' ? 'pdf_native' : 'text',
          );
          for (const seg of parsed.segments) {
            allSegments.push({
              sourceId: src.source_id,
              segment: { ...seg, provenance: sourceProvenance },
            });
          }
          warnings.push(...parsed.warnings);
        }
        successfulSourceCount++;
      }
    }
  }

  // 3. Process candidate URLs
  if (request.candidate_urls && request.candidate_urls.length > 0) {
    const urlsToFetch = request.candidate_urls.slice(0, maxFetchedSources);
    for (let i = 0; i < urlsToFetch.length; i++) {
      const url = urlsToFetch[i];
      if (!url) continue;
      const sourceId = `src_url_${i + 1}`;

      try {
        const fetchResult = await safeFetch(url, options);
        if (fetchResult.redirectCount > 0) {
          warnings.push(`Source '${url}' redirected ${fetchResult.redirectCount} time(s)`);
        }

        const urlProvenance = {
          source_sha256: fetchResult.sha256,
          original_url: url,
          final_url: fetchResult.finalUrl,
          retrieved_at: fetchResult.retrievedAt,
        };

        const isHtml =
          fetchResult.contentType.includes('text/html') ||
          fetchResult.content.trim().startsWith('<');

        if (isHtml) {
          const parsed = parseHtmlSource(fetchResult.content, sourceId, fetchResult.finalUrl);
          for (const seg of parsed.segments) {
            allSegments.push({
              sourceId,
              segment: { ...seg, provenance: urlProvenance },
            });
          }
          warnings.push(...parsed.warnings);
        } else {
          const parsed = parsePlainTextSource(fetchResult.content, sourceId, 'text');
          for (const seg of parsed.segments) {
            allSegments.push({
              sourceId,
              segment: { ...seg, provenance: urlProvenance },
            });
          }
          warnings.push(...parsed.warnings);
        }

        successfulSourceCount++;
      } catch (err: unknown) {
        failedSourceCount++;
        if (err instanceof SecurityValidationError) {
          warnings.push(`Security rejection for '${url}': ${err.message} (${err.code})`);
        } else {
          warnings.push(
            `Failed to fetch candidate source '${url}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // 4. Handle catastrophic failure: all sources failed to fetch or none available
  if (successfulSourceCount === 0 && failedSourceCount > 0) {
    return BoundedRetrievalResultSchema.parse({
      schema_version: 1,
      status: 'failed',
      passages: [],
      warnings,
    });
  }

  if (allSegments.length === 0) {
    return BoundedRetrievalResultSchema.parse({
      schema_version: 1,
      status: 'no_result',
      passages: [],
      warnings: [...warnings, `No content segments available to examine for query: "${query}"`],
    });
  }

  // 5. Extract and rank candidate passages
  const candidatePassages: CandidatePassage[] = [];
  for (const item of allSegments) {
    const candidate = extractPassageFromSegment(item.sourceId, item.segment, query, queryTokens);
    if (candidate) {
      candidatePassages.push(candidate);
    }
  }

  const { passages, isAmbiguous } = rankAndBoundPassages(candidatePassages, {
    maxPassages: request.max_passages,
    maxContextChars: request.max_context_chars,
  });

  // 6. Determine final retrieval status
  if (passages.length === 0) {
    return BoundedRetrievalResultSchema.parse({
      schema_version: 1,
      status: 'no_result',
      passages: [],
      warnings: [...warnings, `No relevant menu evidence passages matched query: "${query}"`],
    });
  }

  if (isAmbiguous) {
    warnings.push(
      'Ambiguous evidence detected: multiple candidate menu entries matched with differing details',
    );
    return BoundedRetrievalResultSchema.parse({
      schema_version: 1,
      status: 'ambiguous',
      passages,
      warnings,
    });
  }

  return BoundedRetrievalResultSchema.parse({
    schema_version: 1,
    status: 'success',
    passages,
    warnings,
  });
}
