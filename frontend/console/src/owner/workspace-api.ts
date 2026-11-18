import {
  type OwnerVenue,
  OwnerVenueSchema,
  OwnerWorkspaceResponseSchema,
} from '@peekaplate/contracts';

import { readWorkspaceApiBase } from './api-origin';

export { readWorkspaceApiBase } from './api-origin';

export type WorkspaceState =
  | { kind: 'loading' }
  | { kind: 'ready'; venues: OwnerVenue[] }
  | { kind: 'signed_out' | 'denied' | 'unavailable' | 'error' | 'invalid' };

export type RestaurantCreationState =
  | { kind: 'created'; venue: OwnerVenue }
  | { kind: 'signed_out' | 'denied' | 'unavailable' | 'error' | 'invalid' | 'conflict' | 'quota' };

export async function createTestRestaurant({
  apiBase,
  commandId,
  name,
  getAccessToken,
  signal,
  fetch: send = fetch,
}: {
  apiBase: string;
  commandId: string;
  name: string;
  getAccessToken: () => Promise<string | null>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<RestaurantCreationState> {
  const origin = readWorkspaceApiBase(apiBase);
  if (!origin) return { kind: 'unavailable' };
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    !OwnerVenueSchema.shape.venueId.safeParse(commandId).success
  )
    return { kind: 'invalid' };
  try {
    const token = await getAccessToken();
    if (!token) return { kind: 'signed_out' };
    if (signal.aborted) return { kind: 'error' };
    const response = await send(`${origin}/staff/venues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ commandId, name: trimmed }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (response.status === 401) return { kind: 'signed_out' };
    if (response.status === 403) return { kind: 'denied' };
    if (response.status === 409) return { kind: 'conflict' };
    if (response.status === 429) return { kind: 'quota' };
    if (response.status === 404 || response.status === 503) return { kind: 'unavailable' };
    if (!response.ok) return { kind: 'error' };
    const body = await response.json();
    const parsed = OwnerVenueSchema.safeParse(body?.venue);
    if (!parsed.success || parsed.data.permission !== 'owner' || Object.keys(body).length !== 1)
      return { kind: 'invalid' };
    return { kind: 'created', venue: parsed.data };
  } catch {
    return { kind: 'error' };
  }
}

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
