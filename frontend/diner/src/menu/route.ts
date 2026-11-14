import { MenuScopeSchema } from '@peekaplate/contracts';

// Keep existing QR links valid alongside the production /diner namespace.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^(?:/diner)?/venues/(${UUID})/menus/(${UUID})/?$`, 'i');
const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const RESERVED = new Set(['diner', 'owner', 'venues', 'assets', 'api', 'auth', 'constructor']);
type MenuRoute = { venueId: string; menuId: string };

export function menuRouteFromPath(pathname: string): MenuRoute | null {
  const match = ROUTE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { venueId: match[1].toLowerCase(), menuId: match[2].toLowerCase() };
}

function restaurantSlug(pathname: string): string | null {
  const slug = /^\/diner\/([^/]+)\/?$/.exec(pathname)?.[1];
  return slug && SLUG.test(slug) && !RESERVED.has(slug) ? slug : null;
}

export function parseRestaurantLinks(input: unknown): Map<string, MenuRoute> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid restaurant directory');
  const config = input as Record<string, unknown>;
  if (
    Object.keys(config).length !== 2 ||
    config.schemaVersion !== 1 ||
    !Array.isArray(config.restaurants) ||
    config.restaurants.length > 1000
  )
    throw new Error('Invalid restaurant directory');
  const links = new Map<string, MenuRoute>();
  for (const item of config.restaurants) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid restaurant link');
    const { slug, ...scope } = item as Record<string, unknown>;
    const parsed = MenuScopeSchema.safeParse(scope);
    if (
      typeof slug !== 'string' ||
      !SLUG.test(slug) ||
      RESERVED.has(slug) ||
      links.has(slug) ||
      !parsed.success
    )
      throw new Error('Invalid or duplicate restaurant link');
    links.set(slug, parsed.data);
  }
  return links;
}

export async function resolveMenuRoute(
  pathname: string,
  options: {
    linksUrl: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<MenuRoute | null> {
  const canonical = menuRouteFromPath(pathname);
  if (canonical) return canonical;
  const slug = restaurantSlug(pathname);
  if (!slug) return null;
  const response = await (options.fetcher ?? fetch)(options.linksUrl, {
    cache: 'no-store',
    credentials: 'omit',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error('Restaurant directory unavailable');
  const links = parseRestaurantLinks(await response.json());
  options.signal?.throwIfAborted();
  return links.get(slug) ?? null;
}
