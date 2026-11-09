// Save on the DIN-01 screens (S3-DIN-02.2 and .5): the markup the menu and dish detail insert for
// their hearts, header button and toast area, and the functions that attach Save behaviour to it.
// The screens keep their layout; everything Save-specific lives here. Each bind returns cleanup.
import type { CompleteDish, Menu } from '../menu/types';
import type { SaveSurface, SendEvent } from './events';
import { mountSaveBadge, mountSaveHeart, mountToastArea } from './mount';
import type { SaveState } from './save-state';
import './save.css';

// The Saved screen's address, so a reload or the browser's Back button lands on the right screen.
export const SAVED_ROUTE = '#saved';

export function isSavedRoute(): boolean {
  return window.location.hash === SAVED_ROUTE;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EMPTY_HEART = '♡';
const FULL_HEART = '♥';

// A heart for one dish. aria-pressed says whether it is saved; the label stays "Save <dish>", the
// usual pattern for a toggle button. The visible word stays "Save" until Rania confirms the copy.
export function saveHeartMarkup(dish: CompleteDish, className: string): string {
  return `<button class="${className} pp-save-heart" type="button" data-save-dish-id="${escapeHtml(dish.dishId)}" aria-label="Save ${escapeHtml(dish.name)}" aria-pressed="false"><span class="pp-save-heart__icon" aria-hidden="true">${EMPTY_HEART}</span> <span aria-hidden="true">Save</span></button>`;
}

// The header button that opens the Saved screen, with the saved-count badge (hidden at zero).
export function savedHeaderMarkup(): string {
  return `<button class="pp-saved" type="button" aria-label="Saved dishes"><span class="pp-saved__icon" aria-hidden="true">${FULL_HEART}</span><span class="pp-saved__badge" aria-hidden="true" hidden></span></button>`;
}

// The stable area where Save toasts appear on this screen.
export function toastAreaMarkup(): string {
  return '<div class="pp-toast-area" aria-live="polite" aria-atomic="true"></div>';
}

function dishesById(menu: Menu): Map<string, CompleteDish> {
  const dishes = new Map<string, CompleteDish>();
  for (const category of menu.categories) {
    for (const dish of category.dishes) {
      if (dish.kind === 'complete') dishes.set(dish.dishId, dish);
    }
  }
  return dishes;
}

// Fills the heart icon when the dish is saved, so the state is visible as well as announced.
function bindHeartIcon(button: HTMLButtonElement, saveState: SaveState): () => void {
  const icon = button.querySelector<HTMLElement>('.pp-save-heart__icon');
  const dishId = button.dataset.saveDishId ?? '';
  const sync = () => {
    if (icon) icon.textContent = saveState.isSaved(dishId) ? FULL_HEART : EMPTY_HEART;
  };
  const stop = saveState.subscribe(sync);
  sync();
  return stop;
}

function bindHearts(
  container: HTMLElement,
  { saveState, menu, surface, send }: SaveBinding & { surface: SaveSurface },
): (() => void)[] {
  const dishes = dishesById(menu);
  const stops: (() => void)[] = [];
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-save-dish-id]')) {
    const dish = dishes.get(button.dataset.saveDishId ?? '');
    if (!dish) continue;
    stops.push(
      mountSaveHeart(button, { saveState, menu, dish, surface, send }),
      bindHeartIcon(button, saveState),
    );
  }
  return stops;
}

function bindToastArea(container: HTMLElement, saveState: SaveState): (() => void)[] {
  const area = container.querySelector<HTMLElement>('.pp-toast-area');
  return area ? [mountToastArea(area, saveState)] : [];
}

type SaveBinding = { saveState: SaveState; menu: Menu; send: SendEvent };

// The menu: card hearts, the header button and badge, and the toast area.
export function bindMenuSave(
  container: HTMLElement,
  { onOpenSaved, ...binding }: SaveBinding & { onOpenSaved: () => void },
): () => void {
  const { saveState } = binding;
  const stops = [
    ...bindHearts(container, { ...binding, surface: 'menu_card' }),
    ...bindToastArea(container, saveState),
  ];
  const header = container.querySelector<HTMLButtonElement>('.pp-saved');
  const badge = header?.querySelector<HTMLElement>('.pp-saved__badge');
  if (header && badge) {
    stops.push(mountSaveBadge(badge, saveState));
    // The badge is hidden from screen readers, so the button's name carries the count.
    const label = () => {
      const count = saveState.savedCount();
      header.setAttribute('aria-label', count === 0 ? 'Saved dishes' : `Saved dishes, ${count}`);
    };
    stops.push(saveState.subscribe(label));
    label();
    header.addEventListener('click', onOpenSaved);
    stops.push(() => header.removeEventListener('click', onOpenSaved));
  }
  return () => {
    for (const stop of stops) stop();
  };
}

// The dish detail: its heart and the toast area.
export function bindDetailSave(container: HTMLElement, binding: SaveBinding): () => void {
  const stops = [
    ...bindHearts(container, { ...binding, surface: 'dish_detail' }),
    ...bindToastArea(container, binding.saveState),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
