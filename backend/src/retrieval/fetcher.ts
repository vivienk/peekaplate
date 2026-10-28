import { createHash } from 'node:crypto';
import {
  type DestinationValidationOptions,
  SecurityValidationError,
  validateDestination,
} from './security';

export const MAX_SOURCE_BYTES = 12_000_000; // 12 MB general limit
export const MAX_HTML_BYTES = 2_000_000; // 2 MB HTML limit
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export type SafeFetchOptions = {
  timeoutMs?: number | undefined;
  maxRedirects?: number | undefined;
  maxRetries?: number | undefined;
  allowLocalTestDestinations?: boolean | undefined;
  customFetch?: typeof fetch | undefined;
  dnsLookup?: DestinationValidationOptions['dnsLookup'];
};

export type SafeFetchResult = {
  content: string;
  contentType: string;
  finalUrl: string;
  redirectCount: number;
  sha256: string;
  retrievedAt: string;
  sizeBytes: number;
};

/**
 * Reads a response body safely while enforcing an exact byte size limit.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; size: number; sha256: string }> {
  // Check Content-Length header early if available
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      throw new FetchError(
        `Response size (${contentLength} bytes) exceeds limit of ${maxBytes} bytes`,
        'RESPONSE_TOO_LARGE',
      );
    }
  }

  if (!response.body) {
    const emptySha = createHash('sha256').update('').digest('hex');
    return { text: '', size: 0, sha256: emptySha };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new FetchError(
            `Response stream exceeded limit of ${maxBytes} bytes`,
            'RESPONSE_TOO_LARGE',
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks and decode UTF-8
  const fullBuffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    fullBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const sha256 = createHash('sha256').update(fullBuffer).digest('hex');
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  return { text: decoder.decode(fullBuffer), size: totalBytes, sha256 };
}

/**
 * Fetches a public URL with SSRF checks, redirect bounds, response size limits,
 * and bounded retries for transient errors.
 */
export async function safeFetch(
  targetUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const fetchImpl = options.customFetch ?? fetch;

  let currentUrl = targetUrl;
  let redirectCount = 0;

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    // 1. SSRF and destination validation
    const { url: validatedUrl } = await validateDestination(currentUrl, {
      allowLocalTestDestinations: options.allowLocalTestDestinations,
      dnsLookup: options.dnsLookup,
    });

    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt++;
      let response: Response;
      try {
        response = await fetchImpl(validatedUrl.toString(), {
          method: 'GET',
          redirect: 'manual', // Manual redirect control to validate each hop
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'User-Agent': 'PeekaPlateMenuDiscovery/1.0',
            Accept: 'text/html,application/xhtml+xml,text/plain,application/pdf',
          },
        });
      } catch (err: unknown) {
        if (err instanceof SecurityValidationError) {
          throw err;
        }
        const isAbort =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (attempt <= maxRetries && isAbort) {
          // Bounded exponential backoff
          await new Promise((r) => setTimeout(r, 50 * 2 ** (attempt - 1)));
          continue;
        }
        throw new FetchError(
          `Request to '${currentUrl}' failed: ${err instanceof Error ? err.message : String(err)}`,
          isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        );
      }

      // 2. Handle HTTP Redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect >= maxRedirects) {
          throw new FetchError(
            `Exceeded maximum redirect limit of ${maxRedirects}`,
            'TOO_MANY_REDIRECTS',
          );
        }

        const locationHeader = response.headers.get('location');
        if (!locationHeader) {
          throw new FetchError('Redirect response missing Location header', 'MALFORMED_REDIRECT');
        }

        let destinationUrl: URL;
        try {
          destinationUrl = new URL(locationHeader, validatedUrl);
        } catch {
          throw new FetchError('Invalid redirect destination URL', 'MALFORMED_REDIRECT');
        }

        // Scheme downgrade check: HTTPS must not redirect to insecure HTTP
        if (validatedUrl.protocol === 'https:' && destinationUrl.protocol !== 'https:') {
          throw new SecurityValidationError(
            'Insecure redirect downgrade from HTTPS to HTTP is prohibited',
            'INSECURE_REDIRECT',
          );
        }

        currentUrl = destinationUrl.toString();
        redirectCount++;
        break; // Continue to next redirect loop
      }

      // 3. Transient error retries (5xx)
      if (response.status >= 500 && response.status <= 599) {
        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, 50 * 2 ** (attempt - 1)));
          continue;
        }
        throw new FetchError(
          `Server returned HTTP ${response.status}`,
          'SERVER_ERROR',
          response.status,
        );
      }

      // 4. Non-200 responses
      if (response.status !== 200) {
        throw new FetchError(
          `Server returned HTTP ${response.status}`,
          'HTTP_ERROR',
          response.status,
        );
      }

      // 5. Successful 200 response: check content type & enforce size limit
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html');
      const maxAllowedBytes = isHtml ? MAX_HTML_BYTES : MAX_SOURCE_BYTES;

      const { text, size, sha256 } = await readBoundedBody(response, maxAllowedBytes);

      return {
        content: text,
        contentType,
        finalUrl: validatedUrl.toString(),
        redirectCount,
        sha256,
        retrievedAt: new Date().toISOString(),
        sizeBytes: size,
      };
    }
  }

  throw new FetchError('Exceeded maximum redirect limit', 'TOO_MANY_REDIRECTS');
}
