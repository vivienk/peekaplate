import { describe, expect, it } from 'vitest';
import { menuRouteFromPath } from './route';

const V = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

describe('menuRouteFromPath', () => {
  it('reads the venue and menu ids', () => {
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}`)).toEqual({ venueId: V, menuId: M });
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}/`)).toEqual({ venueId: V, menuId: M });
  });
  it('returns null for other paths or non-UUID ids', () => {
    expect(menuRouteFromPath('/')).toBeNull();
    expect(menuRouteFromPath(`/venues/abc/menus/${M}`)).toBeNull();
    expect(menuRouteFromPath(`/venues/${V}/menus/${M}/extra`)).toBeNull();
  });
});
