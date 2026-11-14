import { MenuScopeSchema, RestaurantSlugSchema } from '@peekaplate/contracts';

// Keep existing QR links valid alongside the production /diner namespace.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^(?:/diner)?/venues/(${UUID})/menus/(${UUID})/?$`, 'i');
type MenuRoute = { venueId: string; menuId: string };

export function menuRouteFromPath(pathname: string): MenuRoute | null {
  const match = ROUTE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { venueId: match[1].toLowerCase(), menuId: match[2].toLowerCase() };
}

function restaurantSlug(pathname: string): string | null {
  const slug = /^\/diner\/([^/]+)\/?$/.exec(pathname)?.[1];
  return slug && RestaurantSlugSchema.safeParse(slug).success ? slug : null;
}

export async function resolveMenuRoute(
  pathname: string,
  options: {
    apiBase: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<MenuRoute | null> {
  const canonical = menuRouteFromPath(pathname);
  if (canonical) return canonical;
  const slug = restaurantSlug(pathname);
  if (!slug) return null;
  const response = await (options.fetcher ?? fetch)(
    `${options.apiBase.replace(/\/+$/, '')}/public/restaurants/${slug}`,
    {
      cache: 'no-store',
      credentials: 'omit',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Restaurant link unavailable');
  const scope = MenuScopeSchema.parse(await response.json());
  options.signal?.throwIfAborted();
  return scope;
}
