import { describe, expect, it } from 'vitest';
import { createFixtureMenuSource, DISH } from '../menu/fixtures';
import type { Menu } from '../menu/types';
import { FakeStorage } from './fake-storage';
import { createSaveState } from './save-state';
import { savedItems, shortlistViewedPayload } from './saved-screen-model';

async function loadMenus(loads: number): Promise<Menu[]> {
  const source = createFixtureMenuSource('withdrawal');
  const menus: Menu[] = [];
  for (let n = 0; n < loads; n++) {
    const result = await source.load();
    if (result.status !== 'ready') throw new Error(`expected a ready menu, got ${result.status}`);
    menus.push(result.menu);
  }
  return menus;
}

async function setup() {
  const [first, second] = await loadMenus(2);
  if (!first || !second) throw new Error('missing menus');
  const saveState = createSaveState({ venueId: first.venueId, storage: new FakeStorage() });
  saveState.reconcile(first);
  return { first, second, saveState };
}

describe('saved items', () => {
  it('lists saved dishes newest first, with current details from the menu', async () => {
    const { first, saveState } = await setup();
    saveState.save(DISH.avocadoToast);
    saveState.save(DISH.harvestPowerBowl);
    const items = savedItems(saveState, first);
    expect(items.map((item) => item.dish.dishId)).toEqual([
      DISH.harvestPowerBowl,
      DISH.avocadoToast,
    ]);
    expect(items.every((item) => item.kind === 'complete')).toBe(true);
  });

  it('shows a saved incomplete dish as a placeholder', async () => {
    const { first, saveState } = await setup();
    saveState.save(DISH.incomplete);
    expect(savedItems(saveState, first)).toEqual([
      expect.objectContaining({
        kind: 'incomplete',
        dish: expect.objectContaining({ dishId: DISH.incomplete }),
      }),
    ]);
  });

  it('never shows a dish that is not in the current menu', async () => {
    const { second, saveState } = await setup();
    saveState.save(DISH.salmonPokeBowl);
    expect(savedItems(saveState, second)).toEqual([]);
  });

  it('is empty when nothing is saved', async () => {
    const { first, saveState } = await setup();
    expect(savedItems(saveState, first)).toEqual([]);
  });
});

describe('shortlist_viewed payload', () => {
  it('carries the publication for the tracking layer and the shortlist size', async () => {
    const { first } = await setup();
    expect(shortlistViewedPayload(first, 3)).toEqual({
      publication_revision_id: first.publicationRevisionId,
      shortlist_size: 3,
    });
  });
});
