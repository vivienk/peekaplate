export type OwnerAiFailureCategory =
  | 'provider_http'
  | 'timeout'
  | 'transport'
  | 'invalid_response'
  | 'configuration'
  | 'request_budget'
  | 'internal';

type Operation = 'owner_analysis' | 'dish_description' | 'dish_allergens';
type DiagnosticInput = {
  category: OwnerAiFailureCategory;
  httpStatus: number | null;
  providerCode?: string | null;
};
export type OwnerAiDiagnostic = Readonly<Required<DiagnosticInput>>;

const categories = new Set<OwnerAiFailureCategory>([
  'provider_http',
  'timeout',
  'transport',
  'invalid_response',
  'configuration',
  'request_budget',
  'internal',
]);
// Only known machine codes may cross the provider boundary into operational logs.
// A string-shaped code is not sufficient: an upstream error can echo credentials.
const providerCodes = new Set([
  'invalid_api_key',
  'invalid_organization',
  'invalid_project',
  'organization_not_found',
  'project_not_found',
  'permission_denied',
  'insufficient_permissions',
  'model_not_found',
  'rate_limit_exceeded',
  'insufficient_quota',
  'credit_balance_exhausted',
  'project_spend_limit_exceeded',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'invalid_request_error',
  'invalid_json_schema',
  'unsupported_parameter',
  'unsupported_value',
  'invalid_value',
  'missing_required_parameter',
  'context_length_exceeded',
  'content_policy_violation',
  'server_error',
  'internal_error',
  'server_is_overloaded',
  'slow_down',
]);
const MAX_RESPONSE_BYTES = 32_768;

function sanitizeDiagnostic(input: DiagnosticInput): OwnerAiDiagnostic {
  const category = categories.has(input.category) ? input.category : 'invalid_response';
  return Object.freeze({
    category,
    httpStatus:
      typeof input.httpStatus === 'number' &&
      Number.isInteger(input.httpStatus) &&
      input.httpStatus >= 100 &&
      input.httpStatus <= 599
        ? input.httpStatus
        : null,
    providerCode:
      category === 'provider_http' &&
      typeof input.providerCode === 'string' &&
      providerCodes.has(input.providerCode)
        ? input.providerCode
        : null,
  });
}

export class OwnerAiProviderFailure extends Error {
  readonly diagnostic: OwnerAiDiagnostic;

  constructor(diagnostic: DiagnosticInput) {
    super('Owner AI provider unavailable');
    this.diagnostic = sanitizeDiagnostic(diagnostic);
  }
}

export function isOwnerAiProjectId(value: string | undefined): boolean {
  return typeof value === 'string' && /^proj_[A-Za-z0-9_-]+$/.test(value);
}

/** Log only fixed classifications and allowlisted provider codes; never an Error object. */
export function logOwnerAiFailure(
  operation: Operation,
  error: unknown,
  fallback: Omit<DiagnosticInput, 'providerCode'> = {
    category: 'invalid_response',
    httpStatus: null,
  },
): void {
  try {
    if (
      operation !== 'owner_analysis' &&
      operation !== 'dish_description' &&
      operation !== 'dish_allergens'
    )
      return;
    const diagnostic = sanitizeDiagnostic(
      error instanceof OwnerAiProviderFailure ? error.diagnostic : fallback,
    );
    console.warn('owner_ai_failure', { operation, ...diagnostic });
  } catch {
    // Logging must not replace the caller's existing generic, fail-closed response.
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Owner AI deadline reached'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    // Observe work even when already aborted so a later rejection is not unhandled.
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      abort();
    }
  });
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const invalid = () =>
    new OwnerAiProviderFailure({ category: 'invalid_response', httpStatus: response.status });
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await untilAborted(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalid();
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    // Cancellation itself can stall for a malformed stream; do not extend the deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw invalid();
    return data;
  } catch {
    throw invalid();
  }
}

function providerCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('error' in data)) return null;
  const error = data.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' && providerCodes.has(error.code) ? error.code : null;
}

/** One request, one whole-response deadline, no retry and no redirect following. */
export async function requestOwnerAiResponse(options: {
  apiKey: string;
  projectId: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<{ data: unknown; httpStatus: number }> {
  if (!options.apiKey || !isOwnerAiProjectId(options.projectId)) {
    throw new OwnerAiProviderFailure({ category: 'configuration', httpStatus: null });
  }
  const signal = AbortSignal.timeout(5_000);
  let response: Response | undefined;
  try {
    response = await untilAborted(
      (options.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'OpenAI-Project': options.projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options.body),
      }),
      signal,
    );
    if (!response.ok) {
      let code: string | null = null;
      try {
        code = providerCode(await readBoundedJson(response, signal));
      } catch {
        // An absent, malformed, oversized or stalled error body cannot erase HTTP evidence.
      }
      throw new OwnerAiProviderFailure({
        category: 'provider_http',
        httpStatus: response.status,
        providerCode: code,
      });
    }
    return { data: await readBoundedJson(response, signal), httpStatus: response.status };
  } catch (error) {
    if (error instanceof OwnerAiProviderFailure) throw error;
    throw new OwnerAiProviderFailure({
      category:
        signal.aborted || (error instanceof Error && error.name === 'TimeoutError')
          ? 'timeout'
          : 'transport',
      httpStatus: response?.status ?? null,
    });
  }
}
