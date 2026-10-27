import type { MenuExtractionResult } from '@peekaplate/contracts';
import { IngestionError, type MenuIngestionJobRow } from './repository.js';

export type HttpExtractorConfig = {
  serviceUrl: string;
  authToken?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
};

/**
 * Creates an HTTP client adapter connecting Cloudflare Worker ingestion orchestration
 * to the Python extraction service pipeline.
 */
export function createHttpPythonExtractor(config: HttpExtractorConfig) {
  const fetchImpl = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? 120_000;

  return async function httpPythonExtractor(
    job: MenuIngestionJobRow,
  ): Promise<MenuExtractionResult | unknown> {
    const endpoint = new URL('/extract', config.serviceUrl).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Job-ID': job.id,
      'X-Tenant-ID': job.tenant_id,
    };
    if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    const payload = {
      job_id: job.id,
      tenant_id: job.tenant_id,
      source_type: job.source_type,
      source_url: job.source_url,
      source_storage_key: job.source_storage_key,
      source_hash: job.source_hash,
      idempotency_key: job.idempotency_key,
    };

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      const isTimeout =
        (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      throw new IngestionError(
        isTimeout ? 'extraction_timeout' : 'extraction_network_error',
        isTimeout ? 504 : 502,
        `Extraction service call failed: ${(err as Error).message}`,
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
