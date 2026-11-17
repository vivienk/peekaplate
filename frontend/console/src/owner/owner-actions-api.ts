import {
  type OwnerInsightAction,
  OwnerInsightActionListResponseSchema,
} from '@peekaplate/contracts';
import { readWorkspaceApiBase } from './api-origin';

export type OwnerActionsState =
  | { kind: 'ready'; actions: OwnerInsightAction[] }
  | { kind: 'loading' | 'unavailable' | 'signed_out' | 'denied' };

export async function fetchOwnerActions(options: {
  apiBase: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<OwnerActionsState> {
  const apiBase = readWorkspaceApiBase(options.apiBase);
  if (!apiBase || !/^[0-9a-f-]{36}$/i.test(options.venueId)) return { kind: 'unavailable' };
  try {
    const token = await options.getAccessToken();
    if (!token) return { kind: 'signed_out' };
    options.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(
      `${apiBase}/venues/${encodeURIComponent(options.venueId)}/owner-insight-actions?limit=100`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]),
      },
    );
    if (response.status === 401) return { kind: 'signed_out' };
    if (response.status === 403) return { kind: 'denied' };
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = OwnerInsightActionListResponseSchema.safeParse(await response.json());
    if (
      !parsed.success ||
      parsed.data.actions.some((action) => action.venueId !== options.venueId.toLowerCase())
    )
      return { kind: 'unavailable' };
    return { kind: 'ready', actions: parsed.data.actions };
  } catch {
    return { kind: 'unavailable' };
  }
}
