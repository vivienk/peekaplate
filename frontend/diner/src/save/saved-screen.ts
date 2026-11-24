// The Saved screen (S3-DIN-02.5): the diner's saved dishes, newest first. Like the DIN-01 screens it
// renders into a container and navigates through callbacks; it is built with DOM methods, so dish
// text is never parsed as markup. Copy and look are provisional until the Figma Saved frames are
// applied.
import savedEmptyIcon from '../assets/icons/ui/cutllery.svg';
import { BACK_ICON } from '../menu/navButton';
import { formatPrice } from '../menu/price';
import type { CompleteDish, Menu } from '../menu/types';
import type { SendEvent } from './events';
import { mountSaveHeart, mountToastArea } from './mount';
import type { SaveState } from './save-state';
import { type SavedItem, savedItems, shortlistViewedPayload } from './saved-screen-model';
import './saved-screen.css';

export const SESSION_ONLY_NOTICE = 'Saved for this session only';
const PLACEHOLDER_TEXT = 'More information needed — pending restaurant input';

const noSend: SendEvent = () => {};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export type SavedScreenOptions = {
  saveState: SaveState;
  menu: Menu;
  // Opens the standard dish detail; the caller tracks dish_detail_opened with source saved_screen.
  onOpenDish: (dish: CompleteDish) => void;
  // Leaves the Saved screen: the back button and "Browse menu".
  onBack: () => void;
  send?: SendEvent;
  recordView?: boolean;
};

const SAVED_HEART_ICON =
  '<svg class="pp-saved__heart" viewBox="0 2 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.5009 3.91699C16.3749 3.93451 15.2734 4.24885 14.3077 4.82826C13.342 5.40768 12.5463 6.23166 12.0009 7.21699C11.4556 6.23166 10.6599 5.40768 9.69417 4.82826C8.72848 4.24885 7.62698 3.93451 6.50094 3.91699C4.70588 3.99498 3.01464 4.78025 1.79672 6.10122C0.578794 7.4222 -0.0668157 9.17152 0.000934853 10.967C0.000934853 15.514 4.78693 20.48 8.80093 23.847C9.69715 24.6001 10.8303 25.013 12.0009 25.013C13.1716 25.013 14.3047 24.6001 15.2009 23.847C19.2149 20.48 24.0009 15.514 24.0009 10.967C24.0687 9.17152 23.4231 7.4222 22.2052 6.10122C20.9872 4.78025 19.296 3.99498 17.5009 3.91699Z"/></svg>';

// Call once per readable display of the Saved screen (navigating to it, going back to it, or a
// reload while on it); each call sends one shortlist_viewed. Changes while it is shown (removing a
// dish, Undo, the session-only switch) redraw the list without another view. Returns cleanup.
export function renderSavedScreen(
  container: HTMLElement,
  { saveState, menu, onOpenDish, onBack, send = noSend, recordView = true }: SavedScreenOptions,
): () => void {
  // Not .pp-saved: that is the menu header's Saved button.
  const screen = el('div', 'pp-saved-screen');
  const header = el('header', 'pp-saved__topbar');
  // Figma Nav Button (back), shared with Dish details and the Compare result view.
  const back = el('button', 'pp-nav-btn pp-nav-btn--back pp-saved__back');
  back.innerHTML = BACK_ICON;
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to menu');
  back.addEventListener('click', onBack);
  header.append(back, el('h1', 'pp-saved__title', 'Saved Dishes'));

  // A stable toast area under the header, outside the redrawn list.
  const toastArea = el('div', 'pp-toast-area');
  toastArea.setAttribute('aria-live', 'polite');
  toastArea.setAttribute('aria-atomic', 'true');

  const notice = el('p', 'pp-saved__notice', SESSION_ONLY_NOTICE);
  notice.setAttribute('role', 'status');
  const content = el('div', 'pp-saved__content');
  // Fixture or other non-published data keeps its visible label here too, as on the menu.
  const dataNotice = menu.notice ? [el('p', 'pp-notice', menu.notice)] : [];
  screen.append(header, ...dataNotice, toastArea, notice, content);
  container.replaceChildren(screen);

  const stopToasts = mountToastArea(toastArea, saveState);
  let stopHearts: (() => void)[] = [];

  function heart(item: SavedItem): HTMLButtonElement {
    const button = el('button', 'pp-saved__save');
    button.type = 'button';
    button.setAttribute(
      'aria-label',
      item.kind === 'complete' ? `Save ${item.dish.name}` : 'Remove this dish from Saved',
    );
    // Figma fi-sr-heart, 24px (Azoz QA report 03, V3), filled because the dish is saved.
    button.innerHTML = SAVED_HEART_ICON;
    stopHearts.push(
      mountSaveHeart(button, { saveState, menu, dish: item.dish, surface: 'saved_screen', send }),
    );
    return button;
  }

  function card(item: SavedItem): HTMLLIElement {
    const row = el('li', 'pp-saved__item');
    row.dataset.dishId = item.dish.dishId;
    if (item.kind === 'incomplete') {
      // Not openable or comparable, and no events; the heart can still remove it.
      const placeholder = el('article', 'pp-card pp-card--placeholder');
      placeholder.append(el('p', 'pp-card__placeholder', PLACEHOLDER_TEXT));
      row.append(placeholder, heart(item));
      return row;
    }
    const { dish } = item;
    const open = el('button', 'pp-saved__open');
    open.type = 'button';
    // A dish without an image gets the menu card's empty image box (DIN-01), so rows line up.
    if (dish.images) {
      const image = el('img', 'pp-saved__image');
      image.src = dish.images.card.url;
      image.alt = dish.images.card.alt;
      image.width = dish.images.card.width;
      image.height = dish.images.card.height;
      open.append(image);
    } else {
      const missing = el('span', 'pp-saved__image pp-card__image--missing');
      missing.setAttribute('aria-hidden', 'true');
      open.append(missing);
    }
    // As Figma's DishCard_Saved (691:7715): category, name, then the price in orange.
    const text = el('span', 'pp-saved__text');
    text.append(
      el('span', 'pp-saved__category', dish.categoryName),
      el('span', 'pp-saved__name', dish.name),
      el('span', 'pp-saved__price', formatPrice(dish.price)),
    );
    open.append(text);
    open.addEventListener('click', () => onOpenDish(dish));
    row.append(open, heart(item));
    return row;
  }

  // Returns how many dishes are shown, so shortlist_viewed reports the list the diner sees.
  function draw(): number {
    const focused = document.activeElement;
    const previousRows = Array.from(content.querySelectorAll<HTMLElement>('.pp-saved__item'));
    const focusedRow = previousRows.findIndex(
      (row) => focused instanceof Node && row.contains(focused),
    );
    for (const stop of stopHearts) stop();
    stopHearts = [];
    notice.hidden = saveState.mode() !== 'session-only';
    const items = savedItems(saveState, menu);
    if (items.length === 0) {
      // Figma Saved_Empty (722:8589): the plate-and-cutlery picture, then the words and the hint.
      const empty = el('div', 'pp-saved__empty');
      // Decoration only: the words below carry the meaning.
      const picture = el('img', 'pp-saved__empty-image');
      picture.src = savedEmptyIcon;
      picture.alt = '';
      picture.width = 120;
      picture.height = 120;
      picture.setAttribute('aria-hidden', 'true');
      const browse = el('button', 'pp-saved__browse', 'Browse menu');
      browse.type = 'button';
      browse.addEventListener('click', onBack);
      empty.append(
        picture,
        el('p', 'pp-saved__empty-text', 'No saved dishes yet'),
        el('p', 'pp-saved__empty-hint', 'Save dishes you like to find them here later.'),
        browse,
      );
      content.replaceChildren(empty);
      if (focusedRow >= 0) browse.focus({ preventScroll: true });
      return 0;
    }
    const list = el('ul', 'pp-saved__list');
    list.append(...items.map(card));
    content.replaceChildren(list);
    if (focusedRow >= 0) {
      const rows = list.querySelectorAll<HTMLElement>('.pp-saved__item');
      rows[Math.min(focusedRow, rows.length - 1)]
        ?.querySelector<HTMLButtonElement>('.pp-saved__save')
        ?.focus({ preventScroll: true });
    }
    return items.length;
  }

  const shown = draw();
  const stop = saveState.subscribe(draw);

  // shortlist_size is the number of dishes drawn, not savedCount(): a saved dish missing from this
  // menu (before reconcile has run) is not shown, so it is not counted.
  // Not counted in session-only mode (confirmed by Adam, matrix v0.1h): unavailable-storage states
  // emit nothing, saves there fire no dish_saved, so a view would describe a list with no matching
  // events and skew the numbers.
  if (recordView && saveState.mode() === 'persistent') {
    try {
      send('shortlist_viewed', shortlistViewedPayload(menu, shown));
    } catch {}
  }

  return () => {
    stop();
    for (const stopHeart of stopHearts) stopHeart();
    stopToasts();
    container.replaceChildren();
  };
}
