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

// A heart for one dish. aria-pressed says whether it is saved; the accessible name stays
// "Save <dish>", the usual pattern for a toggle button. The visible word follows Figma's Heart with
// Text component (298:5568): "Save", then "Saved" in orange once saved (review #13, agreed by Adam).
export function saveHeartMarkup(dish: CompleteDish, className: string): string {
  return `<button class="${className} pp-save-heart" type="button" data-save-dish-id="${escapeHtml(dish.dishId)}" aria-label="Save ${escapeHtml(dish.name)}" aria-pressed="false"><span class="pp-save-heart__icon" aria-hidden="true">${EMPTY_HEART}</span> <span class="pp-save-heart__label" aria-hidden="true">Save</span></button>`;
}

// The header heart from Figma (Design/Heart-search-icons/Heart.svg), drawn in the button's colour.
const HEADER_HEART_SVG =
  '<svg class="pp-saved__icon" viewBox="0 2 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.5009 3.91699C16.3749 3.93451 15.2734 4.24885 14.3077 4.82826C13.342 5.40768 12.5463 6.23166 12.0009 7.21699C11.4556 6.23166 10.6599 5.40768 9.69417 4.82826C8.72848 4.24885 7.62698 3.93451 6.50094 3.91699C4.70588 3.99498 3.01464 4.78025 1.79672 6.10122C0.578794 7.4222 -0.0668157 9.17152 0.000934853 10.967C0.000934853 15.514 4.78693 20.48 8.80093 23.847C9.69715 24.6001 10.8303 25.013 12.0009 25.013C13.1716 25.013 14.3047 24.6001 15.2009 23.847C19.2149 20.48 24.0009 15.514 24.0009 10.967C24.0687 9.17152 23.4231 7.4222 22.2052 6.10122C20.9872 4.78025 19.296 3.99498 17.5009 3.91699Z"/></svg>';

// The header button that opens the Saved screen, with the saved-count badge (hidden at zero).
export function savedHeaderMarkup(): string {
  return `<button class="pp-saved" type="button" aria-label="Saved dishes">${HEADER_HEART_SVG}<span class="pp-saved__badge" aria-hidden="true" hidden></span></button>`;
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

// Fills the heart and shows "Saved" when the dish is saved, so the state is visible as well as
// announced.
function bindHeartIcon(button: HTMLButtonElement, saveState: SaveState): () => void {
  const icon = button.querySelector<HTMLElement>('.pp-save-heart__icon');
  const label = button.querySelector<HTMLElement>('.pp-save-heart__label');
  const dishId = button.dataset.saveDishId ?? '';
  const sync = () => {
    const saved = saveState.isSaved(dishId);
    if (icon) icon.textContent = saved ? FULL_HEART : EMPTY_HEART;
    if (label) label.textContent = saved ? 'Saved' : 'Save';
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
