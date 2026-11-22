import {
  type OwnerAnalysisRequest,
  OwnerAnalysisRequestSchema,
  OwnerAnalysisResultSchema,
} from '@peekaplate/contracts/owner-analysis';
import { PRODUCTION_OWNER_API_ORIGIN, readWorkspaceApiBase } from '../../owner/api-origin';

export class OwnerAnalysisAccessError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? 'Sign in to request a recommendation.' : 'Analysis unavailable');
    this.name = 'OwnerAnalysisAccessError';
  }
}

export class OwnerAnalysisReferenceError extends Error {
  constructor() {
    super('Reload the report before requesting analysis.');
    this.name = 'OwnerAnalysisReferenceError';
  }
}

export function createOwnerAnalysisClient(options: {
  baseUrl: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  return async (request: OwnerAnalysisRequest, signal: AbortSignal, reportReference?: string) => {
    const input = OwnerAnalysisRequestSchema.parse(request);
    const base = new URL(options.baseUrl);
    const apiBase =
      readWorkspaceApiBase(options.baseUrl) ??
      (['http://127.0.0.1:5174/__owner-ai', 'http://127.0.0.1:5174/__owner-ai/'].includes(base.href)
        ? base.href.replace(/\/$/, '')
        : null);
    if (!apiBase || !/^[0-9a-f-]{36}$/i.test(options.venueId))
      throw new Error('Analysis unavailable');
    signal.throwIfAborted();
    const token = await options.getAccessToken();
    signal.throwIfAborted();
    if (!token) throw new OwnerAnalysisAccessError(401);
    const response = await (options.fetchImpl ?? fetch)(
      `${apiBase}/api/v1/venues/${options.venueId}/ai/analysis`,
      {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(reportReference ? { 'X-Owner-Report-Ref': reportReference } : {}),
        },
        body: JSON.stringify(input),
      },
    );
    if (response.status === 401 || response.status === 403)
      throw new OwnerAnalysisAccessError(response.status);
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body?.error === 'report_reference_unavailable') throw new OwnerAnalysisReferenceError();
    }
    if (!response.ok) throw new Error('Analysis unavailable');
    const result = OwnerAnalysisResultSchema.parse(await response.json());
    signal.throwIfAborted();
    if (
      result.venueId !== options.venueId ||
      result.dishId !== input.dishId ||
      result.goal !== input.goal ||
      result.source !== (apiBase === PRODUCTION_OWNER_API_ORIGIN ? 'production' : 'synthetic')
    ) {
      throw new Error('Analysis unavailable');
    }
    return result;
  };
}
export type OwnerAnalysisClient = ReturnType<typeof createOwnerAnalysisClient>;
