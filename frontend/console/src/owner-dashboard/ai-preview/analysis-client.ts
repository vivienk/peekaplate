import {
  type OwnerAnalysisRequest,
  OwnerAnalysisRequestSchema,
  OwnerAnalysisResultSchema,
} from '@peekaplate/contracts/owner-analysis';

export function createOwnerAnalysisClient(options: {
  baseUrl: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  return async (request: OwnerAnalysisRequest, signal: AbortSignal) => {
    const input = OwnerAnalysisRequestSchema.parse(request);
    const base = new URL(options.baseUrl);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !(
        base.protocol === 'https:' ||
        (base.protocol === 'http:' && base.hostname === '127.0.0.1')
      ) ||
      !/^[0-9a-f-]{36}$/i.test(options.venueId)
    )
      throw new Error('Analysis unavailable');
    const token = await options.getAccessToken();
    if (!token) throw new Error('Sign in to request a recommendation.');
    const response = await (options.fetchImpl ?? fetch)(
      `${base.href.replace(/\/$/, '')}/api/v1/venues/${options.venueId}/ai/analysis`,
      {
        method: 'POST',
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) throw new Error('Analysis unavailable');
    const result = OwnerAnalysisResultSchema.parse(await response.json());
    if (
      result.venueId !== options.venueId ||
      result.dishId !== input.dishId ||
      result.goal !== input.goal
    ) {
      throw new Error('Analysis unavailable');
    }
    return result;
  };
}
export type OwnerAnalysisClient = ReturnType<typeof createOwnerAnalysisClient>;
