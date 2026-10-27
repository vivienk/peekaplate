import type { MenuExtractionResult } from '@peekaplate/contracts';
import { mintExtractionCapability } from '../extraction-capability.js';
import { IngestionError, type MenuIngestionJobRow } from './repository.js';

/**
 * Default extraction HTTP transport timeout in milliseconds (600 seconds = 10 minutes).
 * Accommodates long-running multi-page OCR (e.g. 35-page runs taking ~368s)
 * and cold multimodal LLM batch processing (~500s).
 */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 600_000;

export type HttpExtractorConfig = {
  serviceUrl: string;
  authToken?: string | undefined;
  sourceSigningSecret?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
};

export type ExtractorCallOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * Creates an HTTP client adapter connecting Cloudflare Worker ingestion orchestration
 * to the Python extraction service pipeline.
 */
export function createHttpPythonExtractor(config: HttpExtractorConfig) {
  const fetchImpl = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;

  return async function httpPythonExtractor(
    job: MenuIngestionJobRow,
    callOptions?: ExtractorCallOptions,
  ): Promise<MenuExtractionResult | unknown> {
    if (!job.source_storage_key || !job.source_hash) {
      throw new IngestionError(
        'missing_materialized_source',
        400,
        'Extraction service requires a materialized source_storage_key and source_hash',
      );
    }

    const endpoint = new URL('/extract', config.serviceUrl).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Job-ID': job.id,
      'X-Tenant-ID': job.tenant_id,
      'X-Source-Hash': job.source_hash,
    };
    if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    if (config.sourceSigningSecret) {
      try {
        const capability = await mintExtractionCapability(
          {
            tenantId: job.tenant_id,
            jobId: job.id,
            sourceHash: job.source_hash,
          },
          config.sourceSigningSecret,
        );
        headers['X-Source-Capability'] = capability;
      } catch (err: unknown) {
        throw new IngestionError(
          'capability_minting_failed',
          500,
          `Failed to mint source extraction capability: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const payload = {
      job_id: job.id,
      tenant_id: job.tenant_id,
      source_type: job.source_type,
      source_storage_key: job.source_storage_key,
      source_hash: job.source_hash,
      idempotency_key: job.idempotency_key,
    };

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const externalSignal = callOptions?.signal ?? config.signal;
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
    } catch (err: unknown) {
      if (err instanceof IngestionError) {
        throw err;
      }
      const errObj = err as Error;

      if (externalSignal?.aborted) {
        throw new IngestionError(
          'extraction_aborted',
          499,
          `Extraction request was aborted: ${errObj.message}`,
        );
      }

      const isTimeout =
        errObj.name === 'TimeoutError' ||
        timeoutSignal.aborted ||
        (errObj.name === 'AbortError' && !externalSignal?.aborted);

      throw new IngestionError(
        isTimeout ? 'extraction_timeout' : 'extraction_network_error',
        isTimeout ? 504 : 502,
        `Extraction service call failed: ${errObj.message}`,
      );
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {}
      throw new IngestionError(
        'extraction_service_error',
        response.status >= 500 ? 502 : 400,
        `Extraction service responded with status ${response.status}: ${errorBody.slice(0, 500)}`,
      );
    }

    try {
      return await response.json();
    } catch (err: unknown) {
      throw new IngestionError(
        'malformed_extraction_response',
        502,
        `Extraction service returned non-JSON response: ${(err as Error).message}`,
      );
    }
  };
}
