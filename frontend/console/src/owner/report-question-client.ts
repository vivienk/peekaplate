import {
  OwnerReportQuestionRequestSchema,
  OwnerReportQuestionResultSchema,
} from '@peekaplate/contracts/owner-analysis';
import {
  OwnerAnalysisAccessError,
  OwnerAnalysisReferenceError,
} from '../owner-dashboard/ai-preview/analysis-client';
import { readWorkspaceApiBase } from './api-origin';

export function createOwnerReportQuestionClient(options: {
  apiBase: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
}) {
  return async (question: string, reportReference: string, signal: AbortSignal) => {
    const body = OwnerReportQuestionRequestSchema.parse({ question });
    const apiBase = readWorkspaceApiBase(options.apiBase);
    if (!apiBase || !/^[0-9a-f-]{36}$/i.test(options.venueId)) {
      throw new Error('Report questions unavailable');
    }
    if (!reportReference) throw new OwnerAnalysisReferenceError();
    signal.throwIfAborted();
    const token = await options.getAccessToken();
    signal.throwIfAborted();
    if (!token) throw new OwnerAnalysisAccessError(401);
    const response = await fetch(`${apiBase}/api/v1/venues/${options.venueId}/ai/questions`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Owner-Report-Ref': reportReference,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      throw new OwnerAnalysisAccessError(response.status);
    }
    if (response.status === 409) {
      const problem = await response.json().catch(() => null);
      if (problem?.error === 'report_reference_unavailable')
        throw new OwnerAnalysisReferenceError();
    }
    if (!response.ok) throw new Error('Report questions unavailable');
    const result = OwnerReportQuestionResultSchema.parse(await response.json());
    signal.throwIfAborted();
    if (result.venueId !== options.venueId) throw new Error('Report questions unavailable');
    return result;
  };
}
