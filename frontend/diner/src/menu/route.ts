// /venues/:venueId/menus/:menuId (DIN-03). Returns null for any other path.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^/venues/(${UUID})/menus/(${UUID})/?$`, 'i');

export function menuRouteFromPath(pathname: string): { venueId: string; menuId: string } | null {
  const match = ROUTE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { venueId: match[1].toLowerCase(), menuId: match[2].toLowerCase() };
}
