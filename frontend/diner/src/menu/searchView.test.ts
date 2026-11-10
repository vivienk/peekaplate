import { describe, expect, it } from 'vitest';
import { CATEGORY, createFixtureMenuSource, DISH } from './fixtures';
import {
  SEARCH_ALL_CATEGORY_ID,
  searchEmptyMarkup,
  searchPanelMarkup,
  searchViewState,
} from './searchView';
import type { Menu } from './types';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

const ALL = SEARCH_ALL_CATEGORY_ID;

describe('searchViewState', () => {
  it('leaves the menu unfiltered for an empty or blank query', async () => {
    const menu = await loadMenu('demo');
    for (const query of ['', '   ']) {
      expect(searchViewState(menu, query, ALL)).toEqual({
        active: false,
        matches: null,
        visibleCount: 0,
        noResults: false,
        allergyNotice: false,
        announcement: '',
      });
    }
  });

  it('shows matches from every category on "All" and announces the count', async () => {
    const menu = await loadMenu('edge-cases');
    const state = searchViewState(menu, 'toast', ALL);
    expect([...(state.matches ?? [])]).toEqual([
      DISH.avocadoToast,
      DISH.briocheFrenchToast,
      DISH.longName,
    ]);
    expect(state).toMatchObject({ active: true, visibleCount: 3, noResults: false });
    expect(state.announcement).toBe('3 dishes found');
  });

  it('uses the singular for one result', async () => {
    const menu = await loadMenu('edge-cases');
    expect(searchViewState(menu, 'avocado toast', ALL).announcement).toBe('1 dish found');
  });

  it('counts only the selected category when a tab narrows the results', async () => {
    const menu = await loadMenu('edge-cases');
    const salads = searchViewState(menu, 'toast', CATEGORY.salads);
    expect(salads.visibleCount).toBe(1);
    expect(salads.announcement).toBe('1 dish found');
    const bowls = searchViewState(menu, 'toast', CATEGORY.brunchBowls);
    expect(bowls).toMatchObject({ visibleCount: 0, noResults: true });
    expect(bowls.announcement).toBe('No dishes found');
  });

  it('shows the no-results state with no staff line for an unknown dish', async () => {
    const menu = await loadMenu('demo');
    expect(searchViewState(menu, 'pizza', ALL)).toMatchObject({
      active: true,
      visibleCount: 0,
      noResults: true,
      allergyNotice: false,
      announcement: 'No dishes found',
    });
  });

  it('shows the staff line for an allergen, even with no matching dish', async () => {
    const menu = await loadMenu('demo');
    expect(searchViewState(menu, 'eggs', ALL)).toMatchObject({
      allergyNotice: true,
      noResults: false,
    });
    expect(searchViewState(menu, 'gluten', ALL)).toMatchObject({
      allergyNotice: true,
      noResults: true,
    });
  });

  it('shows the staff line for a dietary value but not for a dish name', async () => {
    const menu = await loadMenu('demo');
    expect(searchViewState(menu, 'gluten-free', ALL).allergyNotice).toBe(true);
    expect(searchViewState(menu, 'avocado', ALL).allergyNotice).toBe(false);
  });

  it('never returns incomplete dishes', async () => {
    const menu = await loadMenu('edge-cases');
    const incomplete = menu.categories
      .flatMap((category) => category.dishes)
      .filter((dish) => dish.kind !== 'complete')
      .map((dish) => dish.dishId);
    expect(incomplete.length).toBeGreaterThan(0);
    const state = searchViewState(menu, 'a', ALL);
    for (const dishId of incomplete) expect(state.matches?.has(dishId)).toBe(false);
  });
});

describe('search markup', () => {
  it('labels the input, announces politely and keeps the query out of the markup', () => {
    const panel = searchPanelMarkup();
    expect(panel).toContain('<label class="pp-sr-only" for="pp-search-input">');
    expect(panel).toContain('role="status" aria-live="polite"');
    expect(panel).toContain('role="search"');
    expect(panel).not.toMatch(/\svalue=/);
    expect(panel).toContain('For allergy questions, please ask the restaurant staff.');
  });

  it('matches the Figma no-results copy', () => {
    const empty = searchEmptyMarkup();
    expect(empty).toContain('No Result Found');
    expect(empty).toContain('Try a different dish name or ingredient.');
    expect(empty).toContain('Clear search');
  });
});
