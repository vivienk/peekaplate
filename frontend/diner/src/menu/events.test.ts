import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDishes } from './adapter';
import { createMenuViewedTrigger, trackDishDetailOpened } from './events';
import { createFixtureMenuSource, DISH } from './fixtures';
import type { Menu } from './types';

async function loadMenu(scenario: 'demo' | 'edge-cases'): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

function findDish(menu: Menu, dishId: string) {
  const dish = menu.categories.flatMap((c) => c.dishes).find((d) => d.dishId === dishId);
  if (!dish) throw new Error(`missing ${dishId}`);
  return dish;
}

afterEach(() => vi.restoreAllMocks());

describe('menu_viewed trigger', () => {
  it('sends the publication revision and entry source', async () => {
    const menu = await loadMenu('demo');
    const send = vi.fn();
    createMenuViewedTrigger(send)(menu, 'qr');
    expect(send).toHaveBeenCalledWith('menu_viewed', {
      publication_revision_id: menu.publicationRevisionId,
      entry_source: 'qr',
    });
  });

  it('fires once per publication revision, not again on re-render or retry', async () => {
    const menu = await loadMenu('demo');
    const send = vi.fn();
    const menuViewed = createMenuViewedTrigger(send);
    menuViewed(menu, 'direct_link');
    menuViewed(menu, 'direct_link');
    menuViewed(
      { ...menu, publicationRevisionId: 'c1000000-0000-4000-8000-000000000002' },
      'unknown',
    );
    expect(send.mock.calls.map(([, payload]) => payload.publication_revision_id)).toEqual([
      menu.publicationRevisionId,
      'c1000000-0000-4000-8000-000000000002',
    ]);
  });
});

describe('dish_detail_opened trigger', () => {
  it('sends the dish, opening and save availability with only the matrix fields', async () => {
    const menu = await loadMenu('demo');
    const dish = completeDishes(menu)[0];
    if (!dish) throw new Error('expected a dish');
    const send = vi.fn();
    const openingId = trackDishDetailOpened(
      menu,
      dish,
      {
        source: 'menu_card',
        fromExposureId: 'e1000000-0000-4000-8000-000000000001',
        saveAvailable: false,
      },
      send,
      () => 'o1000000-0000-4000-8000-000000000001',
    );
    expect(openingId).toBe('o1000000-0000-4000-8000-000000000001');
    expect(send).toHaveBeenCalledWith('dish_detail_opened', {
      publication_revision_id: menu.publicationRevisionId,
      dish_id: dish.dishId,
      dish_revision_id: dish.dishRevisionId,
      opening_id: 'o1000000-0000-4000-8000-000000000001',
      source: 'menu_card',
      from_exposure_id: 'e1000000-0000-4000-8000-000000000001',
      save_available: false,
    });
  });

  it('includes nav_relation when given and leaves out absent optional fields', async () => {
    const menu = await loadMenu('demo');
    const dish = completeDishes(menu)[1];
    if (!dish) throw new Error('expected a dish');
    const send = vi.fn();
    trackDishDetailOpened(
      menu,
      dish,
      { source: 'saved_screen', navRelation: 'back_navigation', saveAvailable: true },
      send,
    );
    const payload = send.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty('from_exposure_id');
    expect(payload).toMatchObject({
      source: 'saved_screen',
      nav_relation: 'back_navigation',
      save_available: true,
    });
  });

  it('gives every new opening its own id', async () => {
    const menu = await loadMenu('demo');
    const dish = completeDishes(menu)[0];
    if (!dish) throw new Error('expected a dish');
    const send = vi.fn();
    const first = trackDishDetailOpened(
      menu,
      dish,
      { source: 'menu_card', saveAvailable: false },
      send,
    );
    const second = trackDishDetailOpened(
      menu,
      dish,
      { source: 'menu_card', saveAvailable: false },
      send,
    );
    expect(first).not.toBe(second);
  });

  it('fires nothing for an incomplete dish', async () => {
    const menu = await loadMenu('edge-cases');
    const send = vi.fn();
    const openingId = trackDishDetailOpened(
      menu,
      findDish(menu, DISH.incomplete),
      { source: 'menu_card', saveAvailable: false },
      send,
    );
    expect(openingId).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
