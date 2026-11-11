// Save on the DIN-01 screens (S3-DIN-02.2 and .5): the markup the menu and dish detail insert for
// their hearts, header button and toast area, and the functions that attach Save behaviour to it.
// The screens keep their layout; everything Save-specific lives here. Each bind returns cleanup.
import { UI_ICONS } from '../menu/icons';
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

// A heart for one dish. aria-pressed says whether it is saved; the accessible name stays
// "Save <dish>", the usual pattern for a toggle button. The visible word follows Figma's Heart with
// Text component (298:5568): "Save", then "Saved" in orange once saved (review #13, agreed by Adam).
export function saveHeartMarkup(dish: CompleteDish, className: string): string {
  return `<button class="${className} pp-save-heart" type="button" data-save-dish-id="${escapeHtml(dish.dishId)}" aria-label="Save ${escapeHtml(dish.name)}" aria-pressed="false"><span class="pp-save-heart__icon" aria-hidden="true"><img src="${UI_ICONS.unsaveHeart}" alt="" width="18" height="18" /></span> <span class="pp-save-heart__label" aria-hidden="true">Save</span></button>`;
}

// The header button that opens the Saved screen, with the saved-count badge (hidden at zero).
export function savedHeaderMarkup(): string {
  return `<button class="pp-saved" type="button" aria-label="Saved dishes"><img class="pp-saved__icon" src="${UI_ICONS.unsaveHeart}" alt="" aria-hidden="true" width="24" height="24" /> <span class="pp-saved__badge" aria-hidden="true" hidden></span></button>`;
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
  const icon = button.querySelector<HTMLImageElement>('.pp-save-heart__icon img');
  const label = button.querySelector<HTMLElement>('.pp-save-heart__label');
  const dishId = button.dataset.saveDishId ?? '';
  const sync = () => {
    const saved = saveState.isSaved(dishId);
    if (icon) icon.src = saved ? UI_ICONS.heart : UI_ICONS.unsaveHeart;
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
  const headerIcon = header?.querySelector<HTMLImageElement>('.pp-saved__icon');
  if (header && badge) {
    stops.push(mountSaveBadge(badge, saveState));
    // The badge is hidden from screen readers, so the button's name carries the count.
    const label = () => {
      const count = saveState.savedCount();
      header.setAttribute('aria-label', count === 0 ? 'Saved dishes' : `Saved dishes, ${count}`);
      if (headerIcon) headerIcon.src = count === 0 ? UI_ICONS.unsaveHeart : UI_ICONS.heart;
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
