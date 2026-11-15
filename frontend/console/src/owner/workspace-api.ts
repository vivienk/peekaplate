import { type OwnerVenue, OwnerWorkspaceResponseSchema } from '@peekaplate/contracts';

import { readWorkspaceApiBase } from './api-origin';

export { readWorkspaceApiBase } from './api-origin';

export type WorkspaceState =
  | { kind: 'loading' }
  | { kind: 'ready'; venues: OwnerVenue[] }
  | { kind: 'signed_out' | 'denied' | 'unavailable' | 'error' | 'invalid' };

export async function fetchOwnerWorkspace({
  apiBase,
  actorId,
  getAccessToken,
  signal,
  fetch: send = fetch,
}: {
  apiBase: string;
  actorId: string;
  getAccessToken: () => Promise<string | null>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<WorkspaceState> {
  if (!readWorkspaceApiBase(apiBase)) return { kind: 'unavailable' };
  try {
    const token = await getAccessToken();
    if (!token) return { kind: 'signed_out' };
    if (signal.aborted) return { kind: 'error' };
    const response = await send(`${apiBase}/staff/venues`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (response.status === 401) return { kind: 'signed_out' };
    if (response.status === 403) return { kind: 'denied' };
    if (response.status === 503 || response.status === 404) return { kind: 'unavailable' };
    if (!response.ok) return { kind: 'error' };
    const parsed = OwnerWorkspaceResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.actorId !== actorId) return { kind: 'invalid' };
    return { kind: 'ready', venues: parsed.data.venues };
  } catch {
    return { kind: 'error' };
  }
}
