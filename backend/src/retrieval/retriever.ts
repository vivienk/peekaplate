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

  // 1. Validate request against the agreed schema.
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

  // 2. Process directly provided sources.
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
          if (seg.warnings && seg.warnings.length > 0) {
            for (const warning of seg.warnings) {
              warnings.push(`[${seg.segment_id}] ${warning}`);
            }
          }

          if (seg.status === 'failed' || seg.status === 'skipped' || seg.error) {
            failedSegmentCount++;
            warnings.push(
              `Source '${src.source_id}' segment '${seg.segment_id}' marked as ${seg.status ?? 'failed'}${seg.error ? `: ${seg.error}` : ''}`,
            );
            // Never index a segment marked failed or skipped.
            continue;
          }

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

  // 3. Fetch candidate URLs and discover further menu links within one bound.
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

    if (!url || processedUrls.has(url)) {
      continue;
    }

    processedUrls.add(url);
    fetchedSourceCount++;

    const sourceId = `src_url_${fetchedSourceCount}`;

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

      const contentType = fetchResult.contentType.toLowerCase();

      const hasPdfMagicBytes =
        fetchResult.bytes.length >= 5 &&
        fetchResult.bytes[0] === 0x25 &&
        fetchResult.bytes[1] === 0x50 &&
        fetchResult.bytes[2] === 0x44 &&
        fetchResult.bytes[3] === 0x46 &&
        fetchResult.bytes[4] === 0x2d;

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

            if (!pageText) {
              continue;
            }

            allSegments.push({
              sourceId,
              segment: {
                segment_id: `${sourceId}#page-${pageIndex + 1}`,
                text: pageText,
                page_number: pageIndex + 1,
                method: 'pdf_native',
                is_menu_scope:
                  /menu|appetizer|entree|main|dessert|beverage|dish|price|\$\s*\d+/i.test(pageText),
                provenance: urlProvenance,
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
          allSegments.push({
            sourceId,
            segment: { ...seg, provenance: urlProvenance },
          });
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
          allSegments.push({
            sourceId,
            segment: { ...seg, provenance: urlProvenance },
          });
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

  // 4. Handle catastrophic failure: all sources failed or none were available.
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

  // 5. Extract and rank candidate passages.
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

  // 6. Determine the final retrieval status.
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
