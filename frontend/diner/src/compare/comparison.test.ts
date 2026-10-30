import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDishes } from '../menu/adapter';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import { dishComparedPayload, replaceExclusions, replaceSide, startComparison } from './comparison';
import { pickerOptions } from './picker';

async function loadMenu(scenario: Parameters<typeof createFixtureMenuSource>[0]): Promise<Menu> {
  const result = await createFixtureMenuSource(scenario).load();
  if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
  return result.menu;
}

function revisionOf(menu: Menu, dishId: string): string {
  const dish = completeDishes(menu).find((d) => d.dishId === dishId);
  if (!dish) throw new Error(`expected ${dishId} to be complete`);
  return dish.dishRevisionId;
}

// Stands in for the TRK-01 newComparisonId() helper.
function idSequence() {
  let n = 0;
  return vi.fn(() => `comparison-${++n}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startComparison', () => {
  it('starts a comparison with the kept dish first and a new comparison id', async () => {
    const menu = await loadMenu('demo');
    const newId = idSequence();
    expect(startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, newId)).toEqual({
      comparisonId: 'comparison-1',
      firstDishId: DISH.avocadoToast,
      otherDishId: DISH.harvestPowerBowl,
    });
    expect(newId).toHaveBeenCalledTimes(1);
  });

  it('blocks the same dish twice and incomplete dishes, without making an id', async () => {
    const menu = await loadMenu('edge-cases');
    const newId = idSequence();
    expect(startComparison(menu, DISH.avocadoToast, DISH.avocadoToast, newId)).toBeNull();
    expect(startComparison(menu, DISH.avocadoToast, DISH.incomplete, newId)).toBeNull();
    expect(startComparison(menu, DISH.noIngredients, DISH.avocadoToast, newId)).toBeNull();
    expect(newId).not.toHaveBeenCalled();
  });
});

describe('replaceSide', () => {
  it('replaces either side and keeps the comparison id, then replaces again', async () => {
    const menu = await loadMenu('demo');
    const start = startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, idSequence());
    if (!start) throw new Error('expected a comparison');
    const once = replaceSide(menu, start, 'other', DISH.salmonPokeBowl);
    expect(once).toEqual({ ...start, otherDishId: DISH.salmonPokeBowl });
    const twice = replaceSide(menu, once, 'first', DISH.eggsBenedict);
    expect(twice).toEqual({
      comparisonId: start.comparisonId,
      firstDishId: DISH.eggsBenedict,
      otherDishId: DISH.salmonPokeBowl,
    });
  });

  it('ignores a replacement that is already shown or incomplete', async () => {
    const menu = await loadMenu('edge-cases');
    const start = startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, idSequence());
    if (!start) throw new Error('expected a comparison');
    for (const dishId of [DISH.avocadoToast, DISH.harvestPowerBowl, DISH.incomplete]) {
      expect(replaceSide(menu, start, 'other', dishId)).toBe(start);
    }
  });

  it('gives the picker both shown dishes to exclude', async () => {
    const menu = await loadMenu('demo');
    const start = startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, idSequence());
    if (!start) throw new Error('expected a comparison');
    expect(pickerOptions(menu, replaceExclusions(start)).dishIds).toEqual([
      DISH.eggsBenedict,
      DISH.salmonPokeBowl,
      DISH.gardenAvocadoSalad,
    ]);
  });
});

describe('dishComparedPayload', () => {
  it('builds start then replace payloads with the same comparison id', async () => {
    const menu = await loadMenu('demo');
    const start = startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, idSequence());
    if (!start) throw new Error('expected a comparison');
    expect(dishComparedPayload(menu, start, 'start', false)).toEqual({
      comparison_id: 'comparison-1',
      compare_action: 'start',
      dish_id: DISH.avocadoToast,
      dish_revision_id: revisionOf(menu, DISH.avocadoToast),
      other_dish_id: DISH.harvestPowerBowl,
      other_dish_revision_id: revisionOf(menu, DISH.harvestPowerBowl),
      save_available: false,
    });
    const replaced = replaceSide(menu, start, 'other', DISH.salmonPokeBowl);
    expect(dishComparedPayload(menu, replaced, 'replace', true)).toMatchObject({
      comparison_id: 'comparison-1',
      compare_action: 'replace',
      other_dish_id: DISH.salmonPokeBowl,
      other_dish_revision_id: revisionOf(menu, DISH.salmonPokeBowl),
      save_available: true,
    });
  });

  it('builds nothing when a dish was withdrawn from the menu', async () => {
    const source = createFixtureMenuSource('withdrawal');
    const first = await source.load();
    const second = await source.load();
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('expected menus');
    const start = startComparison(first.menu, DISH.avocadoToast, DISH.salmonPokeBowl, idSequence());
    if (!start) throw new Error('expected a comparison');
    expect(dishComparedPayload(second.menu, start, 'start', false)).toBeNull();
  });

  it('makes no network call and logs nothing', async () => {
    const menu = await loadMenu('demo');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const start = startComparison(menu, DISH.avocadoToast, DISH.harvestPowerBowl, idSequence());
    if (start)
      dishComparedPayload(
        menu,
        replaceSide(menu, start, 'other', DISH.salmonPokeBowl),
        'replace',
        false,
      );
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
