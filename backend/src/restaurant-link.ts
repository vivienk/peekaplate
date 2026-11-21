import { createHash } from 'node:crypto';
import type { Client } from 'pg';

const reserved = new Set(['diner', 'owner', 'venues', 'assets', 'api', 'auth', 'constructor']);

export function restaurantSlugSeed(name: string): string {
  const seed =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48)
      .replace(/_+$/g, '') || 'restaurant';
  return reserved.has(seed) ? `restaurant_${seed}` : seed;
}

// Called only inside the authorized publication transaction and menu lock.
export async function assignRestaurantLink(
  client: Client,
  venueId: string,
  menuId: string,
): Promise<string> {
  const existing = await client.query<{ slug: string }>(
    'SELECT slug FROM app_private.restaurant_menu_link WHERE tenant_id = $1 AND menu_id = $2',
    [venueId, menuId],
  );
  if (existing.rows[0]) return existing.rows[0].slug;
  const venue = await client.query<{ name: string }>(
    'SELECT name FROM app_private.venues WHERE id = $1',
    [venueId],
  );
  if (!venue.rows[0]) throw new Error('Restaurant link venue unavailable');
  const seed = restaurantSlugSeed(venue.rows[0].name);
  const suffix = createHash('sha256').update(`${venueId}:${menuId}`).digest('hex').slice(0, 12);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const slug = attempt === 0 ? seed : `${seed}_${suffix}${attempt === 1 ? '' : `_${attempt}`}`;
    const inserted = await client.query<{ slug: string }>(
      `INSERT INTO app_private.restaurant_menu_link (tenant_id, menu_id, slug)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING slug`,
      [venueId, menuId, slug],
    );
    if (inserted.rows[0]) return inserted.rows[0].slug;
  }
  throw new Error('Restaurant link allocation exhausted');
}

export async function resolveRestaurantLink(client: Client, slug: string) {
  const result = await client.query<{ venueId: string; menuId: string }>(
    'SELECT * FROM app_private.resolve_restaurant_link($1)',
    [slug],
  );
  return result.rows[0];
}
