import { createHash } from 'node:crypto';
import { RestaurantProfileSchema } from '@peekaplate/contracts';

// Staff-only input to operator bundle preparation. Never fetch arbitrary remote logos
// and never put the bearer token or private contact fields into public output.
export async function loadOwnerRestaurant(
  apiBase: string,
  token: string,
  venue: string,
  assetBase: string,
  send: typeof fetch = fetch,
) {
  const url = new URL(apiBase);
  if (
    url.origin !== apiBase ||
    url.protocol !== 'https:' ||
    !token ||
    !/^[a-f0-9-]{36}$/.test(venue)
  )
    throw new Error('Invalid owner profile source');
  const options = {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit' as const,
    cache: 'no-store' as const,
    redirect: 'error' as const,
    signal: AbortSignal.timeout(15_000),
  };
  const response = await send(`${apiBase}/venues/${venue}/restaurant-profile`, options);
  if (!response.ok) throw new Error('Owner profile unavailable');
  const body = (await response.json()) as { profile?: unknown };
  const profile = RestaurantProfileSchema.parse(body.profile);
  if (!profile.logo)
    return { restaurant: { name: profile.details.name, logo: null }, logoFile: null };
  const image = await send(
    `${apiBase}/venues/${venue}/restaurant-profile/logo/${profile.logo.sha256}`,
    options,
  );
  if (!image.ok || !image.body) throw new Error('Owner logo unavailable');
  const reader = image.body.getReader();
  const bytes = new Uint8Array(profile.logo.sizeBytes);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > bytes.length) throw new Error('Owner logo too large');
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    await reader.cancel();
  }
  if (
    offset !== bytes.length ||
    createHash('sha256').update(bytes).digest('hex') !== profile.logo.sha256
  )
    throw new Error('Owner logo hash mismatch');
  const path = `restaurant-logos/${venue}/${profile.logo.sha256}.png`;
  return {
    restaurant: {
      name: profile.details.name,
      logo: {
        url: `${assetBase}/${path}`,
        width: profile.logo.width,
        height: profile.logo.height,
        alt: `${profile.details.name} logo`,
      },
    },
    logoFile: { path, bytes },
  };
}
