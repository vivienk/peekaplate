import { type OwnerVenue, OwnerWorkspaceResponseSchema } from '@peekaplate/contracts';

const API_ORIGINS = new Set([
  'http://127.0.0.1:8787',
  'https://peekaplate-api-staging.vxkong.workers.dev',
]);

export function readWorkspaceApiBase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return API_ORIGINS.has(url.origin) &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

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
