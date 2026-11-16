import { createHash } from 'node:crypto';
import { RestaurantProfileSchema } from '@peekaplate/contracts';
import { logoDimensions } from './logo-image';

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
  const response = await send(`${apiBase}/venues/${venue}/profile`, options);
  if (!response.ok) throw new Error('Owner profile unavailable');
  const body = (await response.json()) as { profile?: unknown };
  const profile = RestaurantProfileSchema.parse(body.profile);
  if (!profile.fields.photoId)
    return { restaurant: { name: profile.fields.name, logo: null }, logoFile: null };
  const image = await send(
    `${apiBase}/venues/${venue}/profile/photos/${profile.fields.photoId}`,
    options,
  );
  if (!image.ok || !image.body) throw new Error('Owner logo unavailable');
  const hash = image.headers.get('X-Content-SHA256');
  const size = Number(image.headers.get('Content-Length'));
  if (
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 12_000_000
  )
    throw new Error('Owner logo metadata unavailable');
  const reader = image.body.getReader();
  const bytes = new Uint8Array(size);
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
  if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error('Owner logo hash mismatch');
  const dimensions = logoDimensions(bytes, image.headers.get('Content-Type') ?? '');
  const path = `restaurant-logos/${venue}/${hash}.${dimensions.extension}`;
  return {
    restaurant: {
      name: profile.fields.name,
      logo: {
        url: `${assetBase}/${path}`,
        width: dimensions.width,
        height: dimensions.height,
        alt: `${profile.fields.name} logo`,
      },
    },
    logoFile: { path, bytes },
  };
}
