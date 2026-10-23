import {
  type BoundedRetrievalResult,
  BoundedRetrievalResultSchema,
  type RetrievalRequest,
  RetrievalRequestSchema,
} from '@peekaplate/contracts';
import { extractText } from 'unpdf';
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
      if (src.segments && src.segments.length > 0) {
        for (const seg of src.segments) {
          allSegments.push({
            sourceId: src.source_id,
            segment: {
              segment_id: seg.segment_id,
              text: seg.text,
              ...(seg.page_number !== undefined ? { page_number: seg.page_number } : {}),
              method: seg.method || 'text',
            },
          });
        }
        successfulSourceCount++;
      } else if (src.content) {
        if (src.kind === 'html') {
          const parsed = parseHtmlSource(src.content, src.source_id, src.location);
          for (const seg of parsed.segments) {
            allSegments.push({ sourceId: src.source_id, segment: seg });
          }
          warnings.push(...parsed.warnings);
        } else {
          const parsed = parsePlainTextSource(
            src.content,
            src.source_id,
            src.kind === 'pdf' ? 'pdf_native' : 'text',
          );
          for (const seg of parsed.segments) {
            allSegments.push({ sourceId: src.source_id, segment: seg });
          }
          warnings.push(...parsed.warnings);
        }
        successfulSourceCount++;
      }
    }
  }

  // 3. Process candidate URLs and follow discovered menu links within one bound.
  const maxSources = Math.min(
    MAX_FETCHED_SOURCES,
    Math.max(0, options.maxFetchedSources ?? MAX_FETCHED_SOURCES),
  );

  const urlQueue = [...(request.candidate_urls ?? []).slice(0, maxSources)];
  const queuedUrls = new Set(urlQueue);
  const processedUrls = new Set<string>();
  let fetchedSourceCount = 0;

  for (let i = 0; i < urlQueue.length && fetchedSourceCount < maxSources; i++) {
    const url = urlQueue[i];
    if (!url || processedUrls.has(url)) continue;

    processedUrls.add(url);
    fetchedSourceCount++;

    const sourceId = `src_url_${fetchedSourceCount}`;

    try {
      const fetchResult = await safeFetch(url, options);

      if (fetchResult.redirectCount > 0) {
        warnings.push(`Source '${url}' redirected ${fetchResult.redirectCount} time(s)`);
      }

      const contentType = fetchResult.contentType.toLowerCase();
      const hasPdfMagicBytes =
        fetchResult.bytes.length >= 5 &&
        fetchResult.bytes[0] === 0x25 && // %
        fetchResult.bytes[1] === 0x50 && // P
        fetchResult.bytes[2] === 0x44 && // D
        fetchResult.bytes[3] === 0x46 && // F
        fetchResult.bytes[4] === 0x2d; // -

      const isPdf =
        contentType.includes('application/pdf') ||
        /\.pdf(?:$|[?#])/i.test(fetchResult.finalUrl) ||
        hasPdfMagicBytes;

      const isHtml =
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml+xml') ||
        (!isPdf && fetchResult.content.trim().startsWith('<'));

      if (isPdf) {
        try {
          const extracted = await extractText(fetchResult.bytes, {
            mergePages: false,
          });

          let pageSegmentCount = 0;

          for (let pageIndex = 0; pageIndex < extracted.text.length; pageIndex++) {
            const pageText = extracted.text[pageIndex]?.trim();
            if (!pageText) continue;

            allSegments.push({
              sourceId,
              segment: {
                segment_id: `${sourceId}#page-${pageIndex + 1}`,
                text: pageText,
                page_number: pageIndex + 1,
                method: 'pdf_native',
                is_menu_scope:
                  /menu|appetizer|entree|main|dessert|beverage|dish|price|\$\s*\d+/i.test(pageText),
              },
            });

            pageSegmentCount++;
          }

          if (pageSegmentCount === 0) {
            warnings.push(
              `PDF '${url}' contained no extractable text; scanned PDFs may require OCR`,
            );
          }

          successfulSourceCount++;
        } catch (err: unknown) {
          failedSourceCount++;
          warnings.push(
            `Failed to extract text from PDF '${url}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else if (isHtml) {
        const parsed = parseHtmlSource(fetchResult.content, sourceId, fetchResult.finalUrl);

        for (const seg of parsed.segments) {
          allSegments.push({ sourceId, segment: seg });
        }

        warnings.push(...parsed.warnings);

        // Follow discovered links only while the overall fetch budget permits.
        for (const discoveredUrl of parsed.discoveredLinks) {
          if (
            urlQueue.length >= maxSources ||
            queuedUrls.has(discoveredUrl) ||
            processedUrls.has(discoveredUrl)
          ) {
            continue;
          }

          urlQueue.push(discoveredUrl);
          queuedUrls.add(discoveredUrl);
        }

        successfulSourceCount++;
      } else {
        const parsed = parsePlainTextSource(fetchResult.content, sourceId, 'text');

        for (const seg of parsed.segments) {
          allSegments.push({ sourceId, segment: seg });
        }

        warnings.push(...parsed.warnings);
        successfulSourceCount++;
      }
    } catch (err: unknown) {
      failedSourceCount++;

      if (err instanceof SecurityValidationError) {
        warnings.push(`Security rejection for '${url}': ${err.message} (${err.code})`);
      } else {
        warnings.push(
          `Failed to fetch candidate source '${url}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
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
